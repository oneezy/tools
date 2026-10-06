# Task manager

One GitHub project per repo, its board moved by git events, and the repo's roadmap as phases. Shared words (Tool, Host, Harness) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md); decisions are in [`docs/adr/`](./docs/adr/).

## Language

### The board

**Project**:
Ambiguous on its own. Said bare, Justin usually means a **client project**: a paying engagement and its repo. Here, **GitHub project** means the GitHub Projects v2 project attached to one repo; its views are the **board** (kanban), the **backlog** (table) and the **roadmap**.
_Avoid_: "task manager" for the GitHub project itself

**Ticket**:
Any issue on a repo that has a GitHub project. A **wayfinder ticket** carries a `wayfinder:*` label and a parent map; the task manager builds on wayfinder and never changes how wayfinder labels, links or claims.
_Avoid_: card, feature, bug, task, issue (context picks the Type, not the meaning)

**Status**:
Where a Ticket sits on the board: **Todo**, **Next Up** (assigned), **In Progress** (its branch exists on GitHub), **Review** (a pull request ready for a human), **Done** (merged into `dev`), **Complete** (promoted to `main`, live). A staging branch changes nothing here.
_Avoid_: column, stage

**Needs changes**:
A Done Ticket the client or Justin sent back: a red label on the reopened issue. The Ticket returns to In Progress and the label drops when new work merges.
_Avoid_: rejected, reopened

**Blocked**:
Waiting on another Ticket: wayfinder's native dependency edge, cleared when the blocking Ticket closes. Never a Status.

**Waiting**:
Waiting on something outside the Tickets (a package release, a client answer, a payment). A label a Ticket carries in any Status; the board dims it.
_Avoid_: on hold, blocked

### Fields

**Priority**:
How urgent a Ticket is: **Low** (green), **Medium** (yellow), **High** (orange), **Critical** (red). One value per Ticket. The older schemes (MoSCoW, WSJF, Kano, business value) are reference material and may return for other kinds of board.

**Estimate**:
A Ticket's size in Fibonacci points, 1 to 13. Points size the work; they do not budget a week.
_Avoid_: capacity, velocity

**Type**:
What kind of Ticket: bug, feature, tech debt, question, learning, reference. A Ticket with no Type is a task. A map is the epic.

### The roadmap

**Phase**:
A big chunk of work that gets the client to a point: an issue labelled `phase`, titled `Phase <n> — <title>` after a section of the repo's roadmap file. The only Ticket kind that carries start and due dates; a bar on the roadmap.
_Avoid_: epic, sprint

**Milestone**:
Two meanings. In a contract, a dated line the client pays against (Trident's Milestone 1 and 2). On GitHub, the GitHub Milestone with its Phase's title: how a Ticket joins a Phase, and a marker on the roadmap once dated.
