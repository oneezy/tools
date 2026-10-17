# AGENTS.md

## Workspace

`oneezy/tools` is one pnpm workspace (`pnpm-workspace.yaml`: `packages/*` and `apps/*`). Vite Plus's global `vp` picks the runtime and the package manager, so there is no nvm and no corepack:

- **Node** is the version in `.node-version` (the newest 24.x LTS). `vp env` installs and switches to it on its own.
- **pnpm** is the version in `packageManager` in the root `package.json`, also through `vp env`. It installs dependencies: `pnpm install` (or `vp install`) once at the root.
- **Vite Plus** (`vite-plus`, the `vp` CLI; docs in `node_modules/vite-plus/docs`) does everything else. At the root, `pnpm build`, `pnpm test` and `pnpm check` run `vp run -r <name>`: every package's script of that name, in workspace dependency order. `pnpm dev` uses cached prerequisite builds, then runs the skills watcher and `apps/skills-viewer-web` together through `vp run --parallel`. Root `pnpm build` enables Vite Plus task caching. A package whose task needs another package built first says so in its own `vite.config.ts` (`run.tasks`, `dependsOn`), as `apps/skills-viewer-web` does for `test` and `check`. `pnpm check` builds the packages the website imports, then runs `vp check`: Oxfmt formatting, Oxlint and type checks for every package's JS/TS, configured once in the root `vite.config.ts` (`fmt`, `lint`; markdown, fixtures and `.github/` are left alone). Run `vp fmt` before committing. Tests in the TypeScript packages use `vp test` (Vitest, imported from `vite-plus/test`). The `vite`/`vitest` overrides in `pnpm-workspace.yaml` keep every package on the copies Vite Plus bundles; bump them with `vite-plus`.

Windows 11 with PowerShell 7 is the primary host: every script is run there first. Linux is a future target, so nothing in a `package.json` may be Windows-only: `scripts/python.mjs` runs Python (`py -3` on Windows, `python3` elsewhere) and `scripts/syntax-check.ps1` runs under pwsh on either.

Each package keeps its language. `packages/skills-sync` (TypeScript, published as `@oneezy/skills-sync`), `packages/skills-viewer` (TypeScript), `packages/remote-sessions` (Python), `packages/task-manager` (PowerShell + bash), `packages/apps-sync` (PowerShell + Python), `apps/skills-viewer-web` (SvelteKit, deployed to Vercel). A Python or PowerShell package has a minimal `package.json` whose `test` and `check` scripts run what the package already had, so `vp run -r` can run them. Every tool lives in its package; there is no `clis/` folder (the compatibility shims were removed), so shortcuts and docs point into `packages/`.

## Agent skills

Skill source lives in the private workspace package `packages/skills`. Edit authored skills under `packages/skills/skills/<group>/<name>`. Skills Sync (`packages/skills-sync`) owns restoring dependencies and installing the local development links. Run `pnpm dev` for the viewer plus watcher, `pnpm skills` for the watcher alone, or `pnpm skills:dev` for one-time installation after `pnpm install`; see `packages/skills/DEVELOPMENT.md`.

For local development, prefer the repository's `.agents/skills/<name>` (Codex) or `.claude/skills/<name>` (Claude) entry over a globally installed plugin copy. These are generated links, not source to commit. Authored edits are immediately visible through the links; start a fresh chat if the harness retains an older skill catalog. The watcher reconciles new, removed, and renamed skill folders automatically. Config/lock changes restore pinned dependencies; unchanged content saves do nothing. Changed external plugin installations still require another `pnpm skills:dev`. This command writes repo-scoped Codex skill exclusions; it does not uninstall global plugins or change their tools. Keep local installation work on this command instead of the published machine-wide `sync`.

A cloud session (`CLAUDE_CODE_REMOTE=true`) without the local development installation still gets the skills from account plugins. The existing cloud setup/status command remains:

```
npx --yes @oneezy/skills-sync@latest status
```

A message starting with `/<name>` explicitly requests that skill. Resolve it through the harness's local skill picker or installed repo skill root. Skills marked `disable-model-invocation` remain explicit-only. If the current chat has not discovered the repository installation, report that and start a fresh chat; do not silently substitute an external plugin copy.

### Issue tracker

Issues are tracked as GitHub Issues on `oneezy/tools`, operated through `gh api` REST calls (never `gh issue` or GraphQL, which cloud sessions block). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: `GLOSSARY-MAP.md` at the root lists each package's `GLOSSARY.md` (and its `docs/adr/`); the root `GLOSSARY.md` holds the words every package shares. See `docs/agents/domain.md`.

### Worktree names

Claude and Codex use the same naming convention for new task worktrees:
`<repo>-issue-<number>-<short-description>`, `<repo>-pr-<number>-<short-description>`,
or `<repo>-<short-description>` when no ticket exists. Examples: `brain-issue-2-fix-login`,
`tools-pr-20-session-continuity`. Use lowercase words separated by hyphens. Keep the
repository and ticket number first; add a numeric suffix only for a collision.

Use the shared `workspace` command in `packages/remote-sessions/remote_sessions.py`
to prepare a named persistent worktree, then start either harness in its returned
`WorkingDirectory`. Preview with `--plan --json` before creating it. See the
[launcher guide](packages/remote-sessions/README.md).
If using a native worktree tool instead, supply this readable name when its API allows it.
Keep the task's display title descriptive too; changing a chat title does not rename its
folder. Do not move existing worktrees or rewrite saved session paths just to rename them.
