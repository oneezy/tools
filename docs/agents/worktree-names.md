# Worktree naming

When preparing a new task worktree in Claude or Codex, name it after the work:
folder `<repo>-<type>-<issue>-<desc>` on branch `<type>/<issue>-<desc>`, or
`<repo>-<type>-<desc>` on `<type>/<desc>` without a ticket. The branch type is one
of feature, fix, research, prototype, wayfinder, chore, docs. Example: folder
`tools-fix-31-picker-speed` on `fix/31-picker-speed`. A worktree Claude makes before
the task is known is `<repo>-new-<n>` on `new/<n>`; rename the branch to
`<type>/<issue>-<desc>` once the task is known and leave the folder name alone. Use
lowercase words separated by hyphens; no IDs or random words. Keep the repository,
branch type and ticket number first; add a numeric suffix only for a collision.
Avoid opaque bridge IDs and random names when the creation API accepts a name. The
`WorktreeCreate` hook in `clis/remote-sessions-cli/worktree_hook.py` applies this
scheme to every worktree Claude creates once it is installed.

Prefer the shared `workspace` command in the tools repository's
`clis/remote-sessions-cli/remote_sessions.py`; preview with `--plan --json`, then
create after the normal Git proposal. Start Claude or Codex inside the returned
`WorkingDirectory` without requesting another worktree. If the helper is not
available on this host, use the same naming convention with the native creation
API or Git, cutting new branches from local `dev`. Once installed, the
`WorktreeCreate` hook cuts from local `dev` whatever base Claude proposes, so no
per-repo base setting is needed.

Keep the session display title descriptive too. A title and a folder are separate.
Do not rename or move an existing worktree or rewrite saved session paths merely
to improve its name. An app may generate its own directory before an agent runs;
report that limitation rather than claiming its name was controlled.
