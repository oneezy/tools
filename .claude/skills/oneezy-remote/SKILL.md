---
name: oneezy-remote
description: Start, resume, stop or list remote Claude threads through the remote-sessions tool. "start a new thread for issue 18", "stop all threads".
disable-model-invocation: true
argument-hint: "start a new thread for <task> [issue N] | start all | resume <thread> | stop <thread> | stop all | status"
---

Invoking this skill is Justin's word to run the command it maps to. A **thread** is Justin's word for a Claude session. Every thread here is a background session that can be reached through Remote Control.

## The tool

Run the main checkout's engine, which tracks `dev`, never a worktree's copy:

- Windows: `py -3 V:/dev/tools/clis/remote-sessions-cli/remote_sessions.py`
- Linux: `python3 ~/dev/tools/clis/remote-sessions-cli/remote_sessions.py`

The README beside the engine, and `--help`, own the flags and behavior. Always pass `--json`. Every mutation takes `--only <repo…>`: the repo Justin names, else the repo of the current working directory. "All" means every repo that `status --json` reports.

## Map the request

| Justin says | Command |
|---|---|
| start a new thread for `<task>` [issue N / PR N] [in `<repo>`] | `start --only <repo> --task <slug> [--issue N / --pr N]` |
| start all threads [in `<repos>`] | `start --only <repos>`: with no task, resumes each repo's managed or newest thread |
| resume `<thread>` | `resume --only <repo> --session-id <uuid>` |
| stop `<thread>` | `stop --only <repo> --session-id <uuid>` |
| stop all threads [in `<repos>`] | `stop --only <repos>` |
| status, list threads | `status` (add `--only` to narrow it) |
| a folder only, for Codex | `workspace --only <repo> --task <slug> [--issue N / --pr N]` |

- **Slug:** the short lowercase task words Justin gave (`sizing-skill`).
- **Ticket numbers:** go in `--issue` or `--pr` only when Justin names them.
- **Resolving a thread:** a thread named by title or partial ID resolves to its full UUID through `status --json`. When two match, ask which one.

## Steps

1. **Preview.** Run the mapped mutation with `--plan`. The step is done when the plan matches the request:
   - Mode `new` for a new thread.
   - Mode `resume` or `running` for an existing thread.
   - For a stop, the plan lists the threads meant.

   If the plan shows Mode `new` for a resume, or names a replacement, show it to Justin instead of running it.
2. **Run** the same command without `--plan`.
3. **Confirm the bridge.** When a started thread has no `RemoteUrl`, read `status --json` once more for its SessionId.
4. **Report** one short block per thread: task, SessionId, folder, Remote URL (or "no bridge yet") and state.
   - State `blocked` means the thread is waiting on a prompt, usually folder trust. Tell Justin to open the Remote URL or run `claude attach <first 8 characters of the id>`.
   - A stop report names each stopped thread and says its history and worktree are kept.
   - `stop` currently stops only threads the tool started and confirmed. Report the others as not stopped (ticket #31 lifts this).
