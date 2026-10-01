# Compatibility shim: the tool lives in packages/apps-sync (oneezy/tools#75).
& (Join-Path $PSScriptRoot '../../packages/apps-sync/Apps Sync.ps1') @args
exit $LASTEXITCODE
