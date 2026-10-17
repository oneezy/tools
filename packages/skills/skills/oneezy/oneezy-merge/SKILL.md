---
name: oneezy-merge
description: "Land the current branch and end with one status report. Bare, or 'this pr': commit, push, open the PR, wait for every check on it. 'into <branch>': the same, then squash-merge on green checks and delete the landed branch. 'release', 'both', 'dev and main': the same into dev, then promote every ready repo in scope to main. 'release all': promote every repo Justin owns, after his yes."
disable-model-invocation: true
argument-hint: "empty or 'this pr' to open for review; 'into dev' to merge; 'release' (or 'both', 'dev and main') to merge into dev and promote to main; 'release all' to promote every repo after a yes"
---

An explicit invocation authorizes committing and pushing this session’s files for the selected mode. Read `references/modes.md` before any action: it owns mode selection, base, calls, PR body, check polling, SHA-guarded merge, promotion and budgets.

- Bare or “this pr”: open for review; wait for all checks; do not merge or delete.
- A named branch other than `main`: land only into that target when checks are green.
- Release/both/dev and main: land into dev, then promote main in every ready repo of the release scope (the repos this session landed, else every checkout in the working area); an already-landed branch only needs promotion.
- Release all: list every repo Justin owns with what it would promote, and promote only after his yes.
- `main` takes only promotions from `dev`, merged as a merge commit through a PR.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

Keep other sessions’ worktrees and files untouched. No text between steps; an action failure gets one line and stops, and the release all plan waits for his yes. Run `/oneezy-status` exactly once at the end; its report is the only final message. Do not invoke a user-only dependency without authorization or bypass host policy.

Package publication, hand tagging and release notes belong to a release skill. Report releases made by the repository’s main workflow. A required manual release goes in Next Up and stops here.

Done means the selected mode’s checks and containment/tree verification pass, or the failed/skipped action is disclosed in the status report.
