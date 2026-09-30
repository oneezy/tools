# A test-only native CLI substitute. Never starts or stops a real process.
$ErrorActionPreference = 'Stop'
$arguments = @($args)
$dataPath = Join-Path $env:CLAUDE_CONFIG_DIR 'fake-native.json'
$data = Get-Content -LiteralPath $dataPath -Raw | ConvertFrom-Json -AsHashtable
function Save-Fake { $data | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $dataPath }
if ($arguments[0] -eq 'agents') {
    if ($data.Mode -eq 'malformed') { Write-Output '{invalid'; exit 0 }
    if ($data.Mode -eq 'inventory-failure') { Write-Output 'Inventory unavailable'; exit 6 }
    ConvertTo-Json -InputObject @($data.Agents) -Depth 8 -Compress
    exit 0
}
if ($arguments[0] -eq '--bg') {
    $data.Starts++
    $resumeIndex = [array]::IndexOf($arguments, '--resume')
    $isNew=$resumeIndex -lt 0
    $id = if($isNew){[guid]::NewGuid().ToString()}else{$arguments[$resumeIndex + 1]}
    $data.LastArguments = $arguments
    $data.LastDirectory = (Get-Location).Path
    if ($data.Mode -eq 'launch-failure') { Save-Fake; Write-Output 'Authentication required'; exit 9 }
    # Native Claude copies an existing background session when resume overrides its options.
    # Keep the original stopped row so an engine cannot mistake the copy for an exact resume.
    $copied = @($data.Agents | Where-Object { $_.sessionId -eq $id -and $_.kind -eq 'background' }).Count -gt 0 -and '--remote-control' -in $arguments
    if ($copied) { $id = [guid]::NewGuid().ToString() }
    $agent = @{
        id = $id.Substring(0,8); sessionId = $id; kind = 'background'; state = 'idle'
        cwd = (Get-Location).Path; pid = 9000 + $data.Starts; startedAt = "run-$($data.Starts)"
    }
    if ($data.Mode -eq 'wrong-directory') { $agent.cwd = $env:TEMP }
    $data.Agents = @($data.Agents | Where-Object sessionId -NE $id) + @($agent)
    if($isNew){
        $history=Join-Path $env:CLAUDE_CONFIG_DIR 'projects/new-task'
        New-Item -ItemType Directory -Force $history | Out-Null
        @{type='user';sessionId=$id;cwd=$agent.cwd;timestamp=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $history "$id.jsonl")
    }
    Save-Fake
    if($data.Mode -eq 'launch-exit-failure'){Write-Output 'Session started but launch confirmation failed'; exit 9}
    if ($copied) { Write-Output 'Note: Started a copy with updated options.' }
    Write-Output "Resumed $id"
    exit 0
}
if ($arguments[0] -eq 'stop') {
    $data.Stops++
    $matches = @($data.Agents | Where-Object id -EQ $arguments[1])
    if ($matches.Count -ne 1) { throw 'Unknown or ambiguous fake agent.' }
    if ($data.Mode -ne 'stop-no-effect') { $matches[0].state = 'stopped'; $matches[0].pid = $null }
    Save-Fake
    Write-Output 'Stopped'
    exit 0
}
throw "Unexpected test CLI arguments: $($arguments -join ' ')"
