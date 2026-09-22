---
name: oneezy-estimate
description: Estimate the current repo's GitHub project: Estimate, Priority and Type on every unsized issue, open or closed, one comment each. Run by the task-manager workflow after issues open, or by hand to backfill a repo.
disable-model-invocation: true
---

An **AFK** run: no questions, no waiting, no human in the loop. Justin never edits the board, so this skill is the only thing that sets Estimate, Priority and Type. Every write goes through [`scripts/set.sh`](scripts/set.sh), which refuses anything outside the rules below with the rule named; a refusal is the rule speaking, so drop that one write and keep the rest.

The whole open backlog is in context on every run so each size is **relative** to its neighbours, never absolute: a 3 is smaller than every 5 on the board.

## Steps

1. **Load the backlog.** Run `scripts/backlog.sh` (beside this file) from the repo clone. Its first line is the project and its field ids; every other line is one issue on the board, open or closed: number, title, state, body, labels, status, estimate, priority, assignees, blocked-by and blocks counts. `gh` needs a token that can reach the project (`PROJECT_PAT`, a classic PAT with `project` + `repo`, in CI). Done when every line has been read.
2. **List the work.** Two lists, written in your reply:
   - **Unsized**: issues with no Estimate, open or closed and in any Status, minus `wayfinder:map` and `phase` issues. A closed one is sized from what was done, so the board carries a number for it; it gets no Type.
   - **Re-rank**: issues in Todo or Next Up whose Priority no longer fits their rank against the rest of the backlog.
   Done when both lists are on screen, even if one is empty.
3. **Decide per issue.** Estimate from [Points](#points), Priority from [Priority](#priority), Type from [Type](#type). Write one line of reasoning per issue; that line is the comment.
4. **Write.** One `scripts/set.sh` call per issue, `--comment` carrying the reasoning line. Unsized: `--estimate`, `--priority`, and `--type` when the issue has no type label. Re-rank: `--priority` only. A refusal (exit 2) writes nothing and names the rule; rerun without the refused flag. Done when the script has printed `set` for every field decided in step 3 and `commented` for every issue on either list.
5. **Report.** One table, one row per issue written: number, title, Estimate, Priority, Type, the reasoning line. Empty lists get one line saying so.

## Points

Fibonacci, 1 to 13, no 21. The legacy examples table, which Justin's earlier task manager sized against:

| Points | Time | Complexity | Example |
|---|---|---|---|
| 1 | 5-10 min | very easy | quick tasks |
| 2 | 20-30 min | easy | small CSS tweaks |
| 3 | 1-2 h | moderate | simple components |
| 5 | 4-8 h | moderate to hard | designing logos or ads |
| 8 | 2-3 days | hard | features needing research |
| 13 | 1-2 weeks | needs refinement | high-level features |

- Points size the work, not the calendar: agents run in parallel and there is no weekly capacity. Read Time as effort for one focused worker.
- A wayfinder ticket is sized to one agent session by construction, so it lands between 3 and 8; a research ticket is usually 3, a grilling ticket 3 to 5, a prototype or build task 5 to 8.
- 13 means **needs refinement**: the body holds more than one session of work. Size it 13 and say so in the comment; splitting is the human's move, not this skill's.
- Estimate is **write-once**. It stands after any later edit to the ticket, even a rewrite of the body.

## Priority

Four ranks, from a project field:

| Priority | Means |
|---|---|
| Critical | Something live is broken, or the ticket blocks the map's current frontier and everything waits on it |
| High | On the critical path: it blocks other open tickets (`blocks` > 0) or is on the frontier of an open map |
| Medium | Wanted in the current phase or milestone, blocks nothing |
| Low | Nice to have; reference, learning, cleanup with no date behind it |

Priority is a rank, not a mood: Critical is rare, and most of a healthy backlog is Medium and Low. Rank the unsized issues against the sized ones, so a new issue slots in where it belongs. A ticket that is itself blocked (`blocked_by` > 0) rarely outranks its blocker.

Re-ranking happens only while a ticket is in **Todo** or **Next Up**; In Progress and later are frozen, and `set.sh` refuses the change. Every change carries its one-line reason as the comment.

## Type

One label per ticket, from the repo's label set:

| Label | When |
|---|---|
| `bug` | Something that worked, or should work, does not |
| `feature` | New behaviour a user or client will see |
| `tech-debt` | Cleanup that pays later: refactors, upgrades, dead code |
| `question` | Needs an answer before work can start |
| `learning` | Something for Justin to learn, no deliverable |
| `reference` | Material to keep, not work |

No type label means **task**, the default, so most tickets get none. A `wayfinder:*` ticket already says what it is; give it a type only when its body is plainly a bug or a feature. An existing type label stands; `set.sh` refuses a second one.

## Never touched

Title, body, assignee, Status, Start, Due, `wayfinder:*` labels, a set Estimate, and any `wayfinder:map` or `phase` issue. `set.sh` holds every one of these lines; the skill has no other write path.

## Comment

One per issue per run, short: the values first, the reason after a colon.

```
Estimate 5, Priority High, Type feature: blocks the two caller-file tickets and needs the GraphQL view endpoint worked out.
Priority Medium (was High): the ticket it was blocking closed on Tuesday; nothing waits on it now.
```

Done when every unsized issue outside maps and phases, open or closed, carries an Estimate and a Priority, every Priority change has its comment, and the report table is on screen.
