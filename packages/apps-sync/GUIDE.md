# App Updater guide

## Scope and startup

This is a personal software manager, not a plugin or connector manager.
software-catalog.json is the single catalog: 24 tools and 37 environment recipes. A catalog entry
does not prove that its installer has been exercised. Windows/Ubuntu installations remain separate.
Windows GUI applications are not installed into WSL. Docker Desktop remains the Windows installation;
docker-desktop is never used as a workstation distribution.

Launch reads tracked uninstall records, PE resources, exact Windows app-package identities, resolved
active release paths, Vite configuration/global manifests, the active Node runtime's npm manifests,
known/configured pnpm global locations, and Ubuntu's dpkg records.

No application binary, npm/pnpm shim, WinGet command, APT refresh or release service is invoked by
local inspection. One profile-free inbox PowerShell query reads Windows file/AppX metadata.
Shared scans are cached per refresh. Windows and Ubuntu local scans run concurrently.

The bridge uses wsl.exe --exec and Ubuntu-26.04. Inspecting Ubuntu may start that distribution if
stopped; it does not install or upgrade WSL. Local scanning has a bounded timeout. WSL failure
produces an unavailable state per applicable tool and leaves Windows usable.

## Controls and views

The main screen is a scrollable unified five-column table. Up/down chooses a tool; Space marks it.
Enter opens actions. Action menus use up/down and Enter; Escape returns.
I opens details, C checks marked/focused tools, R refreshes local records, and Q exits.

Actions cover Check latest (marked/focused or all), Inspect, Update installed, Install missing,
Refresh local, Select tools, Review discovered global packages, and Exit.
Windows/Ubuntu installations are separate checklist entries; none is selected by default.
Space toggles entries; Tab moves to buttons and Enter accepts/cancels.
The final execution question defaults to Cancel.

Colors supplement text. Cyan titles, gray borders, green installed/current results, yellow pending
actions and red errors/blocks accompany explicit status labels. Reverse video marks the focused
tool. Terminal NO_COLOR preferences are honored by the UI library. About 140 columns is comfortable;
narrow terminals wrap within the same table.

Details show full/resolved paths, ownership/scope, timestamps, release source, history, conflicts,
errors and operation results. Registered GUI versions do not establish the running process version.
Unsupported terminals use numbered menus. Redirected default launch prints a plain local report
and exits. Redirected update/install prints its plan and refuses execution; there is no unattended
--yes override.

## Freshness and states

Installed / latest not checked is the normal initial state. Missing, platform not applicable,
not inspected, WSL unavailable, unknown/detection failure, environment mismatch, and blocked/manual
attention remain distinct. A Windows/Linux version difference is not an environment mismatch.

Only Check latest discovers releases. Publisher checks can produce Current, Newer installed or
Update available. WinGet says Catalog current and identifies its catalog as the source; it does
not establish publisher freshness. Environment-specific releases stay separate in the latest
column. Failed checks never become Current.

APT checks retain the full Debian epoch/version/revision and deliberately inspect cached local
indexes. They show Cached candidate / inspect and include index timestamps in details and the plan.
They do not claim freshly verified repository or publisher latest. System-wide APT indexes are not
refreshed automatically. Refresh them as a separate deliberate system action if needed, then use
Check latest again.

History in logs/release-history-windows.json and logs/release-history-wsl.json is scoped by host,
tool, provider, channel and source. Launch/local refresh leaves latest at not checked and places
old checks in history. Successful HTTP responses are shared across matching Windows/Ubuntu sources
within the same explicit check; old disk history is never reused as a freshly fetched response.

## Plans, execution and reports

Each plan displays the tool, environment, action, owner, installation identity, before/target,
release source/channel/time, exact command arguments, pinned runtime environment, download URL,
checksum/signer, elevation and vendor limitations.

Immediately before downloading/executing, the manager rechecks installed state. Versions already
meeting/exceeding the target are skipped. Update never installs missing/disappeared tools; Install
skips existing tools. Changed owner, scope, runtime, catalog or execution recipe requires a new plan.

Native updaters and bootstraps may discover releases during explicit execution. A selected target
may be a minimum rather than a version the vendor can pin exactly. Publisher assets require the
configured checksum or signature. Missing GitHub digests, ambiguous assets and changed release layouts
block execution. Native bootstrap scripts use catalogued HTTPS publisher endpoints and retain the
publisher's verification behavior.

There is no blind all-WinGet, all-APT or all-npm upgrade. Ubuntu gh/Git retain APT/dpkg ownership.
Vite globals stay with Vite Plus. npm globals use installed Node/npm files and an explicit prefix.
Node versions, project dependencies, lockfiles and pins are not changed by manager code. pnpm
updates explicitly change its Vite global default. Runtime defaults are recorded before/after;
unexpected vendor changes require attention instead of automatic rollback.

