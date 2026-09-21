# App Updater

Authoritative directory: V:\dev\tools\app-updater. Read README.md and GUIDE.md before changing behavior.
Justin's dev-based Git workflow applies if a repository is established. Do not initialize Git,
commit, push, or delete the old location without authorization.

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
Manage-Software.ps1 and Manage Software.cmd launch the app.
Run-Installer.ps1 executes only explicitly selected publisher plans.

UI dependencies are isolated in .venv and requirements-ui.txt. Ubuntu's worker is standard-library
only. Never bootstrap dependencies automatically on launch.

Run the Python suite on Windows/Ubuntu and offline_smoke.py on each after relevant changes.
tests/Test-Updater.ps1 verifies the launcher. Never use real upgrades as tests. A passing suite
does not imply GUI installer coverage; report validation limits faithfully.
