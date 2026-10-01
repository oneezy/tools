# Executes an explicitly approved publisher plan; never called by local inventory.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [string]$ExpectedSigner='',
    [Parameter(Mandatory)][string]$ResultPath,
    [string]$InstallerArgumentsJson='[]'
)
$ErrorActionPreference='Stop'
$outcome=@{exit_code=$null;restart_required=$false;cancelled=$false;error=$null}
$exitCode=1
try {
    if ($ExpectedSigner) {
        $signature=Get-AuthenticodeSignature -LiteralPath $Installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike "*$ExpectedSigner*") {
            throw "Installer signature does not match $ExpectedSigner."
        }
    }
    $installerArguments=@($InstallerArgumentsJson | ConvertFrom-Json)
    $program=$Installer
    if ([IO.Path]::GetExtension($Installer) -eq '.msi') {
        $program=Join-Path $env:SystemRoot 'System32\msiexec.exe'
        $argumentText='/i "'+$Installer+'" /norestart'
    } else {
        # Catalog arguments are fixed trusted flags, never user/remote command text.
        $argumentText=($installerArguments -join ' ')
    }
    $startOptions=@{FilePath=$program;Wait=$true;PassThru=$true}
    if ($argumentText) { $startOptions.ArgumentList=$argumentText }
    # This is an interactive installer explicitly selected by the user.
    try { $process=Start-Process @startOptions }
    catch {
        if ($_.Exception.NativeErrorCode -ne 740 -and $_.Exception.InnerException.NativeErrorCode -ne 740) { throw }
        $startOptions.Verb='RunAs'
        $process=Start-Process @startOptions
    }
    $outcome.exit_code=$process.ExitCode
    $outcome.restart_required=$process.ExitCode -in @(3010,1641)
    $outcome.cancelled=$process.ExitCode -eq 1602
    if ($process.ExitCode -notin @(0,3010)) { $outcome.error="Installer exited $($process.ExitCode)." }
    if ($process.ExitCode -eq 1641) { $outcome.error='Installer reported a restart initiated despite the no-restart policy. Manual attention required.' }
    $exitCode=if ($process.ExitCode -in @(0,3010)) { 0 } else { 1 }
} catch {
    $outcome.error=$_.Exception.Message
    if ($_.Exception.NativeErrorCode -eq 1223) { $outcome.cancelled=$true }
} finally {
    $outcome | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8
}
exit $exitCode
