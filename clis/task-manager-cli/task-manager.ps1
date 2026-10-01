# Compatibility shim: the tool lives in packages/task-manager (oneezy/tools#75).
& (Join-Path $PSScriptRoot '../../packages/task-manager/task-manager.ps1') @args
exit $LASTEXITCODE