Fresh detection verifies the installed version after execution, including failure. Native CLI
updates also probe the actual executable. pnpm probes the physical package executable, never the
Vite shim. Zero installer exit alone is insufficient. Cancellation, deferred replacement, failure,
unknown after-state and restart requirements are recorded. MSI execution uses /norestart.
No apps are force-closed and no Windows/WSL restart is requested by the manager.

Installers/sudo may present their own prompts; decline any vendor prompt you do not want.
Ctrl+C stops subsequent operations and preserves results. A detached installer may still be
completing; inspect before retrying.

Reports under logs include readable .log summaries and JSON before/rechecked/target/after evidence,
planned commands, exit codes, errors and restart/deferred/cancellation flags. Checkpoints are saved
before operations and after every result. Windows/Ubuntu have separate operation locks; the parent
writes a combined final report. The readable log is an operation summary, not a complete capture
of vendor GUI dialogs.

## Catalog and deliberate restrictions

Each catalog entry has an ID, display name, source and separate environment recipes, with explicit
channel/hold information. New recipes need detector, owner, comparison and execution tests. Never
copy raw execution commands out of untrusted release metadata.

Review discovered globals reports Vite, npm and pnpm ownership separately. Runtime npm/corepack
are excluded from candidate additions. Nothing is adopted automatically: review ownership and
channel, then explicitly approve a catalog recipe. Other selected applications can be added the
same way. Discovery inspects known/configured roots; cached runtimes are not active installations.

- Hermes: source checkout on main with a previously reported carried commit; manual review only.
- clasp: alpha pin remains held pending a channel decision.
- VS Code Insiders: use its build-aware in-app updater.
- Wispr Flow: use its updater; staged folders are not running-version evidence.
- Claude Desktop/Codex Desktop: separate registered Windows app packages. Preserve their identities;
  use the app/original source until automated routes are verified.
- Ubuntu pnpm: no global default; cached versions are reported without running the shim.
- Ubuntu Herdr: native file present, but no supported passive version record. Unknown until a safe
  detector is available; it is never run during local inspection.
- Windows Turbo/Vercel: initial review found both Vite and pnpm installations. Details show the
  conflicting owners; mutation is blocked pending an explicit ownership decision.

## Commands

From the project directory in PowerShell:

    .\Manage-Software.ps1 -Mode check
    .\Manage-Software.ps1 -Mode check-latest -Only codex,claude -Target all
    .\Manage-Software.ps1 -Mode inventory
    .\Manage-Software.ps1 -Mode update -Only codex -Target windows
    .\Manage-Software.ps1 -Mode install -Only copilot -Target windows
    .\.venv\Scripts\python.exe -B software_manager.py --mode check --json

CLI update/install explicitly select dated saved targets and require terminal confirmation. They
do not discover releases. The UI uses checks selected during the current session.

Direct Ubuntu:

    python3 /mnt/v/dev/tools/app-updater/software_manager.py --mode check --target wsl
    python3 /mnt/v/dev/tools/app-updater/software_manager.py --mode check-latest --only codex

Direct Ubuntu interactive operation uses numbered menus unless its optional UI dependency exists.

## Relocation and compatibility

The desktop shortcut points through cmd.exe to V:\dev\tools\app-updater\Manage Software.cmd.
Both .cmd launchers resolve the wrapper relative to themselves; the wrapper resolves Python and
the application relative to the project. The desktop wrapper pauses even after startup failures.

The previous directory is historical; this implementation did not delete or modify it. It was
present during initial review but absent at final verification. If another copy exists, do not run
its old launchers expecting new behavior. The original shortcut was backed up under backups.
Historical logs and backup contents retain their original paths as evidence.

Update-Tools.ps1 and Update CLI Tools.cmd forward to the same safe manager. The old four-tool
default-update behavior is retired. Updater.Core.psm1 and tools.json are historical helpers/data,
not active configuration. No NVM cleanup, PATH changes or connector settings are included.

## Alternatives and validation limits

UniGetUI provides broad package-manager integration and an automation CLI. Topgrade coordinates
update steps. This application keeps a narrower custom layer for paired Windows/Ubuntu inventory,
Vite ownership, explicit discovery and per-installation plans. Neither aggregator is required.

- [UniGetUI](https://github.com/Devolutions/UniGetUI)
- [UniGetUI CLI](https://github.com/Devolutions/UniGetUI/blob/main/docs/CLI.md)
- [Topgrade](https://github.com/topgrade-rs/topgrade)
- [prompt_toolkit](https://python-prompt-toolkit.readthedocs.io/en/stable/)

Tests cover state transitions, offline inventory, failure isolation, version ordering, ownership,
post-update verification, keyboard input and launchers. Real upgrades and GUI installers are not
exercised merely to validate the UI. Endpoint changes can block future checks/plans; these errors
are reported rather than treated as success.
