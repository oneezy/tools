# App Updater

A manually launched terminal manager for selected Windows applications and native Ubuntu CLI installations.
The authoritative project directory is **V:\dev\tools\app-updater**.

Double-click **Update Software** on the desktop, or **Manage Software.cmd** here.
Launch scans local installation records and displays one table:

**Tool | Windows | WSL | Latest available version | Status / action**

Launch does not check release services, invoke package-manager shims, download, install, or update anything.
Windows and Ubuntu versions may differ. That is information, not an error.

- **Up/down:** move between tools. **Space:** mark tools.
- **Enter:** actions. Use up/down and Enter to choose an action.
- **I:** inspect full paths, ownership, evidence, source, timestamps, and errors.
- **C:** check latest for marked tools, or the focused tool.
- **R:** refresh local inventory. **Q / Escape:** exit.
- In installation checklists, **Space** selects Windows/WSL entries; **Tab → Enter** accepts the selection.

Updates and missing-tool installation are separate actions. Both show a concrete plan and require
confirmation. Missing installations are never selected automatically. No scheduled task or updater service is created.

See [GUIDE.md](GUIDE.md) for limits, commands, catalog recipes, and verification.

## Explicit setup

The Windows launcher uses the updater's **.venv**, containing pinned prompt_toolkit and wcwidth.
Ubuntu's worker needs only its existing Python 3.11+ standard library. No global npm packages are required.
The environment has been prepared for this checkout. To recreate it deliberately:

    & "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" -m venv .venv
    & .\.venv\Scripts\python.exe -m pip install -r requirements-ui.txt

Setup is never performed on launch. If the environment is missing, the launcher tries existing
Windows Python 3.12 with numbered menus. If Python or PowerShell is missing, the desktop launcher
displays the failure and pauses. PowerShell 7 is required by the Windows wrapper.

Use Manage-Software.ps1 or Python directly for redirected output; the desktop .cmd deliberately pauses.
With redirected input or output, default launch prints the local table and exits without prompting.

## Checks

    & .\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
    & .\.venv\Scripts\python.exe -B tests\offline_smoke.py
    & .\tests\Test-Updater.ps1
    wsl.exe -d Ubuntu-26.04 --cd /mnt/v/dev/tools/app-updater --exec /usr/bin/python3 -B -m unittest discover -s tests -v
    wsl.exe -d Ubuntu-26.04 --cd /mnt/v/dev/tools/app-updater --exec /usr/bin/python3 -B tests/offline_smoke.py

Tests use simulated releases and temporary fake programs. They do not update installed applications.
The offline smoke test audits real local scans and rejects network calls or unapproved subprocesses.
GUI installers and live publisher availability are not established by these tests.
