# Claude sessions on this Windows PC

This launcher resumes saved Claude Code CLI conversations in their existing local worktrees. It does not launch Claude Desktop or create a replacement conversation when a folder is missing.

## Double-click

Open `V:\dev\tools\clis\remote-sessions-cli\remote-control.cmd`.

- Arrow keys move through saved conversations. The selected conversation's folder appears below the list.
- Space selects a conversation; A selects or clears all available conversations.
- Enter resumes selected conversations. Running conversations are left running.
- X stops selected sessions that this launcher owns, retaining their history and files.
- R refreshes; Q exits. Closing this picker does not stop background sessions.

The picker lists conversations, so a project can have several rows. A missing-worktree row means the transcript exists but the old checkout cannot currently be resumed. It is never replaced automatically.

## From a phone conversation connected to this PC

Ask ChatGPT: "Show my Claude sessions", "Start my saved Tools Claude sessions", or "Stop my Tools Claude sessions and keep the worktrees". The agent can run these commands through the connected Windows host without opening a terminal window:

```powershell
$launcher = 'V:\dev\tools\clis\remote-sessions-cli\remote-control.ps1'
& $launcher status -Json
& $launcher sessions -Only tools -Json
& $launcher start -Only tools -Json
& $launcher stop -Only tools -Json
```

For one exact conversation:

```powershell
& $launcher resume -Only tools -SessionId 'FULL-SAVED-UUID' -Json
& $launcher stop -Only tools -SessionId 'FULL-SAVED-UUID' -Json
```

Read `sessions` first to obtain the full UUID. `-Plan -Json` previews start/resume/stop. `-Only tools,skills` selects several projects. Mutation commands require explicit projects. `-IncludeProjectSessions` includes conversations started at project roots; worktrees are the default.

`start` resumes the launcher's previously selected conversations for each project. On first use, it selects the newest available conversation per existing worktree. Use the picker or exact `resume` to choose another saved conversation. No command here invents a new conversation when an old one is unavailable.

`Running` reports native process state. `RemoteRegistered` means the matching local process has a remote bridge registration; it does not prove a phone message was delivered. A resumed background session retains its saved remote settings. If those settings did not enable Remote Control, the launcher reports the missing bridge rather than changing options and copying the conversation.

## Starting genuinely new work

Use one local worktree and one conversation per independent task. Ask the connected agent to create a named task worktree from updated `dev`, then start Claude Code there with Remote Control. This is separate from resuming existing work.

Follow the repository's Git rules: fetch origin, fast-forward local `dev`, preserve dirty files, and create a new branch/worktree from `dev`. Do not assume Claude's default worktree base is `dev`. Once the new conversation has a saved transcript under `<project>\.claude\worktrees\<task>`, this picker discovers it. The launcher itself does not create branches or push changes.

For desktop conversation access to these background CLI sessions, run `claude agents` or `claude attach SHORT_ID`. Use the same remote conversation in Claude on the phone. Opening a fresh task in another interface creates separate conversation state, even when it uses the same repository.

## Why the implementation changed

The previous launcher remembered wrapper process IDs. That was insufficient to identify saved conversations and unsafe when Windows reused a process ID. This version uses the installed Claude CLI's native background manager, full conversation UUID, exact working directory, and native run identity.

First resume uses `claude --bg --resume UUID --remote-control NAME`. A previously registered background conversation resumes with only `claude --bg --resume UUID`, preserving its original options. In the installed CLI, overriding those options can create a copy. Stop uses `claude stop ID` only after checking the full saved identity and ownership. It never kills an arbitrary PID.

State is stored in `V:\dev\.remote-sessions.json`. History remains in the existing Claude configuration directory. The old `.remote-control.json` is left intact and its old PIDs are not trusted. Status and preview do not update launcher state. Mutations use a lock and atomic state replacement. No workspace trust settings, antivirus settings, credentials, WSL processes, or permissions are changed.

The computer must be online and awake, with ChatGPT available for phone-to-PC commands. A Windows shutdown stops Claude processes; asking the connected agent to start saved sessions restores their conversation identity. There is no new automatic login job for Claude. App authentication and permission requests may still need your input.

## Verification

Run from this directory:

```powershell
pwsh -NoProfile -File .\test-remote-control.ps1
pwsh -NoProfile -File .\test-native-lifecycle.ps1
```

Tests use an isolated fake CLI and disposable folders. They cover exact identity, copy-sensitive restarts, foreign ownership, failure handling, missing history, and read-only status/preview. Live verification also stopped and resumed the original Tools conversation in its original worktree using Claude Code 2.1.280.

Native background session behavior: [Claude agent view](https://code.claude.com/docs/en/agent-view#manage-sessions-from-the-shell). Worktree base behavior: [Claude worktrees](https://code.claude.com/docs/en/worktrees).
