# Validation — 2026-09-21

Implementation is in V:\dev\tools\app-updater. No Git operations were performed.
The only installed dependencies were prompt_toolkit 3.0.52 and wcwidth 0.2.13 in this project's
Windows .venv. No installed applications or CLI packages were upgraded.

## Results

- Windows: 57 tests collected, 56 passed, 1 Linux-only test skipped.
- Ubuntu: 57 tests collected, 47 passed, 10 Windows/UI-only tests skipped.
- PowerShell launcher checks passed: syntax, selected local inventory, unchecked freshness and
  failure exit-code propagation.
- Offline audit scans returned 24 tools per host with zero Python network calls. Linux spawned
  no inventory subprocesses. Windows used only the fixed inbox PowerShell file/AppX metadata query.
- The Windows/Ubuntu bridge returned both native installations in one logical row. Synthetic
  target-already-met plans were independently rechecked and skipped in both environments.
- Both per-environment operation locks were acquired/released on the relocated project filesystem.
- The desktop shortcut's exact cmd → PowerShell → Python launch chain was exercised in a terminal.
  Local inventory appeared immediately; down/Space/inspect/return/exit worked. The results remained
  visible at the final pause. Arrow/Enter menus and explicit installation checklists also passed
  controlled keyboard-input tests.
- Launcher startup-failure visibility and pause behavior were tested using temporary fake scripts.
- Installer exit-code handling was tested with mocked processes, including success, failure,
  cancellation, restart-required and unexpected restart-initiated results. No installer was launched.
- Actual temporary Python fixture programs exercised successful/failed execution and after-state
  verification. Fixtures did not modify real installations.

Logs: logs/validation-windows-tests.txt, logs/validation-wsl-tests.txt,
logs/validation-windows-offline.json, logs/validation-wsl-offline.json.
Final local evidence: logs/validated-local-inventory.json and its readable .log.

## Remaining limits

Live publisher endpoints and real GUI/native installers were not exercised. Their future explicit
checks/plans can fail if a vendor changes an endpoint, asset, ownership rule or installer behavior.
The desktop shortcut command chain was tested in a terminal; Explorer itself was not automated.

Manual holds, Ubuntu pnpm's unset default, Ubuntu Herdr's missing passive version evidence, and
Windows Turbo/Vercel ownership conflicts remain visible rather than being guessed or migrated.
APT latest checks use dated cached indexes and never claim fresh upstream verification.

## Relocation evidence

The desktop shortcut targets cmd.exe with Manage Software.cmd in the authoritative directory;
its working directory is also V:\dev\tools\app-updater. Its previous version is backed up at
backups/Update Software-before-relocation.lnk.

The pre-existing backup is present at backups/before-local-preflight-20260921-002449.
A further implementation backup is at backups/before-approved-design-20260921-014447.

The historical C:\Users\Justin\Tools\CLI Updater directory was present during the initial review
but absent at final verification. This implementation did not delete or modify that directory.
