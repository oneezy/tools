# App Updater

Directory: V:\dev\tools\packages\apps-sync (`packages/apps-sync` in the tools workspace). Read README.md and GUIDE.md before changing behavior.
Changes go through pull requests into dev, like the rest of the tools workspace.

## Product invariants

- Default launch/local inventory is passive and offline. Never run package-manager shims.
- Only explicit Check latest discovers releases. Old history never means Current.
- One logical row per tool; separate Windows/native Ubuntu installations.
- Preserve owner/channel/scope. Unknown or conflicting ownership blocks mutation.
- Update never installs missing tools. Missing installation requires explicit selection.
- Preflight, confirmation, recheck, skip current/newer, execute, actual version verification.
- Preserve partial reports on failure/cancellation. Never force-close apps or restart systems.
- Preserve Vite ownership and Node/project configuration. No plugin/connector settings/inventory.
- Review catalog additions; do not automatically adopt discoveries.
- Read .npmrc only for narrowly needed path keys. Never retain/log/copy authentication data.

## Layout and checks

updater_inventory.py owns passive evidence and shared caches.
software_manager.py owns explicit discovery, plans, execution, WSL bridge, reports and CLI.
updater_ui.py owns keyboard/detail/plain interfaces. software-catalog.json owns tool recipes.
Apps Sync.ps1 and App Sync.cmd launch the app; Update-Tools.ps1 and Update CLI Tools.cmd are compatibility shims onto them.
Run-Installer.ps1 executes only explicitly selected publisher plans.

UI dependencies are isolated in .venv and requirements-ui.txt. Ubuntu's worker is standard-library
only. Never bootstrap dependencies automatically on launch.

Run the Python suite on Windows/Ubuntu and offline_smoke.py on each after relevant changes.
tests/Test-Updater.ps1 verifies the launcher. Never use real upgrades as tests. A passing suite
does not imply GUI installer coverage; report validation limits faithfully.

## Workspace

This is `packages/apps-sync` in the tools workspace.
`pnpm test` runs tests/test_*.py (tests/test_launchers.py runs only on Windows) and `pnpm check` syntax-checks the
PowerShell and Python files. tests/Test-Updater.ps1 runs the real launcher against this checkout's .venv, so it stays a
manual check on the PC.
