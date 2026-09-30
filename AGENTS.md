# AGENTS.md

## Agent skills

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

Use the shared `workspace` command in `clis/remote-sessions-cli/remote_sessions.py`
to prepare a named persistent worktree, then start either harness in its returned
`WorkingDirectory`. Preview with `--plan --json` before creating it. See the
[launcher guide](clis/remote-sessions-cli/README.md). If using a native worktree
tool instead, supply this readable name when its API allows it. Keep the task's
display title descriptive too; changing a chat title does not rename its folder.
Do not move existing worktrees or rewrite saved session paths just to rename them.
