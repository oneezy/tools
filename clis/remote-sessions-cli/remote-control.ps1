# Compatibility shim: the tool lives in packages/remote-sessions (oneezy/tools#75).
& (Join-Path $PSScriptRoot '../../packages/remote-sessions/remote-control.ps1') @args
exit $LASTEXITCODE
