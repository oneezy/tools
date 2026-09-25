# Claude sessions on Windows and Linux

The implementation is Python 3.10+ and uses only the standard library. Git and a
Claude Code CLI with native background sessions must be installed on the host.
No pip packages, PowerShell, or Bash are required by the Python engine.

## Open the picker

Windows: double-click `remote-control.cmd`. Existing `.ps1` entry points remain
compatible and pass errors back to the caller.

Linux: `sh remote-control.sh`, or `python3 remote_sessions.py`.

Default project root: `V:\dev` on Windows when it exists, otherwise `~/dev`.
Override it with `--root` or `REMOTE_PROJECTS_ROOT`. Run each host against its own
native checkout and Claude login. WSL uses Linux paths and Linux Claude; it does
not manage the Windows Claude processes. Do not share one state file across hosts.

The picker lists every Claude session under each project folder, whichever surface
started it: task worktrees and the repo root alike. It joins four sources:

- `claude agents --json --all` for live state (`working`/`idle`/`busy`/`stopped`)
- Claude's per-pid session files (`<config>/sessions/<pid>.json`) for the surface
  running a live session (`entrypoint`) and its Remote Control registration
  (`bridgeSessionId`), plus its permission mode and Claude version when recorded
- transcripts for history, title, the surface a session started on (its first
  `entrypoint`, or `teleportedFrom` for a session teleported from the web), the
  Claude version and the permission mode
- the desktop app's session store (`claude-code-sessions` under the app's data
  folder; `--desktop-sessions` overrides it), which marks Desktop sessions and
  supplies archived ones, which are hidden

Table columns: `Status | Repo | Task | Source | Branch | Last active | Remote`.

