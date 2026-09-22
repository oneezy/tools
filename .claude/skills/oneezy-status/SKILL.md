---
name: oneezy-status
description: Render the status report for whatever is in front of you, a working tree, a branch, a PR or a merged PR, in the fixed shape in STATUS.md, always ending with Next Up and the next session's prompt. Read-only. Use when Justin asks for status, and as the last step of /oneezy-merge.
---

One message, built from [STATUS.md](STATUS.md). The shape never changes; the **sources** that fill it change with the state. Nothing is changed by this skill: no commit, no push, no merge, no tracker write, and it never calls `/oneezy-merge`.

## State

One of four, read in this order, first match wins:

- **closeout**: a merged PR whose head commit the branch head contains.
- **blocked**: an open PR with a failed Vercel build.
- **open**: an open PR.
- **branch**: none of the above. The branch may be ahead of base, may have uncommitted files, may be nothing but a checkout.

A merged PR for the same branch name whose head the branch does not contain is history, not state; the branch state applies.

## Sources

Read from the environment at run time. A source that is missing is skipped and the slot that depends on it is filled from the next source or, for links, omitted. Nothing is guessed.

- Owner and repo: `git remote get-url origin`. Default branch: `refs/remotes/origin/HEAD`. Base: the PR's base when a PR exists, else `dev` when origin has it, else the default branch.
- PR: the open PR whose head is this branch, else the merged one the branch head contains. Title, body (`Closes #n`, the snapshot bullets), files.
- Vercel: the `Vercel – <project>` commit statuses on the newest pushed commit; each `target_url` is `vercel.com/<team>/<project>/<deployment>`, which yields team, projects and deployment pages. Branch previews from Vercel's bot comment on the PR; base preview `<project>-git-<base>-<team>.vercel.app`; team dashboard `vercel.com/<team>`. Build logs from the deployment events when the connector is authorized for the team; a 403 is reported as unread with the ticket that tracks it when one exists.
- Task board: the GitHub Project linked to the repo, else a `PROJECT_URL` in the repo's scripts.
- Map: an open issue labelled `wayfinder:map` (the parent of a closed ticket when one exists, else the single open map, else the most recently updated). Gives ticket counts, the milestone date from its Notes, and the frontier.
- Queue, for Next Up, in this order until three items are found: the map's frontier (open child tickets, unblocked, unassigned); the board's `Next Up` column; open issues labelled `ready-for-agent`; what this branch leaves unfinished (failing build, unmerged PR, uncommitted files). When all four are empty, Next Up is a recommendation of what to start, and the recommendation says so.
- Labels: every ticket's labels from the tracker.

## Next Up

Chosen, not copied: rank the queue by critical path, what blocks the most, and the milestone date. Justin's by-hand tasks are ranked with the rest and marked. When the ranking differs from the board's `Next Up` column, the recommendation says so. Item 1 decides the opening skill of the code block:

| Item 1 is | Block starts with |
|---|---|
| a wayfinder map ticket | `/wayfinder Work through map #<map> …` |
| an issue labelled `ready-for-agent` | `/implement #<n> …` |
| an idea or decision with no ticket | `/grill-with-docs …` |
| something broken | `/diagnosing-bugs …` |
| a task only Justin can do | `/wizard …` |
| none of these fit | `/ask-matt <the situation in one sentence>` |

The block ends with `Commit only when I say so, then run /oneezy-merge` plus `into <base>` when the work lands on a base.

## Budget

At most five calls: PR read, combined status, the Vercel bot comment, the map read, one shell call for git facts. One schema load at the start if the harness needs it. No text before the report; the report is the whole message.

Done when the report is on screen within STATUS.md's line cap, every slot filled from a source or omitted by its rule, every link a real URL, and Next Up present with its code block.
