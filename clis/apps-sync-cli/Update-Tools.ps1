# Compatibility shim: the tool lives in packages/apps-sync (oneezy/tools#75).
& (Join-Path $PSScriptRoot '../../packages/apps-sync/Update-Tools.ps1') @args
exit $LASTEXITCODE
