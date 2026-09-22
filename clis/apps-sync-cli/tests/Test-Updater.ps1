#Requires -Version 7.0
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Assert($Condition,$Message) { if (!$Condition) { throw $Message } }
foreach($file in @('Manage-Software.ps1','Update-Tools.ps1','Run-Installer.ps1')) {
    $parseErrors=$null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot $file),[ref]$null,[ref]$parseErrors) | Out-Null
    Assert (!$parseErrors.Count) "$file has syntax errors."
}
$output=& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $projectRoot 'Manage-Software.ps1') -Mode check -Target windows -Only codex -Json
Assert ($LASTEXITCODE -eq 0) 'Local launcher failed.'
$report=($output -join [Environment]::NewLine) | ConvertFrom-Json
$windows=@($report.rows | Where-Object host -eq windows)
Assert ($windows.Count -eq 1) 'Selection did not limit Windows inventory.'
Assert ($windows[0].id -eq 'codex') 'Wrong tool selected.'
Assert ($null -eq $windows[0].release) 'Local mode discovered a release.'
Assert ($windows[0].status -ne 'Current') 'Unchecked tool was marked Current.'
$null=& (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $projectRoot 'Manage-Software.ps1') -Mode check -Only deliberately-unknown 2>&1
Assert ($LASTEXITCODE -ne 0) 'Launcher swallowed a failure exit code.'
Write-Host 'Launcher parsing, local selection, unchecked freshness, and failure exit-code checks passed.' -ForegroundColor Green
exit 0
