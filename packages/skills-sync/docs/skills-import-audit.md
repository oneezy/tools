# Skills import: workflow and release audit

2026-10-17. Initial read-only inventory; not a completed migration or proof of end-to-end release behavior.

## Findings

- The copied Library contains `.github/workflows/library.yml`, `land.yml`, `run.yml` and `task-manager.yml`. These are nested under `packages/skills`, not active root workflows in tools.
- The GitHub API currently lists tools workflows `automerge`, `branches`, `publish-skills-sync`, and `task-manager`. It separately lists skills workflows `land`, `library`, `run`, and `task-manager`, all in active state. Active state is not proof that their latest executions succeeded.
- `packages/skills/skills/oneezy/oneezy-skills/SKILL.md` and `references/changes.md` still dispatch `repos/oneezy/skills/actions/workflows/run.yml` and follow that repository's promotion/release chain. They do not target the copied workflows in tools.
- The copied `land.yml` squashes a branch into dev, promotes dev to main and dispatches library release. Its checkout and checks assume a standalone Library root. Moving it to tools unchanged would change the repository affected by that promotion; this is not authorized by the copy/import or local development work.
- The copied `library.yml` assumes committed generated Plugins/catalogs, standalone paths and the published Skills Sync CLI. The workspace package currently generates ignored output and uses its workspace dependency. This mismatch needs an explicit migration design.
- The nested `task-manager.yml` calls `oneezy/tools/.github/workflows/task-manager.yml@main`; the root file is the reusable implementation. They are not interchangeable duplicates.
- Both trees contain `actions/skills-sync-cli/action.yml`. Their executable content differs: the root copy disables setup-node's package-manager cache, while the nested copy does not. Consolidation must preserve the workspace-compatible behavior.
- The copied `oneezy-merge` skill describes Git merge/promotion and delegates package publication to repository workflows or a release skill. A successful merge/promotion alone does not prove skill plugin distribution from tools is configured.
- `.github/scripts/release.mjs`, `run.sh`, `run-report.mjs` and their tests contain behavior needed by the imported release system. The workspace skills package test script currently names `tests/*.test.mjs` and the capability test, not the copied `.github/scripts/*.test.mjs` tests.

## Investigations to carry into the spec

1. **Preserve merge and release behavior during the skills migration.** Trace skill commands to scripts, workflows, repository destinations, generated output and release consumers. Classify each imported file as keep, relocate/adapt, consolidate, or remove after its replacement is verified. Include the GitHub distribution-destination decision; do not assume it has been settled.
2. **Verify local development plugins in Claude and Codex.** Use the confirmed behavior in `development-plugins.md`. Establish project-only precedence, edit/build/reload, failure behavior and switching back before choosing implementation details.

These are investigation questions, not implementation-ready tickets. Justin subsequently chose the ask-matt main flow: to-spec first, then to-tickets. Carry these questions as explicit verification and migration gates in that spec and its reviewed breakdown; do not publish separate investigation tickets or attach them to an existing map by default.

## Preservation boundary

No files were removed or moved, no workflow was activated, and no GitHub issue or repository setting was changed during this inventory. Preserve the source repository, imported scripts/tests and historical ADRs until replacement paths and consumers are accounted for. Keep local development work separate from authorization to promote main or publish a release.

Evidence: local files above; read-only `GET /repos/oneezy/tools/actions/workflows` and `GET /repos/oneezy/skills/actions/workflows` on the date above.
