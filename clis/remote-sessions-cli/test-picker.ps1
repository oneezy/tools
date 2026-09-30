# The picker implementation is now Python; run the same regression on either OS.
$test = 'test_portable.PortableTests.test_picker_a_enter_twice_preserves_sessions'
Push-Location (Join-Path $PSScriptRoot 'tests')
try {
    & py -3 -m unittest $test -v
    $code = $LASTEXITCODE
} finally { Pop-Location }
exit $code
