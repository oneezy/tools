#Requires -Version 7.0
# Compatibility entry point. Default launch is local-only; never a bulk updater.
param([switch]$CheckOnly,[switch]$Pause)
$arguments=@{}
if ($CheckOnly) { $arguments.Mode='check'; $arguments.Target='windows' }
if ($Pause) { $arguments.Pause=$true }
& (Join-Path $PSScriptRoot 'Manage-Software.ps1') @arguments
exit $LASTEXITCODE
