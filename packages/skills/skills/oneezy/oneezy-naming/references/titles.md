# Chat titles: checks and rename routes

Read this before setting or changing a chat title. Every marker comes from a fact you checked in this session; a guess becomes ❔, or leaves 🤖 and 🌳 off.

## Checks

- **☁️ cloud**: the session runs on a hosted machine, not Justin's: `CLAUDE_CODE_REMOTE=true` in a Claude cloud session, or the host's own context says it is a cloud task.
- **🌐 SSH**: `SSH_CONNECTION` or `SSH_TTY` is set.
- **💻 Justin's computer**: a local session with neither of the above.
- **✴️ Claude Code**: `CLAUDECODE=1` is set, or the chat was imported from Claude Code.
- **🤖 subagent**: another agent dispatched this session; its task came from that agent, not from Justin.
- **🌳 worktree**: `git rev-parse --path-format=absolute --git-dir` differs from `git rev-parse --path-format=absolute --git-common-dir`, or `git worktree list` names this directory as a linked worktree. A folder named `worktrees` or an app-generated folder name proves nothing on its own.

## Rename routes

Discover the route in this session's tool list (search deferred tools when the host defers them); use the tool's real name and schema. A title tool that targets another thread renames that thread, not this one.

- **Claude Code**: some apps give the agent a session-title tool; use it when it is listed. In the terminal, `/rename <title>` is Justin's command, so propose the `Title:` line.
- **Codex and ChatGPT**: the session-renaming tool or command the app exposes.
- **Any other host**: propose the `Title:` line.
