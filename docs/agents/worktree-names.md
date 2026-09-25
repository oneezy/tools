# Worktree naming

When preparing a new task worktree in Claude or Codex, name it after the work:
`<repo>-issue-<number>-<short-description>`, `<repo>-pr-<number>-<short-description>`,
or `<repo>-<short-description>` without a ticket. Examples: `brain-issue-2-fix-login`
and `tools-pr-20-session-continuity`. Use lowercase hyphenated words, with the
repository and ticket number first. Avoid opaque bridge IDs and random names when
the creation API accepts a name. Add a numeric suffix only for a collision.

Prefer the shared `workspace` command in the tools repository's
`clis/remote-sessions-cli/remote_sessions.py`; preview with `--plan --json`, then
create after the normal Git proposal. Start Claude or Codex inside the returned
`WorkingDirectory` without requesting another worktree. If the helper is not
available on this host, use the same naming convention with the native creation
API or Git, following the existing dev-branch rules.

Keep the session display title descriptive too. A title and a folder are separate.
Do not rename or move an existing worktree or rewrite saved session paths merely
to improve its name. An app may generate its own directory before an agent runs;
report that limitation rather than claiming its name was controlled.
