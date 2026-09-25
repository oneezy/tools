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
native checkout and Claude login. Do not share one state file across hosts.

### WSL distros

On Windows the picker also lists the live Claude sessions of every running WSL
distro. It runs `wsl --list --verbose` (about 50 ms), which never starts a distro.
For each running distro it runs one login-shell command inside it (`wsl -d <distro>
--exec sh -lc ...`) that prints `claude agents --json --all` and the distro's per-pid
session files (`${CLAUDE_CONFIG_DIR:-~/.claude}/sessions/*.json`) between two marker
lines, so whatever the login profile or logout script prints is ignored. A distro
without Claude on its login `PATH` contributes nothing.

- Rows read `WSL · <surface>` in Source (`WSL · CLI`, `WSL · Background`,
  `WSL · VS Code ext`, ...). Repo is the folder above `.claude/worktrees`, or the
  session folder's own name; `--only` filters them by that name. The detail pane
  shows `host WSL <distro>` and `on another host; view-only`.
- WSL rows are view-only: the Windows picker never resumes or stops them, and N on
  one starts nothing (start a task with the picker inside that distro).
- A stopped distro is never booted. The header shows `WSL <distro>: stopped · W to
  scan`, and W boots and scans it. With several stopped distros, W asks which one
  (blank boots them all). A distro that cannot be scanned shows its error in the
  header instead.
- `status` prints the same notes on stderr, one per line, so `status --json` keeps its
  shape and a script can still tell a stopped or failed distro from an empty one.
- Cost: every refresh and every `status` runs `wsl --list --verbose` and one in-distro
  command per running distro, about a second each. A running distro that does not
  answer in 10 s becomes a `no answer in 10 s` header note; a boot by W may take 60 s.
  Nothing is cached yet. The open picker's 3-second check never looks inside a
  distro, so a WSL change shows on R, on W, or when a Windows change starts a full
  read; that read, like W's boot, runs off the key loop.
- Distro states are read as the English words `Running` and `Stopped` that
  `wsl --list --verbose` prints. On a Windows display language that translates them,
  no distro is scanned and none shows a header note.
- Docker Desktop's own `docker-desktop*` distros are ignored.
- `--wsl` (`-WslExecutable`) selects the `wsl` executable; `--wsl ''` turns WSL
  scanning off. On Linux there is nothing to scan. Run the engine inside the distro
  itself to manage its sessions there.

The picker lists every Claude session under each project folder, whichever surface
started it: task worktrees and the repo root alike. It joins four sources:

- `claude agents --json --all` for live state (`working`/`idle`/`busy`/`stopped`)
- Claude's per-pid session files (`<config>/sessions/<pid>.json`) for the surface
  running a live session (`entrypoint`) and its Remote Control registration
  (`bridgeSessionId`), plus its permission mode and Claude version when recorded
- transcripts for history, title, the surface a session started on (its first
  `entrypoint`, with `sessionKind: bg` on that record for a `--bg` launch, or
  `teleportedFrom` for a session teleported from the web), the
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
teleported session and Background for a `--bg` launch.
The detail pane under the table shows the folder, remote URL, session ID,
permission mode, Claude version, where the session started and what runs it now.
Columns are measured in terminal cells, so emoji and wide titles keep them aligned
in Windows Terminal.

Opening the picker starts nothing. H shows history rows. Space checks a row, A
checks every resumable or running row, Enter resumes the checked rows, N asks for a
new task's branch type, issue number and description (the same names the `WorktreeCreate`
hook gives, below), X stops the checked background sessions, R refreshes, W boots and
scans a stopped WSL distro, and Q closes
the picker. A row live in another app is view-only: it cannot be checked, resumed or
stopped. A session whose folder was deleted, or that was archived in the desktop app,
is not listed at all, and nothing recreates it.

The picker loads fast: each transcript's metadata and each desktop store file are
cached by path, modification time and size, so a refresh re-parses only files that
changed.

