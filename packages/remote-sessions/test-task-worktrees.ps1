# Public launcher tests with real disposable Git repos and a fake Claude CLI.
param([string]$Script=(Join-Path $PSScriptRoot 'remote-control.ps1'),[string]$Filter='*')
$ErrorActionPreference='Stop'
$suite=Join-Path ([IO.Path]::GetTempPath()) ('remote-worktree-test-'+[guid]::NewGuid().ToString('N'))
$fake=Join-Path $PSScriptRoot 'tests/fake-claude.ps1'
$passed=0; $failures=@()
function Assert($Condition,[string]$Message){if(!$Condition){throw $Message}}
function Git($Directory,[string[]]$Arguments){
    Assert ([IO.Path]::GetFullPath($Directory).StartsWith($suite+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) 'Test Git path escaped fixture.'
    $result=@(& git.exe -C $Directory @Arguments 2>&1 | ForEach-Object {[string]$_})
    if($LASTEXITCODE -ne 0){throw ($result -join "`n")}; $result -join "`n"
}
function Fixture($Name,[string]$Origin){
    $root=Join-Path $suite "$Name/project root's spaces"; $project=Join-Path $root 'example'; $config=Join-Path $suite "$Name/config"
    New-Item -ItemType Directory -Force $project,$config | Out-Null
    if($Origin){$null=Git $root @('clone',$Origin,$project)}else{$null=Git $project @('init','-b','dev')}
    $null=Git $project @('config','user.name','Fixture'); $null=Git $project @('config','user.email','fixture@example.invalid')
    if(!$Origin){
        Set-Content -LiteralPath (Join-Path $project 'tracked.txt') 'baseline'
        Set-Content -LiteralPath (Join-Path $project '.gitignore') '.claude/worktrees/'
        $null=Git $project @('add','.'); $null=Git $project @('commit','-m','fixture')
    }
    @{Agents=@();Starts=0;Stops=0;Mode='normal'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'fake-native.json')
    @{Root=$root;Project=$project;Config=$config;State=(Join-Path $root '.remote-sessions.json');Native=(Join-Path $config 'fake-native.json')}
}
function Run($Fixture,[string[]]$Arguments){
    $text=@(& pwsh -NoProfile -File $Script @Arguments -Root $Fixture.Root -Only example -ClaudeConfigDirectory $Fixture.Config -ClaudeExecutable $fake -Json 2>&1 | ForEach-Object {[string]$_})
    if($LASTEXITCODE -ne 0){throw ($text -join "`n")}
    ($text -join "`n") | ConvertFrom-Json
}
function Native($Fixture){Get-Content -LiteralPath $Fixture.Native -Raw | ConvertFrom-Json -AsHashtable}
function State($Fixture){Get-Content -LiteralPath $Fixture.State -Raw | ConvertFrom-Json -AsHashtable}
function Case($Name,[scriptblock]$Body){
    if($Name -notlike $Filter){return}
    try{& $Body; $script:passed++; Write-Host "PASS: $Name"}catch{$script:failures+="$Name`: $($_.Exception.Message)"; Write-Host "FAIL: $($script:failures[-1])"}
}
try {
    Case 'new project creates once from dev; restarts retain conversation, worktree, and dirty checkout' {
        $f=Fixture first
        Set-Content -LiteralPath (Join-Path $f.Project 'tracked.txt') 'uncommitted work'
        $refs=Git $f.Project @('show-ref'); $plan=@(Run $f @('start','-Task','first-task','-Plan'))[0]
        Assert ($plan.Mode -eq 'new' -and $plan.Workspace.Base -eq 'dev') 'First launch did not plan a worktree from dev.'
        Assert (!(Test-Path $f.State) -and !(Test-Path $plan.WorkingDirectory) -and (Git $f.Project @('show-ref')) -eq $refs) 'Preview mutated Git or state.'
        $first=@(Run $f @('start','-Task','first-task'))[0]
        Assert ((Git $first.WorkingDirectory @('rev-parse','HEAD')) -eq (Git $f.Project @('rev-parse','dev'))) 'New worktree did not start at dev.'
        Assert ((Get-Content -LiteralPath (Join-Path $f.Project 'tracked.txt') -Raw).Trim() -eq 'uncommitted work') 'Launch altered dirty project files.'
        Assert ((State $f).Sessions[$first.SessionId].Branch -eq $first.Branch) 'Task branch was not remembered.'
        $null=Run $f @('start'); Assert ((Native $f).Starts -eq 1) 'Repeated start made another session.'
        $null=Run $f @('stop'); $again=@(Run $f @('start'))[0]
        Assert ($again.SessionId -eq $first.SessionId -and $again.WorkingDirectory -eq $first.WorkingDirectory) 'Restart abandoned the task.'
        Assert ((Native $f).LastArguments -contains '--resume') 'Restart did not use resume.'
        Assert (Test-Path -LiteralPath $first.WorkingDirectory) 'Stop removed the worktree.'
    }
    Case 'named tasks get separate branches and worktrees, and repeated names reuse them' {
        $f=Fixture parallel
        $a=@(Run $f @('start','-Task','ticket-41'))[0]; $b=@(Run $f @('start','-Task','ticket-42'))[0]
        Assert ($a.Branch -ne $b.Branch -and $a.WorkingDirectory -ne $b.WorkingDirectory -and $a.SessionId -ne $b.SessionId) 'Parallel tasks share a branch, folder, or session.'
        $again=@(Run $f @('start','-Task','ticket-41'))[0]
        Assert ($again.SessionId -eq $a.SessionId -and (Native $f).Starts -eq 2) 'Named task was duplicated.'
    }
    Case 'deleted worktree restores its retained branch and original conversation' {
        $f=Fixture restore; $first=@(Run $f @('start','-Task','ticket-43'))[0]
        $null=Run $f @('stop')
        $null=Git $f.Project @('worktree','remove',$first.WorkingDirectory)
        $again=@(Run $f @('start','-Task','ticket-43'))[0]
        Assert ($again.SessionId -eq $first.SessionId -and $again.Branch -eq $first.Branch -and $again.WorkingDirectory -eq $first.WorkingDirectory) 'Recovery failed to restore the original task in place.'
        Assert (Test-Path -LiteralPath (Join-Path $again.WorkingDirectory '.git')) 'Recovery did not recreate the checkout.'
    }
    Case 'stale registered worktree gets one replacement while old files, branch, and history remain' {
        $f=Fixture stale; $first=@(Run $f @('start','-Task','ticket-44'))[0]; $null=Run $f @('stop')
        $parked=$first.WorkingDirectory+'-parked'
        Assert ([IO.Path]::GetFullPath($parked).StartsWith($suite+[IO.Path]::DirectorySeparatorChar)) 'Move escaped fixture.'
        Move-Item -LiteralPath $first.WorkingDirectory -Destination $parked
        $replacement=@(Run $f @('start','-Task','ticket-44'))[0]
        Assert ($replacement.SessionId -ne $first.SessionId -and $replacement.Branch -ne $first.Branch) 'Missing registered worktree did not get a fresh task.'
        Assert ((State $f).Sessions[$first.SessionId].ReplacedBy -eq $replacement.SessionId) 'Replacement link was not saved.'
        Assert (Test-Path -LiteralPath $parked) 'Recovery deleted old files.'
        $null=Git $f.Project @('show-ref','--verify',"refs/heads/$($first.Branch)")
        Assert (Test-Path -LiteralPath (Join-Path $f.Config "projects/new-task/$($first.SessionId).jsonl")) 'Recovery removed conversation history.'
        $again=@(Run $f @('resume','-SessionId',$first.SessionId))[0]
        Assert ($again.SessionId -eq $replacement.SessionId -and (Native $f).Starts -eq 2) 'Old identity created another replacement.'
    }
    Case 'existing feature branch is checked out without changing its commits' {
        $f=Fixture branch; $null=Git $f.Project @('branch','feature/existing')
        $first=@(Run $f @('start','-Task','ticket-45','-Branch','feature/existing'))[0]
        Assert ($first.Branch -eq 'feature/existing') 'Existing branch was replaced.'
        $again=@(Run $f @('start','-Branch','feature/existing'))[0]
        Assert ($again.SessionId -eq $first.SessionId -and (Native $f).Starts -eq 1) 'Existing branch started a duplicate task.'
        $named=@(Run $f @('start','-Task','ticket-45'))[0]
        Assert ($named.SessionId -eq $first.SessionId -and (Native $f).Starts -eq 1) 'Branch lookup forgot the original task name.'
        $rejected=$false; try{$null=Run $f @('start','-Task','ticket-45','-Branch','feature/different')}catch{$rejected=$_.Exception.Message -match 'already uses'}
        Assert $rejected 'A named task silently switched to a different requested branch.'
    }
    Case 'failed launch preserves the created worktree and retries in the same folder' {
        $f=Fixture retry; $native=Native $f; $native.Mode='launch-failure'; $native | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $f.Native
        $failed=$false; try{$null=Run $f @('start','-Task','ticket-46')}catch{$failed=$true}
        Assert $failed 'Expected fake launch failure.'
        $entry=@((State $f).Sessions.Values)[0]; $folder=$entry.WorkingDirectory
        Assert (Test-Path -LiteralPath $folder) 'Failed launch removed its worktree.'
        $native=Native $f; $native.Mode='normal'; $native | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $f.Native
        $retry=@(Run $f @('start','-Task','ticket-46'))[0]
        Assert ($retry.WorkingDirectory -eq $folder) 'Retry created another worktree.'
    }
    Case 'uncertain launch is rediscovered without duplicate sessions or stop ownership' {
        $f=Fixture uncertain; $native=Native $f; $native.Mode='launch-exit-failure'
        $native | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $f.Native
        $failed=$false; try{$null=Run $f @('start','-Task','ticket-uncertain')}catch{$failed=$true}
        Assert $failed 'Expected launch confirmation failure.'
        $found=@(Run $f @('start','-Task','ticket-uncertain'))[0]
        $again=@(Run $f @('start','-Task','ticket-uncertain'))[0]
        Assert ($found.SessionId -eq $again.SessionId -and (Native $f).Starts -eq 1) 'Uncertain launch was duplicated.'
        Assert ((State $f).Sessions[$found.SessionId].Ownership -eq 'unmanaged') 'Uncertain launch acquired stop ownership.'
    }
    Case 'origin is fetched, dev fast-forwards, and existing remote feature branches retain their commits' {
        $origin=Fixture upstream; $f=Fixture clone $origin.Project
        Set-Content -LiteralPath (Join-Path $origin.Project 'tracked.txt') 'upstream change'
        $null=Git $origin.Project @('commit','-am','advance dev')
        $null=Git $origin.Project @('branch','feature/remote')
        $first=@(Run $f @('start','-Task','updated-dev'))[0]
        $expected=Git $origin.Project @('rev-parse','dev')
        Assert ((Git $f.Project @('rev-parse','dev')) -eq $expected -and (Git $first.WorkingDirectory @('rev-parse','HEAD')) -eq $expected) 'New task did not use updated dev.'
        $remote=@(Run $f @('start','-Task','remote-ticket','-Branch','feature/remote'))[0]
        Assert ($remote.Branch -eq 'feature/remote' -and (Git $remote.WorkingDirectory @('rev-parse','HEAD')) -eq $expected) 'Remote branch was not checked out at its existing commit.'
        Set-Content -LiteralPath (Join-Path $origin.Project 'tracked.txt') 'another upstream change'
        $null=Git $origin.Project @('commit','-am','advance dev again')
        Set-Content -LiteralPath (Join-Path $f.Project 'tracked.txt') 'dirty local work'
        $failed=$false; try{$null=Run $f @('start','-Task','dirty-dev')}catch{$failed=$_.Exception.Message -match 'uncommitted changes'}
        Assert $failed 'A dirty dev checkout was silently changed during fast-forward.'
        Assert ((Get-Content -LiteralPath (Join-Path $f.Project 'tracked.txt') -Raw).Trim() -eq 'dirty local work') 'Dirty dev work was overwritten.'
    }
    Case 'new repository can bootstrap dev without changing main' {
        $f=Fixture bootstrap; $null=Git $f.Project @('branch','-m','main')
        $main=Git $f.Project @('rev-parse','main')
        $row=@(Run $f @('start','-Task','first-task'))[0]
        Assert ((Git $f.Project @('branch','--show-current')) -eq 'main' -and (Git $f.Project @('rev-parse','main')) -eq $main) 'Bootstrap changed main.'
        Assert ((Git $f.Project @('rev-parse','dev')) -eq $main -and (Git $row.WorkingDirectory @('rev-parse','HEAD')) -eq $main) 'Bootstrap failed to cut the task from dev.'
    }
    Case 'a missing task branch gets a remembered replacement rather than blocking' {
        $f=Fixture gone; $first=@(Run $f @('start','-Task','ticket-gone'))[0]; $null=Run $f @('stop')
        $null=Git $f.Project @('worktree','remove',$first.WorkingDirectory)
        $state=State $f; $state.Sessions[$first.SessionId].Branch='codex/branch-no-longer-present'
        $state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $f.State
        $replacement=@(Run $f @('start','-Task','ticket-gone'))[0]
        Assert ($replacement.SessionId -ne $first.SessionId -and (Test-Path $replacement.WorkingDirectory)) 'Missing branch prevented replacement.'
        $again=@(Run $f @('start','-Task','ticket-gone'))[0]
        Assert ($again.SessionId -eq $replacement.SessionId -and (Native $f).Starts -eq 2) 'Replacement was not remembered.'
    }
    Case 'existing branch worktree and conversation can be found again after launcher state is lost' {
        $f=Fixture rediscover; $first=@(Run $f @('start','-Task','ticket-found'))[0]
        Rename-Item -LiteralPath $f.State -NewName 'prior-state.json'
        $found=@(Run $f @('start','-Task','ticket-found','-Branch',$first.Branch))[0]
        Assert ($found.SessionId -eq $first.SessionId -and (Native $f).Starts -eq 1) 'Lost state caused a duplicate session.'
        $again=@(Run $f @('start','-Task','ticket-found'))[0]
        Assert ($again.SessionId -eq $first.SessionId -and (Native $f).Starts -eq 1) 'Rediscovered task was not remembered.'
        Assert ((State $f).Sessions[$first.SessionId].Ownership -eq 'unmanaged') 'Rediscovery adopted ownership of an external session.'
    }
    if($failures.Count){throw "$($failures.Count) failed, $passed passed.`n$($failures -join "`n")"}
    Write-Host "All $passed worktree tests passed. No real Claude session was started."
} finally {
    $absolute=[IO.Path]::GetFullPath($suite)
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if($absolute.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'remote-worktree-test-*'){
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}
