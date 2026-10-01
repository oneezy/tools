#Requires -Version 7.0
# Static syntax checks for the files a package lists; nothing is executed.
#   .ps1  parsed with the PowerShell parser
#   .sh   bash -n (Git for Windows' bash on Windows; System32\bash.exe would start WSL)
#   .py   python -m py_compile, through scripts/python.mjs
# Usage from a package: pwsh -NoProfile -File ../../scripts/syntax-check.ps1 <file>...
param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Files)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

function Find-Bash {
    if (-not $IsWindows) { return 'bash' }
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
        $root = Split-Path (Split-Path $git)
        foreach ($candidate in @((Join-Path $root 'usr\bin\bash.exe'), (Join-Path (Split-Path $root) 'usr\bin\bash.exe'))) {
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    throw 'Git for Windows bash was not found next to git; it is needed to syntax-check .sh files.'
}

$failed = 0
foreach ($file in $Files) {
    $path = (Resolve-Path -LiteralPath $file).Path
    switch ([IO.Path]::GetExtension($path).ToLowerInvariant()) {
        '.ps1' {
            $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors) | Out-Null
            if ($errors.Count) {
                $failed++
                Write-Host "FAIL $file"
                $errors | ForEach-Object { Write-Host "  line $($_.Extent.StartLineNumber): $($_.Message)" }
            } else { Write-Host "ok   $file" }
        }
        '.sh' {
            & (Find-Bash) -n $path
            if ($LASTEXITCODE) { $failed++; Write-Host "FAIL $file" } else { Write-Host "ok   $file" }
        }
        '.py' {
            & node (Join-Path $here 'python.mjs') -m py_compile $path
            if ($LASTEXITCODE) { $failed++; Write-Host "FAIL $file" } else { Write-Host "ok   $file" }
        }
        default { throw "syntax-check.ps1 has no check for $file" }
    }
}
if ($failed) { Write-Host "$failed file(s) failed"; exit 1 }
