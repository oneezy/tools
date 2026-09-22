# task-manager

Zero-touch bootstrap and repair of one GitHub project per repo. Double-click `task-manager.cmd`, check the repos, press enter. Everything a GitHub project needs is created or repaired from the spec in `task-manager.ps1`; the only hand step GitHub leaves is turning on **Auto-add to project**, and the tool opens that page and waits until it sees the switch flipped.

Decisions behind the spec: [Task-manager model](https://github.com/oneezy/tools/issues/7) (fields, statuses, labels, views) and [How much of a GitHub Project can be set up by automation?](https://github.com/oneezy/tools/issues/5) (what the API can and cannot do). Glossary in the repo's `CONTEXT.md`.

## Use

```
task-manager.cmd                                   picker: every repo under oneezy and layerdbiz
pwsh task-manager.ps1 status                       print each repo's state
pwsh task-manager.ps1 bootstrap -Repo oneezy/tools create or repair one repo, then wait for the Auto-add clicks
pwsh task-manager.ps1 bootstrap -Repo oneezy/tools -NoBrowser   same, without opening the browser
```

Picker keys: up/down move, space toggle, a all/none, enter bootstrap checked, o open the project page, h show or hide archived repos and forks, r refresh, q quit.

States: `no project`, `ok`, `needs clicks` (only Auto-add is missing), `drifted` (the row shows what differs), `login needed` (`gh auth login -u <owner> -s project,repo,workflow`).

## Needs

- `gh` logged in to each account with the `project`, `repo` and `workflow` scopes. The tool picks the owner's token per call, so the active account never changes.
- The two accounts are `oneezy` and `layerdbiz` (`-Owners` to change).

## The workflow

Once a repo is bootstrapped, its board moves by itself. The workflow is [`.github/workflows/task-manager.yml`](../../.github/workflows/task-manager.yml) in this repo, which runs directly on this repo's events and is what every other repo calls from a thin caller (`caller.yml` here is the template; the tool opens a pull request that adds it). Built on [#17](https://github.com/oneezy/tools/issues/17); the events and statuses were decided on [#7](https://github.com/oneezy/tools/issues/7).

- **Status moves** (`scripts/status.sh`). Every event but "issue opened" moves the issue's Status: assigned to Next Up; a branch named `<type>/<n>-<slug>` created on GitHub to In Progress; a PR opened or marked ready to Review for its linked issues (closing references plus the branch's issue; `wayfinder:research` never goes to Review); a PR converted to draft or a changes-requested review back to In Progress; a PR merged into `dev` closes its linked issues (and drops `needs-changes`), then Done; a push to `main` moves every Done item to Complete; reopening or labelling `needs-changes` puts a ticket back In Progress; unassigning the last assignee returns a ticket to Todo. Closed issues are only ever moved to Done or Complete. "Opened to Todo" is the built-in "Item added", so it is not here.
- **Estimate agent.** "Issue opened" waits two minutes in a cancel-in-progress concurrency group per repo, so a burst of new issues collapses into one run, then runs `/oneezy-estimate` (this repo's copy of the skill) under Claude Code with the subscription token; `gh` inside it holds `PROJECT_PAT`. The skill's `set.sh` enforces every write rule (Estimate write-once, Priority only in Todo and Next Up, one type label), so the agent decides and the script refuses.
- **Backfill.** `workflow_dispatch` with `backfill=true` recomputes the whole board from git facts (closed: Done; open and assigned: Next Up from Todo or nothing; open and unassigned with no Status: Todo; everything else kept) and adds open issues missing from the board. `estimate=true` runs the estimate agent by hand. The tool dispatches a backfill at the end of every bootstrap.

Secrets per repo: `PROJECT_PAT`, a classic PAT (`project` + `repo`) of the account that owns the project, one per account (`GITHUB_TOKEN`, fine-grained PATs and GitHub Apps cannot reach user-owned projects), and `CLAUDE_CODE_OAUTH_TOKEN`. `setup-secrets.sh` mints and stores them.

Issue, branch and push events run from the repo's default branch, so the file must be on `main` before the board moves by itself; `pull_request` events and `workflow_dispatch -r dev` work from `dev`. `scripts/status.sh` reads everything from environment variables, so it runs by hand: `REPO=oneezy/tools EVENT=issues ACTION=assigned ISSUE=17 DRY_RUN=1 clis/task-manager-cli/scripts/status.sh` prints what it would move.

## Not here yet

- Roadmap date fields and milestone markers have no API; pick Start, Due and Milestones once in the Roadmap view's settings.
- `.legacy/` is reference only: the 2023 task schema and the Favro label vocabulary. Never written to.

## Reference

- https://docs.google.com/spreadsheets/d/15Y-ckNg5aO5PlqZfjJhT5mmluhe3u1R-f-YflbBInjs/edit?gid=1915777059#gid=1915777059
- https://docs.google.com/spreadsheets/d/1flyQ-gWJ0oYroYGEZ5xScl7Qe1R6qPrrvyL7F9XGpJc/edit?gid=2023871387#gid=2023871387
- https://docs.google.com/spreadsheets/d/1bS1aRXIVHjzawLNAhFvRZjVj7wbMxW_YWLRZYybEoFA/edit?gid=2023871387#gid=2023871387
- https://docs.google.com/spreadsheets/d/18Of37IbEJvcY-OWME4Unok5fZDBQBGZrIAoN7TsVyTA/edit?gid=38292496#gid=38292496
- https://docs.google.com/spreadsheets/d/1e9qBcirsiyqPu-MtPjTzFnkibE8pr8sfzYIHpeM9Lbg/edit?gid=38292496#gid=38292496
