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
for a new task name, X stops managed sessions, R refreshes, and Q closes the picker.
A does not select unavailable history or unnamed new tasks. Explicit recovery from
the history view asks before it can create a replacement conversation.

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
Repeated named starts reuse the same task. Existing version-2 `.remote-sessions.json`
state is read directly, including ownership and replacement links. No migration
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

Stopping checks the UUID, native background ID, folder, and start identity. It
never kills a saved PID or adopts stop permission for an externally started agent.
Closing the picker leaves sessions running. Missing folders are restored in place
when their branch can be recovered. Otherwise an explicitly selected recovery can
create a replacement conversation and retain the old history and branch. It cannot
recover lost uncommitted files. No worktree deletion, branch deletion, reset, stash,
push, or transcript rewrite is implemented.

Mutations share an OS file lock and write state atomically. Both PowerShell entry
points now delegate to Python, so there is one lock implementation. Do not run an
old copied PowerShell engine against the same root concurrently.

## Tests

```sh
python3 -m unittest discover -s tests -p test_portable.py -v
```

The portable suite uses a fake Claude executable and real disposable Git repos.
It covers UUID/options continuity, recovery, duplicate prevention, ownership,
read-only previews, worktree names, native path rules, cross-process locks,
argument quoting, and A/Enter picker behavior. `tests/test-linux.sh` copies the
source to a Linux temporary directory and runs the same suite with native Git.
The existing `test-native-lifecycle.ps1`, `test-task-worktrees.ps1`, and
`test-remote-control.ps1` exercise the compatibility entry point on Windows.
`test-picker.ps1` invokes the portable picker regression.

The legacy `task-worktrees.ps1` is retained as a reference during review and is not
loaded by the launcher. The Python implementation is the active worktree engine.
