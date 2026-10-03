# Compatibility entry point. All behavior lives in the cross-platform Python implementation.
$engine = Join-Path $PSScriptRoot 'remote_sessions.py'
if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 $engine @args }
elseif (Get-Command python3 -ErrorAction SilentlyContinue) { & python3 $engine @args }
else { & python $engine @args }
exit $LASTEXITCODE