The open picker refreshes itself. About every 3 seconds it checks file times, never
file contents: the modification times of the project root, the transcript folders and
each project's `.claude/worktrees`, and the time and size of every file in Claude's
per-pid `sessions` folder and in the desktop store. The check costs about 15 ms on a
typical machine and never runs Claude or Git; it walks the desktop store as the full
read does, so it grows with that store. Only when something changed does it read
the full inventory again, so new sessions appear, removed worktrees disappear and
statuses update without a keypress. With nothing changing, no `claude agents` call is
made between checks. The full read runs off the key loop, so arrow keys and Space
keep working while it loads. The cursor stays on the same session when rows move. If
a live refresh fails for any reason, the picker keeps its rows and says so in red
until a refresh succeeds. R reads the full inventory at once, or, if a read is already
running, again as soon as it finishes. A branch switched inside an existing folder
shows at the next full read, not on its own.

Live status updates rest on one observation of real Claude (2.1.x): a live session
rewrites its own `sessions/<pid>.json` when its status changes. A Claude version that
changes a status only in `claude agents` leaves the circle stale until the next full
read; press R.

Task titles, folders, session IDs, and remote URLs are shown separately. Titles
come from launcher task names, native agent names, or explicit saved Claude titles.
Folder names remain a fallback for older conversations without a title. Existing
folders and app sidebar entries are not renamed or removed.

## Commands

Use `python` on Windows and `python3` on Linux. These examples work from this folder:

```sh
python3 remote_sessions.py status --json
python3 remote_sessions.py sessions --only brain --json
python3 remote_sessions.py start --only brain --type fix --issue 2 --task login --plan --json
python3 remote_sessions.py start --only brain --type fix --issue 2 --task login --json
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
python3 remote_sessions.py workspace --only brain --type fix --issue 2 --task login --plan --json
python3 remote_sessions.py workspace --only brain --type fix --issue 2 --task login --json
python3 remote_sessions.py workspace --only tools --type chore --task session-continuity --json
```