| Status | Meaning |
|---|---|
| 🟢 working | a background session is working |
| 🟡 idle | a background session is waiting for you (Claude's state `idle`, `blocked` or `done`) |
| 🔵 stopped | resumable: the newest conversation in its folder, or a task the picker tracks |
| 🟣 live | live in another app (VS Code, the desktop app, a terminal); view-only |
| ⚪ new | a project with no session yet; N or Enter names a new task |
| ⚫ history | an older conversation in the same folder, or one that cannot resume, such as a worktree whose checkout is missing |
| 🔴 error | a background session that failed or waits on a permission decision, or history whose folder metadata conflicts; shown without H |
| ✅ merged | its work merged, awaiting folder removal (reserved for the cleanup sweep; nothing sets it yet) |

Remote shows 📡 only when the live process has a Remote Control registration.
Source is what runs a session now: CLI, Background (`--bg`, which records entrypoint
`cli`), VS Code ext, Desktop, RC server (spawned by `claude remote-control`, entrypoint
`sdk-cli`). A stopped session shows where it started instead, including Web for a
teleported session.
The detail pane under the table shows the folder, remote URL, session ID,
permission mode, Claude version, where the session started and what runs it now.
Columns are measured in terminal cells, so emoji and wide titles keep them aligned
in Windows Terminal.

Opening the picker starts nothing. H shows history rows. Space checks a row, A
checks every resumable or running row, Enter resumes the checked rows, N asks for a
new task name, X stops the checked background sessions, R refreshes, and Q closes
the picker. A row live in another app is view-only: it cannot be checked, resumed or
stopped. A session whose folder was deleted, or that was archived in the desktop app,
is not listed at all, and nothing recreates it.

The picker loads fast: each transcript's metadata and each desktop store file are
cached by path, modification time and size, so a refresh re-parses only files that
changed.

Task titles, folders, session IDs, and remote URLs are shown separately. Titles
come from launcher task names, native agent names, or explicit saved Claude titles.
Folder names remain a fallback for older conversations without a title. Existing
folders and app sidebar entries are not renamed or removed.

## Commands

Use `python` on Windows and `python3` on Linux. These examples work from this folder:

```sh
python3 remote_sessions.py status --json
python3 remote_sessions.py sessions --only brain --json
python3 remote_sessions.py start --only brain --task fix-login --issue 2 --plan --json
python3 remote_sessions.py start --only brain --task fix-login --issue 2 --json
python3 remote_sessions.py resume --only brain --session-id FULL-UUID --json
python3 remote_sessions.py stop --only brain --session-id FULL-UUID --json
```

`--plan` previews without fetching, updating state, or creating worktrees. Mutation
commands require `--only`. Use `--only brain tools` or `--only brain,tools`. Legacy
PowerShell spellings such as `-Only`, `-SessionId`, `-Task`, `-Plan`, and `-Json` are
accepted. `--config` selects a Claude configuration directory. `--claude` selects
its executable. `--desktop-sessions` selects the desktop app's session store. Repo-root
sessions are always listed; `--include-project-sessions` is still accepted and does nothing.
`status --json` rows carry `Status`, `Circle`, `Source`, `Origin`, `Remote`, `ViewOnly`,
`PermissionMode` and `ClaudeVersion`. `resume --session-id` on a session live in another
app is refused as view-only, like `stop`.

`start` without a task name resumes managed tasks, or the newest available saved
conversation per folder. Creating the first task now requires a descriptive name.
Repeated named starts reuse the same task. A named start for a task whose folder
was deleted is refused; choose a new task name. Existing version-2
`.remote-sessions.json` state is read directly. Its old `Ownership` and `StartedAt`
fields are ignored, so a session recorded as `pending` can be stopped. No migration
of transcript files is performed.

## Shared names for Claude and Codex

The shared worktree command creates a folder without starting either agent:

```sh
python3 remote_sessions.py workspace --only brain --issue 2 --task fix-login --plan --json
python3 remote_sessions.py workspace --only brain --issue 2 --task fix-login --json
python3 remote_sessions.py workspace --only tools --pr 20 --task session-continuity --json
```

These produce `brain-issue-2-fix-login` and `tools-pr-20-session-continuity`. A PR or
issue number alone is also accepted, for example `brain-pr-20`. New branch names
start with `codex/`. The prefix is a branch convention, not ownership by Codex.
A numeric suffix is added only when a collision or stale registration requires it.
Ticket titles are supplied with `--task`; the launcher does not guess titles or
claim GitHub issues.

Both harnesses use the same Git worktree under `<repo>/.claude/worktrees/<name>`.
The `.claude` parent keeps existing Claude session discovery compatible; it does
not restrict the folder to Claude. Start Claude from the returned `WorkingDirectory`
using the returned `Commands.Claude` arguments, or start Codex with `Commands.Codex`,
which includes `-C` and that directory. The helper itself does not start Codex or
manage its Remote Control service. Do not add a second `--worktree` flag.

For an existing branch, supply `--branch feature/existing`. Its usable worktree is
reused; an unregistered retained branch can be restored at its existing commit.
New branches use `dev`. When origin exists, creation fetches it and fast-forwards
local dev safely. Dirty or divergent dev checkouts needing reconciliation fail
without overwriting work. Main is never switched or changed.

Use the same name when an agent calls a native API that accepts a worktree name.
Applications that create a folder before the agent runs may choose their own name.
There is no common Claude/Codex setting that this tool can use to rename every
app-created folder. Existing `bridge-cse_*` paths stay in place to preserve saved
conversation locations. Renaming a chat changes its display title, not its folder.

## Remote Control and continuity

In an already-open Claude conversation, `/remote-control brain-issue-2-fix-login`
connects that conversation with a readable remote title. It carries its history.
See [Remote Control from an existing session](https://code.claude.com/docs/en/remote-control#from-an-existing-session).
The Desktop toggle does not combine all conversations into one remote session.

The launcher starts new Claude tasks with `--bg --remote-control NAME`. An existing
native background task resumes with only `--bg --resume FULL-UUID`, preserving saved
options. Overriding its options can make Claude create a copy. For a stopped saved
conversation not yet registered as a background task, the first resume also enables
Remote Control. An active matching UUID or a detected active conversation in the
same directory is left alone. Detection depends on `claude agents --json --all`;
this is not a complete reconciliation of Desktop's separate session list.

`Running` is local process state. `RemoteRegistered` means a matching process has a
bridge registration, which can be stale. The output explicitly says delivery is
unverified. It never claims a phone is connected just because a process resumed.
If no bridge appears, use `claude attach SHORT-ID` and inspect `/remote-control`.
Handle any authentication or workspace trust prompt there. The launcher does not
change credentials, workspace trust, or permission settings.

A resume continues the same session ID in its original folder. After a launch the
engine waits up to `--launch-wait` (`-LaunchWait`) seconds (default 90) for
`claude agents` to list the session. It adopts the requested ID, or the copy Claude
reports (a UUID in its output, or the one new background session in that folder).
A slow launch is not an error: the result says it is not listed yet, and it is
stoppable once it appears. If Claude printed one session ID, besides the requested
one, that it lists nowhere yet, the state follows that ID at once but marks it
unconfirmed. Until a launch is confirmed, the next `start` or `resume` settles it:
it confirms the ID once Claude lists it, or else adopts the one untracked background
session running in that folder, or failing that the one conversation saved there
since the launch. An older conversation in the folder is never taken over. `status`
shows the same adoption but does not save it. So a slow launch never leaves a
phantom row behind. A printed ID that Claude lists in another folder is never adopted.

One stop rule, with no ownership check: every background session in a selected
project can be stopped, whoever started it. A session live in another app (an
interactive session in VS Code, the desktop app or a terminal) is view-only; the
engine never stops it and never kills a saved PID. `stop --only brain` stops every
background session in brain; `--session-id` stops just that one, and a saved ID
that continued as a copy stops the copy. A `--session-id` that runs outside the
selected projects, or that the selected projects have never seen, is an error
rather than "already stopped".

A session follows its folder. The branch shown is whatever the folder has checked
out now (none on a detached HEAD, never a stale saved branch), and mutating commands
update the saved state to match. State records a new task only once its folder
exists, so a recorded session whose folder is gone was deleted. It is hidden, and
the engine never recreates the folder, never makes a `recovered-<id>` worktree and
never starts a replacement conversation. Closing the picker leaves sessions running.
No worktree deletion, branch deletion, reset, stash, push, or transcript rewrite is
implemented.

Transcript metadata is cached per file (path, modification time and size) for the
life of one process. An open picker's refresh re-parses only changed transcripts;
each CLI call and each new picker starts with an empty cache.

Mutations share an OS file lock and write state atomically. Both PowerShell entry
points now delegate to Python, so there is one lock implementation. Do not run an
old copied PowerShell engine against the same root concurrently.

## Tests

```sh
python3 -m unittest discover -s tests -p test_portable.py -v
```

The portable suite uses a fake Claude executable and real disposable Git repos.
It covers the four-source inventory (Source labels per surface, status circles, the
Remote column, archived desktop sessions), view-only rows, emoji column alignment
and the detail pane in captured picker output, UUID/options continuity, hidden
deleted folders, slow and copied launches,
the stop rule, branch-follows-folder, the transcript cache, duplicate prevention,
read-only previews, worktree names, native path rules, cross-process locks,
argument quoting, and A/Enter picker behavior. `tests/test-linux.sh` copies the
source to a Linux temporary directory and runs the same suite with native Git.
The existing `test-native-lifecycle.ps1`, `test-task-worktrees.ps1`, and
`test-remote-control.ps1` exercise the compatibility entry point on Windows.
`test-picker.ps1` invokes the portable picker regression.

The legacy `task-worktrees.ps1` is retained as a reference during review and is not
loaded by the launcher. The Python implementation is the active worktree engine.
