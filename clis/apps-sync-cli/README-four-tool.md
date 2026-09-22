# Legacy four-tool entry point

The former automatic Codex/Claude/Vite Plus/pnpm updater is retired.
Update-Tools.ps1 and Update CLI Tools.cmd launch the local-first application in [README.md](README.md).
-CheckOnly performs local inspection; it does not query releases.

Use Check latest explicitly, select Windows/Ubuntu installations, and approve the plan.
Updater.Core.psm1 and tools.json are historical helpers, not active configuration.
software-catalog.json is the single current catalog. Pre-change files remain in backups.
