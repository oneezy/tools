"""Windows wrapper tests use temporary scripts and mocked installer processes only."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PWSH = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "PowerShell/7/pwsh.exe"


def quote_ps(value):
    return "'" + str(value).replace("'", "''") + "'"


@unittest.skipUnless(os.name == "nt" and PWSH.exists(), "Windows launcher tests")
class LauncherTests(unittest.TestCase):
    def test_desktop_wrapper_preserves_failure_and_pause(self):
        with tempfile.TemporaryDirectory(prefix="updater launcher ") as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / "Manage Software.cmd", root / "Manage Software.cmd")
            (root / "Manage-Software.ps1").write_text("Write-Output 'fixture startup failure'; exit 17")
            command = f'{os.environ["COMSPEC"]} /d /c ""{root / "Manage Software.cmd"}""'
            result = subprocess.run(command, input="\r\n", text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 17)
        self.assertIn("fixture startup failure", result.stdout)
        self.assertIn("Press any key", result.stdout)

    def test_missing_powershell_stays_visible_without_installing(self):
        with tempfile.TemporaryDirectory(prefix="updater launcher ") as directory:
            root = Path(directory)
            shutil.copyfile(ROOT / "Manage Software.cmd", root / "Manage Software.cmd")
            entry = root / "missing-runtime.cmd"
            entry.write_text(f'@echo off\nset "ProgramFiles={root}"\ncall "{root / "Manage Software.cmd"}"\nexit /b %errorlevel%\n')
            command = f'{os.environ["COMSPEC"]} /d /c ""{entry}""'
            result = subprocess.run(command, input="\r\n", text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertIn("PowerShell 7 is unavailable", result.stdout)
        self.assertIn("Press any key", result.stdout)

    def test_installer_exit_codes_preserve_restart_and_cancel_flags(self):
        for code in (0, 3010, 1602, 5, 1641):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory:
                report = Path(directory) / "result.json"
                script = (
                    "function Start-Process { param($FilePath,$ArgumentList,[switch]$Wait,[switch]$PassThru,$Verb) "
                    "if ($ArgumentList -notmatch '/norestart') { throw 'Missing restart protection' }; "
                    f"[pscustomobject]@{{ExitCode={code}}} }}; "
                    f"& {quote_ps(ROOT / 'Run-Installer.ps1')} -Installer 'fake.msi' -ResultPath {quote_ps(report)}"
                )
                result = subprocess.run([str(PWSH), "-NoProfile", "-Command", script], capture_output=True, timeout=15)
                outcome = json.loads(report.read_text(encoding="utf-8-sig"))
            self.assertEqual(outcome["exit_code"], code)
            self.assertEqual(outcome["restart_required"], code in (3010, 1641))
            self.assertEqual(outcome["cancelled"], code == 1602)
            self.assertEqual(result.returncode, 0 if code in (0, 3010) else 1)

    def test_invalid_signature_never_starts_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "result.json"
            script = (
                "function Start-Process { throw 'BUG: installer was started' }; "
                "function Get-AuthenticodeSignature { [pscustomobject]@{Status='NotSigned'} }; "
                f"& {quote_ps(ROOT / 'Run-Installer.ps1')} -Installer 'fake.exe' -ExpectedSigner 'Vendor' "
                f"-ResultPath {quote_ps(report)}"
            )
            result = subprocess.run([str(PWSH), "-NoProfile", "-Command", script], capture_output=True, timeout=15)
            outcome = json.loads(report.read_text(encoding="utf-8-sig"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("signature", outcome["error"])
        self.assertNotIn("BUG", outcome["error"])
