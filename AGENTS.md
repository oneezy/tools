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
folder `<repo>-<type>-<issue>-<desc>` on branch `<type>/<issue>-<desc>`, or
`<repo>-<type>-<desc>` on `<type>/<desc>` without a ticket. The branch type is one
of feature, fix, research, prototype, wayfinder, chore, docs. Example: folder
`tools-fix-31-picker-speed` on `fix/31-picker-speed`. A worktree Claude makes before
the task is known is `<repo>-new-<n>` on `new/<n>`; rename the branch to
`<type>/<issue>-<desc>` once the task is known and leave the folder name alone. Use
lowercase words separated by hyphens; no IDs or random words. Keep the repository,
branch type and ticket number first; add a numeric suffix only for a collision.

Use the shared `workspace` command in `clis/remote-sessions-cli/remote_sessions.py`
to prepare a named persistent worktree, then start either harness in its returned
`WorkingDirectory`. Preview with `--plan --json` before creating it. See the
[launcher guide](clis/remote-sessions-cli/README.md). If using a native worktree
tool instead, supply this readable name when its API allows it. Keep the task's
display title descriptive too; changing a chat title does not rename its folder.
Do not move existing worktrees or rewrite saved session paths just to rename them.
