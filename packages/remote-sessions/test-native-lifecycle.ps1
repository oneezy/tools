# Exercise the public launcher in separate PowerShell processes with isolated fake CLI data.
param([string]$Script = (Join-Path $PSScriptRoot 'remote-control.ps1'))
$ErrorActionPreference = 'Stop'
$fake = Join-Path $PSScriptRoot 'tests/fake-claude.ps1'
$suite = Join-Path ([IO.Path]::GetTempPath()) ('remote-native-test-' + [guid]::NewGuid().ToString('N'))
$testId = '11111111-2222-4333-8444-555555555555'
$script:passed = 0
$script:failed = @()
function Assert-True($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
function New-Fixture([string]$Name) {
    $base = Join-Path $suite $Name
    $root = Join-Path $base "project root's spaces"
    $config = Join-Path $base 'claude config'
    $tree = Join-Path $root "example/.claude/worktrees/task's worktree"
    $history = Join-Path $config 'projects/saved-worktree'
    New-Item -ItemType Directory -Force $tree,$history | Out-Null
    Set-Content -LiteralPath (Join-Path $tree '.git') -Value 'gitdir: fixture'
    @{type='user';sessionId=$testId;cwd=$tree;timestamp='2026-09-23T12:00:00Z'} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $history "$testId.jsonl")
    $fixture = @{Root=$root;Config=$config;Tree=$tree;State=(Join-Path $root '.remote-sessions.json');Native=(Join-Path $config 'fake-native.json')}
    @{Agents=@();Starts=0;Stops=0;Mode='normal'} | ConvertTo-Json | Set-Content -LiteralPath $fixture.Native
    $fixture
}
function Read-Native($Fixture) { Get-Content -LiteralPath $Fixture.Native -Raw | ConvertFrom-Json -AsHashtable }
function Save-Native($Fixture,$Data) { $Data | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Fixture.Native }
function Invoke-Launcher($Fixture,[string[]]$CliArgs) {
    $lines = @(& pwsh -NoProfile -File $Script @CliArgs -Root $Fixture.Root -ClaudeConfigDirectory $Fixture.Config -ClaudeExecutable $fake -Json 2>&1 | ForEach-Object { [string]$_ })
    @{Code=$LASTEXITCODE;Text=($lines -join "`n")}
}
function Require-Success($Result) { Assert-True ($Result.Code -eq 0) "Expected success, got $($Result.Code): $($Result.Text)" }
function Test-Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; $script:passed++; Write-Host "PASS: $Name" }
    catch { $script:failed += "$Name`: $($_.Exception.Message)"; Write-Host "FAIL: $Name`: $($_.Exception.Message)" }
}
try {
    Test-Case 'exact resume, repeated start, stop, and restart preserve UUID and worktree' {
        $f=New-Fixture lifecycle
        Require-Success (Invoke-Launcher $f @('resume','-Only','example','-SessionId',$testId))
        $native=Read-Native $f
        Assert-True ($native.Starts -eq 1 -and $native.Agents[0].sessionId -eq $testId) 'Initial launch changed conversation identity.'
        Assert-True ($native.LastDirectory -eq $f.Tree) 'Initial launch changed the worktree or broke apostrophe/space handling.'
        Assert-True ('--remote-control' -in $native.LastArguments) 'Resume did not enable the remote bridge.'
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        Assert-True ((Read-Native $f).Starts -eq 1) 'Repeated start launched a duplicate.'
        Require-Success (Invoke-Launcher $f @('stop','-Only','example'))
        Require-Success (Invoke-Launcher $f @('stop','-Only','example'))
        Assert-True ((Read-Native $f).Stops -eq 1) 'Repeated stop called the native stop twice.'
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        $native=Read-Native $f
        Assert-True ($native.Starts -eq 2 -and $native.Agents[0].sessionId -eq $testId -and $native.Agents[0].cwd -eq $f.Tree) 'Restart did not preserve UUID and worktree.'
        Assert-True ($native.Agents.Count -eq 1) 'Restart created a copied conversation.'
        Assert-True (($native.LastArguments -join '|') -eq "--bg|--resume|$testId") 'Restart overrode stored background options and risks copying the conversation.'
    }
    Test-Case 'previously stopped native background session resumes without option overrides' {
        $f=New-Fixture priorbackground
        $native=Read-Native $f
        $native.Agents=@(@{id='11111111';sessionId=$testId;kind='background';state='stopped';cwd=$f.Tree;pid=$null;startedAt='prior-run'})
        Save-Native $f $native
        Require-Success (Invoke-Launcher $f @('resume','-Only','example','-SessionId',$testId))
        $native=Read-Native $f
        Assert-True ($native.Agents.Count -eq 1 -and $native.Agents[0].sessionId -eq $testId) 'Resume copied a pre-existing native background session.'
        Assert-True (($native.LastArguments -join '|') -eq "--bg|--resume|$testId") 'Resume overrode pre-existing background options.'
    }
    Test-Case 'existing interactive session is never adopted or stopped' {
        $f=New-Fixture interactive
        $native=Read-Native $f
        # Native interactive records have pid/status, without background-only id/state.
        $native.Agents=@(
            @{id='aaaaaaaa';sessionId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';kind='background';state='stopped';cwd=$f.Tree;startedAt='prior-run'},
            @{sessionId=$testId;kind='interactive';status='idle';cwd=$f.Tree;pid=7777;startedAt='external';name='Existing interactive session'}
        )
        Save-Native $f $native
        $result=Invoke-Launcher $f @('status','-Only','example')
        Require-Success $result
        $rows=@($result.Text | ConvertFrom-Json)
        Assert-True ($rows.Count -eq 1 -and $rows[0].Running -and $rows[0].State -eq 'idle') 'Interactive session status was not preserved.'
        Assert-True (!$rows[0].Managed -and !$rows[0].AgentId) 'Interactive session received background ownership or an invented stop identifier.'
        Require-Success (Invoke-Launcher $f @('resume','-Only','example','-SessionId',$testId))
        Assert-True (!(Test-Path -LiteralPath $f.State)) 'Interactive session was adopted into managed state.'
        $result=Invoke-Launcher $f @('stop','-Only','example')
        Assert-True ($result.Code -ne 0) 'Stopping an unmanaged session should fail explicitly.'
        Assert-True ((Read-Native $f).Starts -eq 0 -and (Read-Native $f).Stops -eq 0) 'Interactive session was launched or stopped.'
    }
    Test-Case 'another conversation already running in the worktree prevents a duplicate launch' {
        $f=New-Fixture occupied
        $native=Read-Native $f
        $otherId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        $native.Agents=@(@{sessionId=$otherId;kind='interactive';status='idle';cwd=$f.Tree;pid=7777;startedAt='external'})
        Save-Native $f $native
        $result=Invoke-Launcher $f @('resume','-Only','example','-SessionId',$testId)
        Require-Success $result
        $row=@($result.Text | ConvertFrom-Json)[0]
        Assert-True ($row.SessionId -eq $otherId -and $row.Result -match 'already running') 'Occupied worktree was not reported.'
        Assert-True ((Read-Native $f).Starts -eq 0 -and !(Test-Path -LiteralPath $f.State)) 'Occupied worktree was duplicated or adopted.'
    }
    Test-Case 'incomplete native identities fail closed without launching' {
        foreach($kind in @('background','interactive')) {
            $f=New-Fixture "incomplete-$kind"; $native=Read-Native $f
            $native.Agents=@(@{sessionId=$testId;kind=$kind;cwd=$f.Tree;startedAt='external'})
            Save-Native $f $native
            $result=Invoke-Launcher $f @('start','-Only','example')
            Assert-True ($result.Code -ne 0 -and $result.Text -match 'incomplete agent record') "Incomplete $kind identity was accepted."
            Assert-True ((Read-Native $f).Starts -eq 0 -and !(Test-Path -LiteralPath $f.State)) "Incomplete $kind identity mutated launch state."
        }
    }
    Test-Case 'malformed and failed inventories fail closed without launching' {
        foreach($mode in @('malformed','inventory-failure')) {
            $f=New-Fixture $mode; $native=Read-Native $f; $native.Mode=$mode; Save-Native $f $native
            $result=Invoke-Launcher $f @('start','-Only','example')
            Assert-True ($result.Code -ne 0) "$mode inventory was accepted."
            Assert-True ((Read-Native $f).Starts -eq 0 -and !(Test-Path -LiteralPath $f.State)) "$mode inventory mutated launch state."
        }
    }
    Test-Case 'missing and invalid session UUID never create a replacement' {
        $f=New-Fixture missing
        foreach($id in @('not-a-uuid','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')) {
            $result=Invoke-Launcher $f @('resume','-Only','example','-SessionId',$id)
            Assert-True ($result.Code -ne 0) "Missing UUID $id was accepted."
        }
        Assert-True ((Read-Native $f).Starts -eq 0 -and !(Test-Path -LiteralPath $f.State)) 'Missing UUID created launch state.'
    }
    Test-Case 'status and plan preserve state bytes and modification time' {
        $f=New-Fixture readonly
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        $bytes=[IO.File]::ReadAllText($f.State); $stamp=(Get-Item -LiteralPath $f.State).LastWriteTimeUtc.Ticks
        Require-Success (Invoke-Launcher $f @('status','-Only','example'))
        Require-Success (Invoke-Launcher $f @('resume','-Only','example','-SessionId',$testId,'-Plan'))
        Assert-True ([IO.File]::ReadAllText($f.State) -ceq $bytes) 'Read-only operation changed state contents.'
        Assert-True ((Get-Item -LiteralPath $f.State).LastWriteTimeUtc.Ticks -eq $stamp) 'Read-only operation rewrote state.'
        Assert-True ((Read-Native $f).Starts -eq 1 -and (Read-Native $f).Stops -eq 0) 'Read-only operation started or stopped a session.'
    }
    Test-Case 'missing transcript does not hide a still-running managed session' {
        $f=New-Fixture missinghistory
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        $history=Join-Path $f.Config "projects/saved-worktree/$testId.jsonl"
        Rename-Item -LiteralPath $history -NewName "$testId.parked"
        $result=Invoke-Launcher $f @('status','-Only','example')
        Require-Success $result
        $rows=@($result.Text | ConvertFrom-Json)
        Assert-True ($rows.Count -eq 1 -and $rows[0].SessionId -eq $testId) 'Missing history concealed the saved managed identity.'
        Assert-True ($rows[0].Running -and $rows[0].Managed) 'Status falsely reported the native session stopped or unowned after history disappeared.'
        Assert-True (!$rows[0].Available) 'Status advertised an unavailable transcript as resumable.'
        Assert-True ((Read-Native $f).Stops -eq 0) 'Status stopped the still-running session.'
    }
    Test-Case 'failed or mismatched launches retain pending ownership and cannot be stopped' {
        foreach($mode in @('launch-failure','wrong-directory')) {
            $f=New-Fixture $mode; $native=Read-Native $f; $native.Mode=$mode; Save-Native $f $native
            $result=Invoke-Launcher $f @('start','-Only','example')
            Assert-True ($result.Code -ne 0) "$mode launch was reported successful."
            $state=Get-Content -LiteralPath $f.State -Raw | ConvertFrom-Json -AsHashtable
            Assert-True ($state.Sessions[$testId].Ownership -eq 'pending') "$mode launch claimed confirmed ownership."
            $result=Invoke-Launcher $f @('stop','-Only','example')
            Assert-True ($result.Code -ne 0 -and (Read-Native $f).Stops -eq 0) "$mode launch allowed stop without confirmed ownership."
        }
    }
    Test-Case 'replaced native run and ineffective native stop are reported safely' {
        $f=New-Fixture replaced
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        $native=Read-Native $f; $native.Agents[0].startedAt='someone-elses-run'; Save-Native $f $native
        $result=Invoke-Launcher $f @('stop','-Only','example')
        Assert-True ($result.Code -ne 0 -and (Read-Native $f).Stops -eq 0) 'Stop terminated a replacement run.'
        $f=New-Fixture stopfailure
        Require-Success (Invoke-Launcher $f @('start','-Only','example'))
        $native=Read-Native $f; $native.Mode='stop-no-effect'; Save-Native $f $native
        $result=Invoke-Launcher $f @('stop','-Only','example')
        Assert-True ($result.Code -ne 0) 'Ineffective native stop was reported successful.'
    }
    if($script:failed.Count) { throw "$($script:failed.Count) failed, $script:passed passed.`n$($script:failed -join "`n")" }
    Write-Host "All $script:passed native lifecycle tests passed. No real Claude process was started or stopped."
} finally {
    $absolute=[IO.Path]::GetFullPath($suite)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if($absolute.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'remote-native-test-*') {
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}
