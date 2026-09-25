param([string]$Script = (Join-Path $PSScriptRoot 'remote-control.ps1'))
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('remote-session-test-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $fixture "projects with space's"
$project = Join-Path $root 'example'
$worktree = Join-Path $project '.claude/worktrees/bridge-cse_example'
$claudeDir = Join-Path $fixture 'claude-config'
$transcriptDir = Join-Path $claudeDir 'projects/example-worktree'
$sessionId = '11111111-2222-4333-8444-555555555555'
New-Item -ItemType Directory -Force $worktree,$transcriptDir | Out-Null
Set-Content -LiteralPath (Join-Path $worktree '.git') -Value 'gitdir: fixture'
$record = @{type='user';sessionId=$sessionId;cwd=$worktree;timestamp='2026-09-22T12:00:00Z';message=@{role='user';content='fixture'}}
$record | ConvertTo-Json -Compress -Depth 5 | Set-Content (Join-Path $transcriptDir "$sessionId.jsonl")
@{Mode='normal';Agents=@();Starts=0;Stops=0} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $claudeDir 'fake-native.json')
$fake=Join-Path $PSScriptRoot 'tests/fake-claude.ps1'
try {
    $result = & pwsh -NoProfile -File $Script resume -Root $root -ClaudeConfigDirectory $claudeDir -ClaudeExecutable $fake -Only example -SessionId $sessionId -Plan -Json 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Saved conversation could not be selected for resume: $result" }
    $plan = ($result -join "`n") | ConvertFrom-Json
    if ($plan.WorkingDirectory -ne $worktree) { throw 'Resume lost the saved worktree.' }
    $resumeIndex = [array]::IndexOf($plan.Arguments, '--resume')
    if ($resumeIndex -lt 0 -or $plan.Arguments[$resumeIndex + 1] -ne $sessionId) { throw 'Resume lost the original conversation ID.' }
    if ('--worktree' -in $plan.Arguments -or '--spawn' -in $plan.Arguments) { throw 'Resume must not create a replacement worktree.' }
    if (Test-Path (Join-Path $root '.remote-control.json')) { throw 'Planning must not change launcher state.' }
    Write-Host 'PASS: resume preserves the saved conversation and worktree without mutating state.'
} finally {
    $absolute = [IO.Path]::GetFullPath($fixture)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($absolute.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $absolute -Leaf) -like 'remote-session-test-*') {
        Remove-Item -LiteralPath $absolute -Recurse -Force
    }
}
