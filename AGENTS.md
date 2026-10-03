# AGENTS.md

## Workspace

`oneezy/tools` is one pnpm workspace (`pnpm-workspace.yaml`: `packages/*` and `apps/*`). Three tools, one job each; no duplicate orchestration:

- **pnpm** (`packageManager` in the root `package.json`) installs dependencies. `pnpm install` once at the root.
- **Turborepo** (`turbo.json`) runs tasks across packages: `pnpm build`, `pnpm test`, `pnpm check` and `pnpm dev` at the root run every package's script of that name, in dependency order, cached.
- **Vite Plus** (`vp`) is the dev server where a package has one. No package has one yet; the first app under `apps/` adds Vite Plus to its own `package.json`, never to a package without a dev server.

Windows 11 with PowerShell 7 is the primary host: every script is run there first. Linux is a future target, so nothing in a `package.json` may be Windows-only: `scripts/python.mjs` runs Python (`py -3` on Windows, `python3` elsewhere) and `scripts/syntax-check.ps1` runs under pwsh on either.

Each package keeps its language. `packages/skills-sync` (TypeScript, published as `@oneezy/skills-sync`), `packages/skills-viewer` (TypeScript), `packages/remote-sessions` (Python), `packages/task-manager` (PowerShell + bash), `packages/apps-sync` (PowerShell + Python). A Python or PowerShell package has a minimal `package.json` whose `test` and `check` scripts run what the package already had, so Turborepo can run them. `clis/<old-name>/` holds compatibility shims only: every launcher and old path there delegates to its package, so saved shortcuts and documented paths keep working. Do not add code under `clis/`.

## Agent skills

Skills are not committed here. They come from the skills library `oneezy/skills`, linked into the harness user folders by `npx @oneezy/skills-sync` (source: `packages/skills-sync`).

A cloud session (`CLAUDE_CODE_REMOTE=true`) starts without them unless the cloud environment's setup script runs the sync. If `/grilling`, `/oneezy-brain` or another library skill is not in your skill list, run this first, then carry on:

```
npx --yes @oneezy/skills-sync -y --agents claude-code --global --no-projects --no-wsl --quiet
```

Claude Code lists the new skills about a minute later; until then, Read the SKILL.md. Skills marked `disable-model-invocation` (`/wayfinder`, `/grill-me`, `/to-tickets`, `/oneezy-merge` and others) never appear in your list, and in a project thread Justin's "/wayfinder" reaches you as plain text, not a command. When he names one, Read `~/.claude/skills/<name>/SKILL.md` and follow it as if he had run the command.

### Issue tracker

Issues are tracked as GitHub Issues on `oneezy/tools` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Worktree names

Claude and Codex use the same naming convention for new task worktrees:
`<repo>-issue-<number>-<short-description>`, `<repo>-pr-<number>-<short-description>`,
or `<repo>-<short-description>` when no ticket exists. Examples: `brain-issue-2-fix-login`,
`tools-pr-20-session-continuity`. Use lowercase words separated by hyphens. Keep the
repository and ticket number first; add a numeric suffix only for a collision.

Use the shared `workspace` command in `packages/remote-sessions/remote_sessions.py`
to prepare a named persistent worktree, then start either harness in its returned
`WorkingDirectory`. Preview with `--plan --json` before creating it. See the
[launcher guide](packages/remote-sessions/README.md). The old path
`clis/remote-sessions-cli/remote_sessions.py` is a stub that runs the same engine.
If using a native worktree tool instead, supply this readable name when its API allows it.
Keep the task's display title descriptive too; changing a chat title does not rename its
folder. Do not move existing worktrees or rewrite saved session paths just to rename them.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
