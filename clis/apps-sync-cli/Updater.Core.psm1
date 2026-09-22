# Historical pure helper functions, retained for reference only.
# Active launchers use software_manager.py and software-catalog.json.
Set-StrictMode -Version Latest

function ConvertTo-StableVersion {
    param([Parameter(Mandatory)][string]$Value)
    $value = $Value.Trim() -replace '^rust-v', '' -replace '^v', ''
    if ($value -notmatch '^\d+\.\d+\.\d+$') {
        throw "Expected a stable release version; received '$Value'."
    }
    return [version]$value
}

function Invoke-ToolUpdate {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$ReadVersion,
        [Parameter(Mandatory)][scriptblock]$GetLatestVersion,
        [Parameter(Mandatory)][scriptblock]$Update,
        [switch]$CheckOnly
    )
    $result = [ordered]@{ Tool=$Name; Before='Unknown'; Latest='Unknown'; After='Unknown'; Status='Failed'; Detail='' }
    try {
        $result.Before = [string](& $ReadVersion)
        $result.After = $result.Before
        $before = ConvertTo-StableVersion $result.Before
        $latest = ConvertTo-StableVersion ([string](& $GetLatestVersion))
        $result.Latest = $latest.ToString()
        Write-Host "$Name`: installed $before; latest stable $latest"
        if ($before -gt $latest) {
            $result.Status = 'Ahead'
            $result.Detail = 'Installed version is newer than the publisher response; no downgrade performed.'
        } elseif ($before -eq $latest) {
            $result.Status = 'Current'
        } elseif ($CheckOnly) {
            $result.Status = 'Available'
        } else {
            & $Update $latest.ToString() | Out-Host
            $result.After = [string](& $ReadVersion)
            if ((ConvertTo-StableVersion $result.After) -lt $latest) {
                throw "Updater finished, but verification found $($result.After); expected at least $latest."
            }
            $result.Status = 'Updated'
        }
    } catch {
        $result.Detail = $_.Exception.Message
        # A failed updater can still have changed the executable. Report its actual state.
        try { $result.After = [string](& $ReadVersion) } catch { $result.After = 'Unknown' }
        Write-Host "$Name`: $($result.Detail)" -ForegroundColor Red
    }
    return [pscustomobject]$result
}

function Invoke-UpdaterCommand {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @())
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Executable not found: $FilePath" }
    $global:LASTEXITCODE = 0
    & $FilePath @Arguments 2>&1 | ForEach-Object { Write-Host ([string]$_) }
    if ($LASTEXITCODE -ne 0) { throw "$(Split-Path -Leaf $FilePath) exited with code $LASTEXITCODE." }
}

function Get-ExecutableVersion {
    param([Parameter(Mandatory)][string]$FilePath, [string]$Pattern = '(?m)^(?:codex-cli |vp v)?(\d+\.\d+\.\d+)(?:\s|$)')
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw "Executable not found: $FilePath" }
    $global:LASTEXITCODE = 0
    $output = (& $FilePath --version 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Version check failed for $FilePath`: $output" }
    if ($output -notmatch $Pattern) { throw "Could not parse version from $FilePath`: $output" }
    return $Matches[1]
}

Export-ModuleMember -Function ConvertTo-StableVersion, Invoke-ToolUpdate, Invoke-UpdaterCommand, Get-ExecutableVersion
