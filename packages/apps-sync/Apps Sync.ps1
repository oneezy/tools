#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateSet('menu','check','check-latest','update','install','inventory')][string]$Mode='menu',
    [ValidateSet('all','windows','wsl')][string]$Target='all',
    [string[]]$Only=@(),
    [switch]$Plain,
    [switch]$Json,
    [switch]$Pause,
    [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
$exitCode=1
$savedUtf8=$env:PYTHONUTF8
$savedBytecode=$env:PYTHONDONTWRITEBYTECODE
try {
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
    $env:PYTHONUTF8='1'
    $env:PYTHONDONTWRITEBYTECODE='1'
    if ($CheckOnly) { $Mode='check' }
    $python=Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $python)) {
        $python=Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
        if (!(Test-Path -LiteralPath $python)) { throw 'Python is unavailable. See README.md for explicit setup; launch never installs dependencies.' }
        Write-Warning 'Updater environment unavailable. Using existing Python with numbered-menu fallback.'
        $Plain=$true
    }
    $arguments=@('-B',(Join-Path $PSScriptRoot 'software_manager.py'),'--mode',$Mode,'--target',$Target)
    if ($Only.Count) { $arguments+=@('--only',($Only -join ',')) }
    if ($Plain) { $arguments+='--plain' }
    if ($Json) { $arguments+='--json' }
    & $python @arguments
    $exitCode=$LASTEXITCODE
} catch {
    Write-Host "App Updater could not start: $_" -ForegroundColor Red
} finally {
    $env:PYTHONUTF8=$savedUtf8
    $env:PYTHONDONTWRITEBYTECODE=$savedBytecode
    if ($Pause -and ![Console]::IsInputRedirected) { Read-Host 'Press Enter to close' | Out-Null }
}
exit $exitCode
