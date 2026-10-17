## Mode, from the arguments

- **open**: no argument, or words that name no branch (`this pr`, `pr`, `branch`). Commit, push, open the PR, wait for the checks, report. Nothing is merged or deleted: Justin checks the branch.
- **land**: the argument names one branch other than `main` (`into dev`, `to dev`, `dev`). Everything in open, then squash-merge on green checks, fast-forward, delete the landed branch. The target is the named branch and only that branch. `into main` (or `to main`, `main`) is release: `main` takes only promotions from `dev`.
- **release**: `release`, `both`, `dev and main`, `into dev and main`, `to dev and main`, or `main` as the target. Everything in land into `dev` when there is a branch to land, then promote (step 5) every repo in the **release scope**. A release from `dev` itself, or with nothing of this session's left to land, is promotion only.
- **release all**: `release all`, read before release. Promotion only, over every repo Justin owns, behind his yes (step 5).

PR base: the named branch in land mode, `dev` in release mode. In open mode, `dev` when origin has it, else origin's default branch.

## Release scope

The repos a promotion covers, read from the session and never from a written list (Justin moves between projects):

- **release**: the repos this session landed into `dev`. When it landed none (typed fresh in a project chat), every repository checked out in the working area: the working directory when it is a checkout, else each checkout directly under it.
- **release all**: every repository Justin owns, under his account and his organizations (`gh api 'user/repos?affiliation=owner,organization_member' --paginate`). A repo this session cannot reach goes on the plan as unreached.

A repo in scope is **ready** when `dev` holds commits `main` lacks (`git rev-list --count origin/main..origin/dev` above 0) and every check on `dev`'s head is green as in step 3. A repo with no `dev` branch, or with nothing new, is skipped. A ready repo is promoted; nothing else reaches `main`.

## Quiet

No text between steps. The status report is the only message. Two exceptions: a check that fails before a report can be built (push refused, PR refused, promotion refused) is reported in one line, and the walk stops; and the release all plan, which waits for Justin's yes.

## Steps

Each step names its calls. Nothing exploratory runs between them; one schema load at the start if the harness needs it.

1. **Commit and push**, one shell call: stage the session's files, commit with a conventional subject carrying the ticket number and the harness's attribution trailers, `git push -u origin <branch>`. Done when the push is accepted.
2. **Open the PR**, one call, against the base. Body: `## Summary` holding `Closes #<n>` and the **snapshot** (at most five bullets of what landed; the status report reuses them verbatim), `## Evidence` (before and after, one line each), `## Merge Danger` (door: one-way or two-way; blast radius: one word, one line why). Done when the PR number is returned.
3. **Wait for the checks** on the PR's head commit: its check runs (`gh api repos/<owner>/<repo>/commits/<sha>/check-runs`: every GitHub Actions job and app check, the repo's own CI among them) and its commit statuses (`.../commits/<sha>/status`: Vercel and other status apps). While any check run is queued or in progress, or any status is pending, sleep 90 seconds in the background and read again, nothing else. Done when every one has finished. Green means every check run concluded success, skipped or neutral and every status is success; any other conclusion (failure, cancelled, timed out, action required) or status (failure, error) is red: skip steps 4 and 5. A head with no check and no status after the first 90-second wait is green with nothing checked, and the report says so.
4. **Land** (land and release modes, all checks green): squash-merge with the expected head SHA, title = PR title plus `(#<pr>)`. Then one shell call: fetch, verify `origin/<base>` contains the squash commit (stop if not), check out the base, fast-forward, delete the remote branch and the local branch once. A refused delete is left for the report, not retried. Another session's worktree is never touched; this session's own cannot remove itself.
5. **Promote** (release and release all): first the **plan**, one line per repo in the release scope: repo, ready or skipped and why, the PRs and commits `dev` carries since the last promotion. A red `dev` stops the walk for that repo, and the plan says so. In release the plan goes into the report and the walk goes on. In release all the plan is a message of its own: wait for Justin's yes in this session before touching any repo, and treat anything but a yes as no. Then, per ready repo: open a PR `dev` → `main` titled `release: promote dev to main (<the landed PR's prefix or ticket, or the PRs carried>)` whose body lists the commits since the last promotion, merge it with a merge commit (`dev` stays an ancestor of `main`, so the next promotion carries only what is new), and verify `origin/main` contains the merge. One shell call: fetch, fast-forward the local `main` ref (`git fetch origin main:main` when `main` is not checked out anywhere; `git pull --ff-only` in the checkout that has it), then verify `origin/dev` is an ancestor of `origin/main` (`git merge-base --is-ancestor origin/dev origin/main`) and the two trees are identical (`git diff --quiet origin/dev origin/main`). `main` keeps the merge commit `dev` lacks, so the two never point at the same commit; that is expected. Nothing is deleted: `dev` and `main` are permanent. Then wait for the checks on `origin/main`'s new head as in step 3 (in a repo whose push to `main` cuts a release or publishes a package, such as oneezy/skills and oneezy/tools, that job is among them) and keep what it released for the report. Done when every ready repo's `main` contains its `dev` with the same tree and green checks.
6. **Report**: run `/oneezy-status`. It reads the state and renders the message, Next Up and the next session's prompt included. In release and release all the Git line names each move: the squash into `dev`, then per repo the promotion of `main` and the release tag or package version a job on `main` cut, and each skipped repo with its reason.

Budget: open mode at most four calls before the report, land mode at most six, release mode at most ten plus six per extra repo promoted, not counting the background sleeps.
