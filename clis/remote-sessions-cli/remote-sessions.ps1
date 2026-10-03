#requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('menu','sessions','start','resume','stop','status')][string]$Action = 'menu',
    [string]$Root = 'V:\dev', [string[]]$Only = @(), [string]$SessionId,
    [switch]$Plan, [switch]$Json, [switch]$IncludeProjectSessions,
    [string]$ClaudeConfigDirectory = $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }),
    [string]$ClaudeExecutable = 'claude.exe'
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
$ClaudeConfigDirectory = [IO.Path]::GetFullPath($ClaudeConfigDirectory)
$StateFile = Join-Path $Root '.remote-sessions.json'

function Normalize-Path([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\','/') }
function Same-Path([string]$A, [string]$B) { (Normalize-Path $A) -ieq (Normalize-Path $B) }
function Get-Projects {
    $projects = @(Get-ChildItem -LiteralPath $Root -Directory | Where-Object Name -NotMatch '^[._]' | Sort-Object Name)
    if ($Only.Count) {
        $names = @($Only | ForEach-Object { $_ -split ',' } | ForEach-Object Trim | Where-Object { $_ })
        foreach ($name in $names) { if ($name -notin $projects.Name) { throw "Unknown project '$name' in $Root." } }
        $projects = @($projects | Where-Object Name -In $names)
    }
    $projects
}
function Read-State {
    if (!(Test-Path -LiteralPath $StateFile)) { return @{ Version=2; Sessions=@{} } }
    $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json -AsHashtable
    if ($state.Version -ne 2 -or $state.Sessions -isnot [System.Collections.IDictionary]) { throw "Unrecognized state format: $StateFile" }
    $state
}
function Write-State($State) {
    $temp = "$StateFile.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temp, ($State | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        [IO.File]::Move($temp, $StateFile, $true)
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp } }
}
function Invoke-Claude([string[]]$Arguments, [string]$Directory = $Root) {
    $before = $env:CLAUDE_CONFIG_DIR
    Push-Location -LiteralPath $Directory
    try {
        # Explicitly setting the default directory changes Claude's legacy config lookup.
        if ($before -or !(Same-Path $ClaudeConfigDirectory (Join-Path $env:USERPROFILE '.claude'))) { $env:CLAUDE_CONFIG_DIR = $ClaudeConfigDirectory }
        $output = @(& $ClaudeExecutable @Arguments 2>&1 | ForEach-Object { [string]$_ })
        if ($LASTEXITCODE -ne 0) { throw "Claude exited $LASTEXITCODE. $($output -join ' ')" }
        $output -join "`n"
    } finally { $env:CLAUDE_CONFIG_DIR = $before; Pop-Location }
}
function Get-Agents {
    $text = Invoke-Claude @('agents','--json','--all')
    try { $items = ConvertFrom-Json -InputObject $text -NoEnumerate } catch { throw "Claude returned invalid agent inventory JSON: $($_.Exception.Message)" }
    if ($items -isnot [array]) { throw 'Claude returned an unexpected agent inventory format.' }
    foreach ($item in $items) {
        if (!$item.sessionId -or !$item.id -or !$item.cwd) { throw 'Claude returned an incomplete agent record.' }
        $item
    }
}
function Is-Active($Agent) { $null -ne $Agent -and $Agent.state -notin @('stopped','completed','failed','exited','done') -and $Agent.pid }
function Get-SavedSessions($Projects) {
    $catalog = @{}
    $history = Join-Path $ClaudeConfigDirectory 'projects'
    if (!(Test-Path -LiteralPath $history)) { return }
    $directories = @(Get-ChildItem -LiteralPath $history -Directory)
    $prefixes = @($Projects | ForEach-Object { [regex]::Escape(($_.FullName -replace '[^a-zA-Z0-9]', '-')) })
    $pattern = '^(' + ($prefixes -join '|') + ')' + $(if($IncludeProjectSessions){'($|--claude-worktrees-)'}else{'--claude-worktrees-'})
    $candidates = @($directories | Where-Object Name -Match $pattern)
    # Custom config stores can use different directory keys. The record cwd remains authoritative.
    if (!$candidates.Count) { $candidates = $directories }
    foreach ($dir in $candidates) {
        foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -Filter '*.jsonl' -File) {
            $uuid = [guid]::Empty
            if (![guid]::TryParseExact($file.BaseName, 'D', [ref]$uuid)) { continue }
            $cwd = $null; $conflict = $false; $timestamp = $file.LastWriteTimeUtc.ToString('o')
            # Read metadata at both ends; never return conversation content.
            $fileLines=[IO.File]::ReadAllLines($file.FullName)
            $lines = @($fileLines | Select-Object -First 32) + @($fileLines | Select-Object -Last 16)
            foreach ($line in $lines) {
                $document=$null
                try {
                    $document=[System.Text.Json.JsonDocument]::Parse([string]$line)
                    $record=$document.RootElement; $field=[System.Text.Json.JsonElement]::new()
                    if ($record.TryGetProperty('isSidechain',[ref]$field) -and $field.ValueKind -eq 'True') { continue }
                    if ($record.TryGetProperty('sessionId',[ref]$field) -and $field.GetString() -ne $file.BaseName) { $conflict=$true; break }
                    if ($record.TryGetProperty('cwd',[ref]$field) -and $field.ValueKind -eq 'String') {
                        $candidate=Normalize-Path $field.GetString()
                        if ($cwd -and !(Same-Path $cwd $candidate)) { $conflict=$true; break }
                        $cwd=$candidate
                    }
                    if ($record.TryGetProperty('type',[ref]$field) -and $field.GetString() -eq 'user' -and $record.TryGetProperty('timestamp',[ref]$field)) { $timestamp=$field.GetString() }
                } catch { continue } finally { if($document){$document.Dispose()} }
            }
            if (!$cwd) { continue }
            foreach ($project in $Projects) {
                $prefix = (Join-Path $project.FullName '.claude\worktrees') + '\'
                $inWorktree = $cwd.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
                if (!$inWorktree -and !($IncludeProjectSessions -and (Same-Path $cwd $project.FullName))) { continue }
                $reason=$null
                if($conflict){$reason='history has conflicting session or folder metadata'}
                elseif(!(Test-Path -LiteralPath $cwd -PathType Container)){$reason='history saved; working folder missing'}
                elseif($inWorktree -and !(Test-Path -LiteralPath (Join-Path $cwd '.git'))){$reason='history saved; worktree checkout missing'}
                $entry = [pscustomobject]@{ SessionId=$file.BaseName; Project=$project.Name; WorkingDirectory=$cwd; Updated=$timestamp; Worktree=$inWorktree; Available=(!$reason); UnavailableReason=$reason }
                if ($catalog.ContainsKey($file.BaseName) -and !(Same-Path $catalog[$file.BaseName].WorkingDirectory $cwd)) { throw "Conflicting saved locations for session $($file.BaseName)." }
                $catalog[$file.BaseName]=$entry
            }
        }
    }
    $catalog.Values | Sort-Object Updated -Descending
}
function Get-Selection($Projects, $Saved, $State) {
    if ($SessionId) {
        $matched = @($Saved | Where-Object SessionId -EQ $SessionId)
        if ($matched.Count -ne 1) { throw "Saved session '$SessionId' was not found in the selected projects and existing worktrees. No replacement will be created." }
        if(!$matched[0].Available){throw "Cannot resume $SessionId. $($matched[0].UnavailableReason). Existing files were left intact."}
        return $matched
    }
    if ($Action -eq 'resume') { throw 'Resume requires -SessionId with the full saved conversation UUID.' }
    foreach ($project in $Projects) {
        $managed = @($State.Sessions.GetEnumerator() | Where-Object { $_.Value.Project -eq $project.Name })
        if ($managed.Count) {
            foreach ($m in $managed) {
                $match = @($Saved | Where-Object SessionId -EQ $m.Key)
                if ($match.Count -ne 1) { throw "Managed session $($m.Key) has no saved transcript/worktree. No replacement was created." }
                if(!$match[0].Available){throw "Cannot resume $($m.Key). $($match[0].UnavailableReason)."}
                $match[0]
            }
        } else {
            $available=@($Saved | Where-Object { $_.Project -eq $project.Name -and $_.Worktree -and $_.Available })
            if(!$available.Count){throw "No available saved worktree conversations for $($project.Name). Use sessions to inspect saved history; no replacement was created."}
            $available | Group-Object WorkingDirectory | ForEach-Object {
                $_.Group | Sort-Object Updated -Descending | Select-Object -First 1
            }
        }
    }
}
function Get-ResumePlan($SavedSession, [bool]$ExistingBackground = $false) {
    $arguments=@('--bg','--resume',$SavedSession.SessionId)
    if(!$ExistingBackground){$arguments+=@('--remote-control',"$($SavedSession.Project) $($SavedSession.SessionId.Substring(0,8))")}
    [pscustomobject]@{
        SessionId=$SavedSession.SessionId; Project=$SavedSession.Project; WorkingDirectory=$SavedSession.WorkingDirectory
        Executable=$ClaudeExecutable; Arguments=$arguments; PreserveSavedOptions=$ExistingBackground
    }
}
function Get-Bridge($Agent) {
    if (!(Is-Active $Agent)) { return $null }
    $file=Join-Path $ClaudeConfigDirectory "sessions\$($Agent.pid).json"
    if (!(Test-Path -LiteralPath $file)) { return $null }
    try { $bridge=Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } catch { return $null }
    if ($bridge.pid -eq $Agent.pid -and $bridge.sessionId -eq $Agent.sessionId -and $bridge.bridgeSessionId) { return $bridge.bridgeSessionId }
    $null
}
function Get-Status($Saved, $State, $Agents) {
    foreach ($s in $Saved) {
        $agent=@($Agents | Where-Object sessionId -EQ $s.SessionId | Where-Object { Is-Active $_ }) | Select-Object -First 1
        $owned=$State.Sessions.ContainsKey($s.SessionId) -and $State.Sessions[$s.SessionId].Ownership -eq 'confirmed'
        if($owned -and $agent){$owned=$agent.kind -eq 'background' -and (Same-Path $agent.cwd $State.Sessions[$s.SessionId].WorkingDirectory) -and $agent.startedAt -eq $State.Sessions[$s.SessionId].StartedAt}
        $bridge=Get-Bridge $agent
        [pscustomobject]@{Project=$s.Project;SessionId=$s.SessionId;WorkingDirectory=$s.WorkingDirectory;Updated=$s.Updated;Available=$s.Available;Managed=$owned;Running=[bool](Is-Active $agent);State=$(if($agent){$agent.state}elseif(!$s.Available){$s.UnavailableReason}else{'stopped'});RemoteRegistered=[bool]$bridge;RemoteSessionId=$bridge;AgentId=$agent.id}
    }
    foreach ($id in $State.Sessions.Keys) {
        if ($id -in $Saved.SessionId) { continue }
        $s=$State.Sessions[$id]
        if ($s.Project -notin (Get-Projects).Name) { continue }
        $agent=@($Agents | Where-Object sessionId -EQ $id | Where-Object { Is-Active $_ }) | Select-Object -First 1
        $owned=$s.Ownership -eq 'confirmed'
        if($owned -and $agent){$owned=$agent.kind -eq 'background' -and (Same-Path $agent.cwd $s.WorkingDirectory) -and $agent.startedAt -eq $s.StartedAt}
        $bridge=Get-Bridge $agent
        [pscustomobject]@{Project=$s.Project;SessionId=$id;WorkingDirectory=$s.WorkingDirectory;Updated=$null;Available=$false;Managed=$owned;Running=[bool](Is-Active $agent);State='saved worktree or transcript missing';RemoteRegistered=[bool]$bridge;RemoteSessionId=$bridge;AgentId=$agent.id}
    }
}
function Start-Saved($Selection, $State) {
    foreach ($s in $Selection) {
        $agents=@(Get-Agents)
        $active=@($agents | Where-Object sessionId -EQ $s.SessionId | Where-Object { Is-Active $_ })
        if ($active.Count) {
            [pscustomobject]@{SessionId=$s.SessionId;Project=$s.Project;Result='already running; not restarted or adopted'}
            continue
        }
        $State.Sessions[$s.SessionId]=@{Project=$s.Project;WorkingDirectory=$s.WorkingDirectory;Ownership='pending';Updated=[DateTime]::UtcNow.ToString('o')}
        Write-State $State
        $existing=@($agents | Where-Object { $_.sessionId -eq $s.SessionId -and $_.kind -eq 'background' }).Count -gt 0
        $plan=Get-ResumePlan $s $existing
        $output=Invoke-Claude $plan.Arguments $plan.WorkingDirectory
        $agent=$null
        for($attempt=0;$attempt -lt 10;$attempt++) {
            $agent=@(Get-Agents | Where-Object sessionId -EQ $s.SessionId | Where-Object { Is-Active $_ }) | Select-Object -First 1
            if ($agent) { break }
            Start-Sleep -Milliseconds 500
        }
        if (!$agent -or $agent.kind -ne 'background' -or !(Same-Path $agent.cwd $s.WorkingDirectory) -or $output -match '(?im)^\s*note:.*(copy|copied)') {
            throw "Claude did not confirm exact resume of $($s.SessionId). Ownership is pending; inspect claude agents. $output"
        }
        $State.Sessions[$s.SessionId].Ownership='confirmed'
        $State.Sessions[$s.SessionId].StartedAt=$agent.startedAt
        Write-State $State
        [pscustomobject]@{SessionId=$s.SessionId;Project=$s.Project;Result='resumed original conversation and worktree'}
    }
}
function Stop-Saved($Projects, $State) {
    $selected=@($State.Sessions.GetEnumerator() | Where-Object { $_.Value.Project -in $Projects.Name -and (!$SessionId -or $_.Key -eq $SessionId) })
    if (!$selected.Count) { throw 'No matching managed sessions. Nothing was stopped.' }
    foreach ($s in $selected) {
        if ($s.Value.Ownership -ne 'confirmed') { throw "Session $($s.Key) has uncertain ownership; inspect it before stopping." }
        $agents=@(Get-Agents)
        $agent=@($agents | Where-Object sessionId -EQ $s.Key | Where-Object { Is-Active $_ })
        if (!$agent.Count) { [pscustomobject]@{SessionId=$s.Key;Project=$s.Value.Project;Result='already stopped; history retained'}; continue }
        if ($agent.Count -ne 1 -or $agent[0].kind -ne 'background' -or !(Same-Path $agent[0].cwd $s.Value.WorkingDirectory) -or $agent[0].startedAt -ne $s.Value.StartedAt) {
            throw "Session $($s.Key) is now owned by another run; nothing was stopped."
        }
        if (@($agents | Where-Object id -EQ $agent[0].id).Count -ne 1) { throw 'Ambiguous native agent identifier; nothing was stopped.' }
        $null=Invoke-Claude @('stop',$agent[0].id)
        $remaining=@(Get-Agents | Where-Object sessionId -EQ $s.Key | Where-Object { Is-Active $_ })
        if ($remaining.Count) { throw "Claude still reports $($s.Key) active after stop." }
        [pscustomobject]@{SessionId=$s.Key;Project=$s.Value.Project;Result='stopped; conversation and worktree retained'}
    }
}
function Show-Result($Rows) {
    if ($Json) { ConvertTo-Json -InputObject @($Rows) -Depth 7; return }
    if (!@($Rows).Count) { Write-Host 'No saved sessions found in the selected existing worktrees.'; return }
    $Rows | Format-Table Project,SessionId,Running,RemoteRegistered,State,Result,WorkingDirectory -AutoSize -Wrap
}
function Show-Menu {
    $cursor=0; $checked=@{}; $message=''
    while($true) {
        $projects=@(Get-Projects); $saved=@(Get-SavedSessions $projects)
        $rows=@(Get-Status $saved (Read-State) @(Get-Agents))
        Clear-Host
        Write-Host 'Claude Code CLI | saved conversations on this Windows PC' -ForegroundColor Cyan
        Write-Host 'Enter resumes checked conversations in their existing worktrees. X stops managed sessions.'
        Write-Host 'Space select | A all/none | R refresh | Q quit. Closing the picker leaves sessions running.'
        Write-Host 'Remote registered means a bridge exists, not that phone delivery was tested.'
        if(!$rows.Count){ Write-Host 'No saved worktree conversations found.'; return }
        $cursor=[Math]::Min($cursor,$rows.Count-1)
        for($i=0;$i -lt $rows.Count;$i++) {
            $r=$rows[$i]; $mark=if($checked[$r.SessionId]){'x'}else{' '}; $pointer=if($i -eq $cursor){'>'}else{' '}
            $state=if($r.Running){if($r.RemoteRegistered){'running / remote registered'}else{'running / bridge not confirmed'}}else{$r.State}
            Write-Host "$pointer [$mark] $($r.Project)  $($r.SessionId.Substring(0,8))  $state"
        }
        Write-Host "`n$($rows[$cursor].WorkingDirectory)"
        if($message){Write-Host $message -ForegroundColor Yellow}
        $key=[Console]::ReadKey($true).Key
        switch($key) {
            'UpArrow' {$cursor=($cursor-1+$rows.Count)%$rows.Count}
            'DownArrow' {$cursor=($cursor+1)%$rows.Count}
            'Spacebar' {if($rows[$cursor].Available -or $rows[$cursor].Managed){$id=$rows[$cursor].SessionId; $checked[$id]=!$checked[$id]}else{$message='This history is preserved, but its worktree must be recovered before resuming.'}}
            'A' {$eligible=@($rows | Where-Object Available); $set=@($eligible | Where-Object {!$checked[$_.SessionId]}).Count -gt 0; foreach($r in $rows){$checked[$r.SessionId]=$set -and $r.Available}}
            'Enter' {
                $message=''
                foreach($r in @($rows | Where-Object {$checked[$_.SessionId]})) {
                    if(!$r.Available){$message+="$($r.Project): saved worktree unavailable; skipped. ";continue}
                    try { $out=& $PSCommandPath resume -Root $Root -Only $r.Project -SessionId $r.SessionId -IncludeProjectSessions:$IncludeProjectSessions -ClaudeConfigDirectory $ClaudeConfigDirectory -ClaudeExecutable $ClaudeExecutable -Json; $message+="$($r.Project): $((($out -join "`n") | ConvertFrom-Json).Result) " } catch {$message=$_.Exception.Message;break}
                }
            }
            'X' {
                $message=''
                foreach($r in @($rows | Where-Object {$checked[$_.SessionId]})) {
                    try { $out=& $PSCommandPath stop -Root $Root -Only $r.Project -SessionId $r.SessionId -ClaudeConfigDirectory $ClaudeConfigDirectory -ClaudeExecutable $ClaudeExecutable -Json; $message+="$($r.Project): $((($out -join "`n") | ConvertFrom-Json).Result) " } catch {$message=$_.Exception.Message;break}
                }
            }
            'Q' {return}
            'Escape' {return}
        }
    }
}
$mutex=$null; $locked=$false
try {
    if($Action -eq 'menu'){Show-Menu;return}
    $projects=@(Get-Projects)
    if($Action -in @('start','resume','stop') -and !$Only.Count){throw 'Choose projects explicitly with -Only. Use the picker for a visible selection.'}
    if($Action -in @('start','resume','stop') -and !$Plan){
        $hash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant())))
        $mutex=[Threading.Mutex]::new($false,"Local\ClaudeRemoteSessions-$hash")
        try {$locked=$mutex.WaitOne(30000)} catch [Threading.AbandonedMutexException] {$locked=$true}
        if(!$locked){throw 'Another launcher action is still running. Try again shortly.'}
    }
    $state=Read-State
    if($Action -eq 'stop'){
        if($Plan){Show-Result @($state.Sessions.GetEnumerator() | Where-Object {$_.Value.Project -in $projects.Name -and (!$SessionId -or $_.Key -eq $SessionId)} | ForEach-Object {[pscustomobject]@{Project=$_.Value.Project;SessionId=$_.Key;WorkingDirectory=$_.Value.WorkingDirectory;Result='stop managed session; keep history'}})}
        else{Show-Result @(Stop-Saved $projects $state)}
        return
    }
    $saved=@(Get-SavedSessions $projects)
    switch($Action){
        'sessions' {if($Json){ConvertTo-Json -InputObject $saved -Depth 5}else{$saved | Format-Table Project,SessionId,Available,UnavailableReason,WorkingDirectory -AutoSize -Wrap}}
        'status' {Show-Result @(Get-Status $saved $state @(Get-Agents))}
        default {
            $selection=@(Get-Selection $projects $saved $state)
            if(!$selection.Count){throw 'No saved worktree conversations to resume. Create a task in a worktree from dev first; no new conversation was silently created.'}
            if($Plan){$inventory=@(Get-Agents); $plans=@($selection | ForEach-Object {$s=$_; Get-ResumePlan $s (@($inventory | Where-Object {$_.sessionId -eq $s.SessionId -and $_.kind -eq 'background'}).Count -gt 0)}); if($Json){ConvertTo-Json -InputObject $plans -Depth 5}else{$plans | Format-List}}
            else{Show-Result @(Start-Saved $selection $state)}
        }
    }
} finally {
    if($locked){$mutex.ReleaseMutex()}
    if($mutex){$mutex.Dispose()}
}