These produce folder `brain-fix-2-login` on branch `fix/2-login`, and
`tools-chore-session-continuity` on `chore/session-continuity`. The naming scheme is
folder `<repo>-<type>-<issue>-<desc>` on branch `<type>/<issue>-<desc>`; the issue
or the description may be left out. The **branch type** (see `CONTEXT.md`; not a
ticket's Type) is one of feature, fix, research, prototype, wayfinder, chore, docs.
Without `--type` the branch type is `feature`: `--task` is only a description and
never supplies a type, so `--task fix-login` is `feature/fix-login`, as picker N with
a blank type gives. `--type` alone is refused: give it `--task`, `--issue` or `--pr`.
`--pr` takes the issue number's place. No `codex/` prefix is used. `--branch` keeps
its own spelling; given alone it also names the folder, so `--branch codex/foo` is
folder `brain-codex-foo`. A task is identified by its branch, the one it has or the
one it asked for when a collision gave it a suffix. So `--type docs --issue 31 --task
speed` never resumes the `fix/31-speed` task, and `--branch fix/31-speed` resumes the
task that `--type fix --issue 31 --task speed` made.
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

## WorktreeCreate hook

`worktree_hook.py` is a Claude Code `WorktreeCreate` hook. Installed in user
settings, it replaces Claude's own worktree creation for `claude --worktree`,
subagents with `isolation: "worktree"`, and background sessions. Claude sends the
hook JSON on stdin (`cwd` and the requested `name`); the hook creates or reuses the
worktree and prints its absolute path as the last stdout line. Git output and errors
go to stderr, and any failure exits non-zero, which aborts the creation.

- A name that starts with a branch type is a named task: `fix-31-picker-speed` (or
  `fix/31-picker-speed`) becomes folder `<repo>-fix-31-picker-speed` on branch
  `fix/31-picker-speed`, the same names the picker's N gives.
- Any other name, such as Claude's generated `bold-oak-a3f2` or a typed
  `picker-speed`, becomes `<repo>-new-<n>` on branch `new/<n>`, n one above the
  highest number any `<repo>-new-*` folder or `new/*` branch in that repo uses, and
  the hook says so on stderr. The hook cannot tell a typed name from a generated one,
  so start a typed name with its branch type to keep it. Rename the branch to
  `<type>/<issue>-<desc>` once the task is known; the folder keeps its name.
- Nothing is fetched and the proposed base is ignored. New branches are cut from
  local `dev`; in a repo with no local `dev`, from `origin/dev`, else from HEAD. A
  branch that only origin has starts at its last-fetched `origin/<branch>`, which may
  be stale. The picker, by contrast, fetches and fast-forwards `dev` first.
- Requests in one repo are serialised by a lock in its Git directory, so parallel
  subagents with `isolation: "worktree"` each get their own `new/<n>`. An unnamed
  request never shares an existing worktree; it fails instead. The picker and the
  CLI take the same lock and plan again under it, so when the hook made a worktree
  for the same branch in the meantime, they reuse it.
- One worktree per branch: a request for a branch that is already checked out
  prints that worktree's path, and a branch that exists but is not checked out gets
  a worktree at its own commit. `dev` resolves to the main checkout when it has `dev`
  checked out and is refused otherwise; `main` is always refused.
- Folders go under the main checkout's `.claude/worktrees`, also when the request
  comes from inside a linked worktree. `.worktreeinclude` is not processed.

Install by adding it to `~/.claude/settings.json`. The single `command` string runs
the same way under Git Bash (Claude's default hook shell on Windows) and PowerShell;
forward slashes keep the path valid in both:

```json
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command", "command": "py -3 \"V:/dev/tools/clis/remote-sessions-cli/worktree_hook.py\"" } ] }
    ]
  }
}
```

On Linux use `"command": "python3 \"$HOME/dev/tools/clis/remote-sessions-cli/worktree_hook.py\""`.
Check which surfaces honour it by hand: `claude --worktree`, a background session,
`claude remote-control --spawn worktree`, and a desktop-app worktree. When a session
on a reused worktree ends, Claude's own cleanup may offer to remove that worktree;
keep it while another session still uses it.

## Remote Control and continuity

In an already-open Claude conversation, `/remote-control brain-fix-2-login`
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
python3 -m unittest discover -s tests -v
```

The portable suite uses a fake Claude executable and real disposable Git repos.
It covers the four-source inventory (Source labels per surface, status circles, the
Remote column, archived desktop sessions), view-only rows, emoji column alignment
and the detail pane in captured picker output, UUID/options continuity, hidden
deleted folders, slow and copied launches,
the stop rule, branch-follows-folder, the transcript cache, duplicate prevention,
read-only previews, worktree names, native path rules, cross-process locks,
argument quoting, and A/Enter/N picker behavior. Live refresh is driven by scripted
picker keys where time passes with no key: a session added or a worktree removed
shows without a keypress, a status change updates its circle, no `claude agents`
call is made while nothing changes, the cursor keeps its session, keys work while a
slow refresh loads, a failed refresh (including an unexpected error such as a junk
agent row) keeps the rows, and R pressed during a refresh reads again after it. The
real key waits (console polling on Windows, `select` on POSIX) and the 3-second
timing are not driven by the suite. `tests/test_worktree_hook.py` feeds
the hook Claude's input JSON in a temporary repo with a `dev` branch, directly and
through Git Bash and PowerShell, and checks names, the cut from local `dev` without
a fetch, the printed path as UTF-8, reuse, refusals, the stderr note for a name
without a branch type, and parallel requests. `tests/test_agent_rules.py` checks that
every `oneezy-merge` copy in the repo is identical, that its land mode keeps
`prototype/*` branches and deletes the rest, and that no `AGENTS.md` or `CLAUDE.md`
overrides a skill's branch retention; it skips when the suite runs from a copy.
A fake `wsl` (`tests/fake_wsl.py`) covers WSL rows, the stopped-distro header, W,
login-shell noise, a wedged distro, and, where a POSIX `sh` is on `PATH`, the
in-distro scan command run in a real shell. `tests/test-linux.sh` copies the source
to a Linux temporary directory and runs the same suite with native Git.
The existing `test-native-lifecycle.ps1`, `test-task-worktrees.ps1`, and
`test-remote-control.ps1` exercise the compatibility entry point on Windows.
`test-picker.ps1` invokes the portable picker regression.

The legacy `task-worktrees.ps1` is retained as a reference during review and is not
loaded by the launcher. The Python implementation is the active worktree engine.
