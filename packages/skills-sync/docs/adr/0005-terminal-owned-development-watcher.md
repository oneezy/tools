# ADR-0005: One Development watcher per Library, owned by the terminal that started it

Date: 2026-10-17. Status: accepted. Recorded by oneezy/tools#212.

## Context

Several Development projects can be open at once, each with a terminal. Spec #209 asks for one watcher per Library that the first terminal visibly owns, that later launches reuse and name, and that stops with its owning terminal. It rules out a detached service, startup integration and implicit takeover. Windows reuses process ids quickly, and closing a console window gives its processes only a few seconds.

## Decision

- **`skills-sync develop watch` runs the watcher in the foreground of the terminal that starts it.** It prints every build there. Ctrl+C, Ctrl+Break, a hang-up (closing a console window is SIGHUP on Windows too), a broken stdout, or its parent process gone all stop it. Nothing detaches, and nothing starts it with the machine.
- **The owner record is `<library>/dist/development/watcher.json`**, beside `projects.json`. It holds the pid, the parent pid, a random token, the project it was started from, the terminal the environment names, the start time and the heartbeat interval. A stop rewrites it as `stopped`, with the time and the reason.
- **The owner is live only while its pid exists and it touched the record within five heartbeats** (2 s each by default; `SKILLS_SYNC_WATCH_HEARTBEAT_MS` sets it). A reused pid, or a process killed outright, therefore reads as stopped, and the next launch owns the watcher afresh. That is a new watcher, never a takeover of a running one.
- **A launch reads and writes the record inside a claim folder, `dist/development/watcher.claim`, made exclusively.** Two launches at the same moment leave one owner. A claim older than 10 s is a dead launch's and goes.
- **A watcher that finds another token in the record has lost it, and stops.** That only happens when it was suspended past its heartbeat and another launch started.
- **On Windows, a Node parent can end the watcher before it notices.** libuv puts every child a Node process spawns into that process's job object, which kills its members when it closes. Run through `pnpm skills:dev:watch`, the watcher can therefore die with pnpm when the window closes, with no moment to write. The record then names a dead pid, which status reads as stopped (`its owner (pid N) ended without stopping`). No process outlives the terminal either way.
- **A later launch prints the owner (pid, start, project, terminal) and exits 0.** It builds nothing and stays nowhere.
- **The watcher serves what the connected projects select.** That is the union of `projects.json` entries whose record still names this Library, read again each heartbeat, so a project set up meanwhile is built without a restart.

## Considered options

- **The pid alone, as the build lock does.** On Windows a dead owner's pid can belong to another process within minutes, and every later launch would then refuse to start.
- **A later launch that waits on, or tails, the owner.** It would keep a second terminal tied to a watcher it does not own, and closing that terminal would do nothing.
- **A background process shared by every terminal.** That is the detached service the spec rules out.
