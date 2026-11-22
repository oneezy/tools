---
name: oneezy-estimate
description: "Estimate the current repo's GitHub project: Estimate, Priority and Type on every unsized issue, open or closed, one comment each. Run by the task-manager workflow after issues open, or by hand to backfill a repo."
disable-model-invocation: true
---

An **AFK** run: no questions, no waiting, no human in the loop. Justin never edits the board, so this skill is the only thing that sets Estimate, Priority and Type. Every write goes through `scripts/set.sh`, which refuses anything outside the rules below with the rule named; a refusal is the rule speaking, so drop that one write and keep the rest.

The whole open backlog is in context on every run so each size is **relative** to its neighbours, never absolute: a 3 is smaller than every 5 on the board.

## Steps

1. **Load the backlog.** Run `scripts/backlog.sh` (beside this file) from the repo clone. Its first line is the project and its field ids; every other line is one issue on the board, open or closed: number, title, state, body, labels, status, estimate, priority, assignees, blocked-by and blocks counts. `gh` needs a token that can reach the project (`PROJECT_PAT`, a classic PAT with `project` + `repo`, in CI). Done when every line has been read.
2. **List the work.** Two lists, written in your reply:
   - **Unsized**: issues with no Estimate, open or closed and in any Status, minus `wayfinder:map` and `phase` issues. A closed one is sized from what was done, so the board carries a number for it; it gets no Type.
   - **Re-rank**: issues in Todo or Next Up whose Priority no longer fits their rank against the rest of the backlog.
   Done when both lists are on screen, even if one is empty.
3. **Decide per issue.** Estimate from `references/rules.md` (read before deciding; Points, Priority, Type, protected fields and comment examples). Write one line of reasoning per issue; that line is the comment.
4. **Write.** One `scripts/set.sh` call per issue, `--comment` carrying the reasoning line. Unsized: `--estimate`, `--priority`, and `--type` when the issue has no type label. Re-rank: `--priority` only. A refusal (exit 2) writes nothing and names the rule; rerun without the refused flag. Done when the script has printed `set` for every field decided in step 3 and `commented` for every issue on either list.
5. **Report.** One table, one row per issue written: number, title, Estimate, Priority, Type, the reasoning line. Empty lists get one line saying so.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

Done when all eligible issues carry Estimate and Priority, every change has its comment, and the report table is on screen.
