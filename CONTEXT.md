# Context

Glossary for the `tools` repo. Terms only; no implementation detail.

## Tool

A program in `clis/` that Justin runs by double-clicking its `.cmd` file. It opens a terminal **picker**: an arrow-key list where space checks rows, enter acts on the checked rows, and q quits. The folder name keeps the historical `-cli` suffix, but a tool is not a CLI in the sense below.

## CLI

A command-line program driven by arguments, such as `claude`, `codex`, `gh`, `wsl`. Tools call CLIs; tools are not themselves CLIs.

## Harness

An AI agent runtime with its own config folder and its own expected skill layout. In scope: Claude Code and Codex. Out of scope for now: Hermes, Goose.

## Surface

A way of reaching a harness: terminal, desktop app, VS Code extension, phone app, web or cloud. One harness has many surfaces, and they read the same harness config, so syncing a harness syncs all of its surfaces. Justin calls the set of surfaces that must stay in step the **sync layer**.

## Host

A machine or container where a harness is installed: this Windows PC, the Ubuntu WSL distro, a remote machine over SSH, a cloud sandbox. Skills are synced per harness per host.

## Picker

The default user interface of a tool. One screen, sections of rows, the same key bindings in every tool: up/down move, space toggle, a all/none, enter act, x stop or remove, r refresh, q quit.

## Project

Ambiguous on its own. Said bare, Justin usually means a **client project**: a paying engagement and its repo. In task-manager talk, **GitHub project** (also "task manager") means a GitHub Projects v2 project attached to one repo. Its views have their own names: **board** or **kanban** is the board view, **backlog** is the table view, **roadmap** is the roadmap view.

## Ticket

Any issue on a repo that has a GitHub project. Justin also says feature, bug, task, issue, or card (the agile word) for the same thing; context picks the type, not the meaning. A wayfinder ticket is a ticket with a `wayfinder:*` label and a parent map; task-manager builds on wayfinder and never changes how wayfinder labels, links, or claims.

## Status

Where a ticket sits on the board: **Todo**, **Next Up**, **In Progress**, **Review**, **Done**, **Complete**. Next Up means someone owns it (assigned), never a hand-placed queue. In Progress means its branch exists on GitHub. Review means a pull request is ready for a human. Done means merged into `dev`. Complete means promoted to `main`, live in production. A staging branch changes nothing here.

## Session status

The colored circle a **picker** row shows for one Claude session: working, idle (waiting for Justin), stopped (resumable), live in another **surface**, new (a placeholder for a first task), history, error (needs a decision), and merged (reserved for the cleanup sweep, which sets it; nothing does yet). The picker's Status column means this, never a ticket's **Status**.

## Needs changes

A Done ticket the client or Justin sent back. A red label on the reopened issue; the ticket returns to In Progress and the label drops when new work merges.

## Phase

A big chunk of work that gets the client to a point: an issue labelled `phase` with a start and a due date, the only ticket kind that carries dates. Maps and stray tickets hang under a phase as sub-issues. A phase is a bar on the roadmap.

## Milestone

A dated line the client pays against, held as a GitHub Milestone. Phases are assigned to the milestone they feed; one milestone can end several phases. A milestone is a marker on the roadmap.

## Priority

How urgent a ticket is: **Low** (green), **Medium** (yellow), **High** (orange), **Critical** (red). One value per ticket, kept as a project field so the backlog sorts by it. The older schemes (MoSCoW, WSJF, Kano, business value) are reference material, not retired, and may return for other kinds of board.

## Blocked

Waiting on another ticket. Wayfinder's word: a native dependency edge, cleared when the blocking ticket closes. Never a status column.

## Waiting

Waiting on something outside the tickets: a package release, a client answer, a payment. A label a ticket carries in any column; the board dims it.

## Estimate

A ticket's size in Fibonacci points, 1 to 13. No weekly capacity: agents work in parallel, so points size the work, they do not budget it.

## Type

What kind of ticket: bug, feature, tech debt, question, learning, reference. A ticket with no type is a task. A map is the epic.

## Branch type

The first word of a task branch and worktree name: feature, fix, research, prototype, wayfinder, chore, docs. It says what the work on the branch is, as in `fix/31-picker-speed` in folder `tools-fix-31-picker-speed`. Not a ticket's **Type**: a bug ticket is usually worked on a `fix/` branch, but the two lists are separate. A worktree made before its task is known is `new/<n>` until the agent renames the branch.
