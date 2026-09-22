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

## Not here yet

- The caller workflow file (`.github/workflows/task-manager.yml`) and the backfill run wait on the `oneezy/workflows` repo ([#15](https://github.com/oneezy/tools/issues/15), [#17](https://github.com/oneezy/tools/issues/17)). Until then the backfill step reports itself skipped.
- Roadmap date fields and milestone markers have no API; pick Start, Due and Milestones once in the Roadmap view's settings.
- `.legacy/` is reference only: the 2023 task schema and the Favro label vocabulary. Never written to.

## Reference

- https://docs.google.com/spreadsheets/d/15Y-ckNg5aO5PlqZfjJhT5mmluhe3u1R-f-YflbBInjs/edit?gid=1915777059#gid=1915777059
- https://docs.google.com/spreadsheets/d/1flyQ-gWJ0oYroYGEZ5xScl7Qe1R6qPrrvyL7F9XGpJc/edit?gid=2023871387#gid=2023871387
- https://docs.google.com/spreadsheets/d/1bS1aRXIVHjzawLNAhFvRZjVj7wbMxW_YWLRZYybEoFA/edit?gid=2023871387#gid=2023871387
- https://docs.google.com/spreadsheets/d/18Of37IbEJvcY-OWME4Unok5fZDBQBGZrIAoN7TsVyTA/edit?gid=38292496#gid=38292496
- https://docs.google.com/spreadsheets/d/1e9qBcirsiyqPu-MtPjTzFnkibE8pr8sfzYIHpeM9Lbg/edit?gid=38292496#gid=38292496
