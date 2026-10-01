#Requires -Version 7.0
# Runs a shell script with bash from a package's npm script, on either host: Git for Windows' bash on
# Windows (System32\bash.exe would start WSL), plain bash elsewhere. Same finder as syntax-check.ps1.
# Usage from a package: pwsh -NoProfile -File ../../scripts/run-sh.ps1 <script.sh> [args...]
param(
  [Parameter(Mandatory)][string]$Script,
  [Parameter(ValueFromRemainingArguments)][string[]]$ScriptArgs = @()
)
$ErrorActionPreference = 'Stop'

function Find-Bash {
    if (-not $IsWindows) { return 'bash' }
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
        $root = Split-Path (Split-Path $git)
        foreach ($candidate in @((Join-Path $root 'usr\bin\bash.exe'), (Join-Path (Split-Path $root) 'usr\bin\bash.exe'))) {
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    throw 'Git for Windows bash was not found next to git; it is needed to run .sh scripts.'
}

& (Find-Bash) $Script @ScriptArgs
exit $LASTEXITCODE
