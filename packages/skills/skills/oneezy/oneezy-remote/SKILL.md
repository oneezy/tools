---
name: oneezy-remote
description: Start, resume, stop or list remote Claude threads through the remote-sessions tool. "start a new thread for issue 18", "stop all threads".
disable-model-invocation: true
argument-hint: "start a new thread for <task> [issue N] | start all | resume <thread> | stop <thread> | stop all | status"
---

An explicit invocation authorizes the mapped remote-sessions command. “Thread” means a background Claude session reached through Remote Control.

Read `references/launcher.md` before calling the tool. It owns the actual main-checkout engine paths, README/help discovery, request-to-command mapping, UUID resolution, plan checks and reports. Do not run a worktree copy of the engine. Use `--json`; mutations require the named/current repo’s `--only` scope. “All” means repos returned by status.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

Preview the mutation with `--plan`. Run the same command without it only when the plan matches. A resume that proposes a new or replacement thread waits for Justin. Re-read status if a started thread lacks RemoteUrl. Report task, full SessionId, folder, URL/bridge gap and state. A blocked prompt needs the bridge or `claude attach`; stop preserves history and worktree. Report threads the tool cannot confirm stopped.
