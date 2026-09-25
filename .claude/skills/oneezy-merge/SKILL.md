---
name: oneezy-merge
description: Land the current branch and end with one status report. Bare, or "this pr": commit, push, open the PR, wait for the Vercel builds. "into <branch>": the same, then squash-merge on green builds and delete the landed branch, keeping a `prototype/*` branch.
disable-model-invocation: true
argument-hint: "empty or 'this pr' to open for review; 'into dev' to merge"
---

Invoking this skill is Justin's word to commit and push the current branch. It does the actions for its mode and ends by calling the Skill tool with `oneezy-status`, exactly once; that report is the only message. Works in any repo with GitHub and Vercel; nothing is hardcoded.

## Mode, from the arguments

- **open**: no argument, or words that name no branch (`this pr`, `pr`, `branch`). Commit, push, open the PR, wait for the builds, report. Nothing is merged or deleted: Justin checks the branch.
- **land**: the argument names a branch (`into dev`, `to dev`, `dev`). Everything in open, then squash-merge on green builds, fast-forward, delete the landed branch. Land mode is Justin's OK to delete the landed branch, unless it is `prototype/*`: `/prototype` keeps that branch as a primary source, so it stays. The target is the named branch and only that branch; `main` is a target only when the argument says `main`.

PR base: the named branch in land mode. In open mode, `dev` when origin has it, else origin's default branch.

## Quiet

No text between steps. The status report is the only message. One exception: a check that fails before a report can be built (push refused, PR refused) is reported in one line, and the walk stops.

## Steps

Each step names its calls. Nothing exploratory runs between them; one schema load at the start if the harness needs it.

1. **Commit and push**, one shell call: stage the session's files, commit with a conventional subject carrying the ticket number and the harness's attribution trailers, `git push -u origin <branch>`. Done when the push is accepted.
2. **Open the PR**, one call, against the base. Body: `## Summary` holding `Closes #<n>` and the **snapshot** (at most five bullets of what landed; the status report reuses them verbatim), `## Evidence` (before and after, one line each), `## Merge Danger` (door: one-way or two-way; blast radius: one word, one line why). Done when the PR number is returned.
3. **Wait for the builds**: read the PR's combined status; while any `Vercel – *` status is pending, sleep 90 seconds in the background and read again, nothing else. Done when every Vercel status is success or failure. Any failure: skip step 4.
4. **Land** (land mode, all builds green): squash-merge with the expected head SHA, title = PR title plus `(#<pr>)`. Then one shell call: fetch, verify `origin/<base>` contains the squash commit (stop if not), check out the base, fast-forward, delete the remote branch and the local branch once, unless the branch is `prototype/*`, which stays on both. A refused delete is left for the report, not retried. Another session's worktree is never touched; this session's own cannot remove itself.
5. **Report**: call the Skill tool with `oneezy-status`. It reads the state and renders the message, Next Up and the next session's prompt included.

Budget: open mode at most four calls before the report, land mode at most six, not counting the background sleeps.
