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

The picker has aligned, colored columns and scrolls to fit the terminal. It shows
available tasks first. H includes unavailable history; opening the picker starts
nothing. Space selects, A selects available existing tasks, Enter resumes, N asks
for a new task name, X stops background sessions, R refreshes, and Q closes the picker.
A does not select unavailable history or unnamed new tasks. A session whose folder
was deleted is not listed at all, and nothing recreates it.

The picker loads fast: each transcript's metadata is cached by path, modification
time and size, so a refresh re-parses only transcripts that changed.

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
its executable. `--include-project-sessions` also includes project-root history.

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
engine waits up to `--launch-wait` seconds (default 90) for `claude agents` to list
the session. It adopts the requested ID, or the copy Claude reports (a UUID in its
output, or the one new background session in that folder). A slow launch is not an
error: the result says it is not listed yet, and it is stoppable once it appears.

One stop rule, with no ownership check: every background session in a selected
project can be stopped, whoever started it. A session live in another app (an
interactive session in VS Code, the desktop app or a terminal) is view-only; the
engine never stops it and never kills a saved PID. `stop --only brain` stops every
background session in brain; `--session-id` stops just that one.

A session follows its folder. The branch shown is whatever the folder has checked
out now, and mutating commands update the saved state to match. A session whose
folder is gone is hidden; the engine never recreates the folder, never makes a
`recovered-<id>` worktree and never starts a replacement conversation. Closing the
picker leaves sessions running. No worktree deletion, branch deletion, reset,
stash, push, or transcript rewrite is implemented.

Mutations share an OS file lock and write state atomically. Both PowerShell entry
points now delegate to Python, so there is one lock implementation. Do not run an
old copied PowerShell engine against the same root concurrently.

## Tests

```sh
python3 -m unittest discover -s tests -p test_portable.py -v
```

The portable suite uses a fake Claude executable and real disposable Git repos.
It covers UUID/options continuity, hidden deleted folders, slow and copied launches,
the stop rule, branch-follows-folder, the transcript cache, duplicate prevention,
read-only previews, worktree names, native path rules, cross-process locks,
argument quoting, and A/Enter picker behavior. `tests/test-linux.sh` copies the
source to a Linux temporary directory and runs the same suite with native Git.
The existing `test-native-lifecycle.ps1`, `test-task-worktrees.ps1`, and
`test-remote-control.ps1` exercise the compatibility entry point on Windows.
`test-picker.ps1` invokes the portable picker regression.

The legacy `task-worktrees.ps1` is retained as a reference during review and is not
loaded by the launcher. The Python implementation is the active worktree engine.
