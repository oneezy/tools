# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues on `oneezy/skills`. Use `gh api` REST calls for every operation.

**Never `gh issue`, `gh pr`, `gh project` or `gh api graphql`.** Those go through GitHub's GraphQL API, which Claude Code cloud sessions block (HTTP 403), so a skill that uses them works on the PC and breaks in a cloud thread. REST works everywhere. Only repo-scoped paths (`repos/oneezy/skills/...`) and `user` are reachable from a cloud session; `search/...` is not.

## Conventions

- **Create an issue**: `gh api repos/oneezy/skills/issues -f title="..." -F body=@body.md -f "labels[]=..."` (one `-f "labels[]=x"` per label). `-F body=@file` reads a multi-line body from a file; write it with a heredoc first. Add `--jq .number` to get the new number.
- **Read an issue**: `gh api repos/oneezy/skills/issues/<n> --jq '{number, title, state, body, labels: [.labels[].name]}'`, then `gh api repos/oneezy/skills/issues/<n>/comments --paginate --jq '.[] | {user: .user.login, body}'`.
- **List issues**: `gh api "repos/oneezy/skills/issues?state=open&labels=<a>,<b>&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, title, labels: [.labels[].name]}'`. The issues endpoint also returns pull requests; the `select` drops them.
- **Comment on an issue**: `gh api repos/oneezy/skills/issues/<n>/comments -F body=@comment.md`
- **Apply / remove labels**: `gh api repos/oneezy/skills/issues/<n>/labels -f "labels[]=..."` / `gh api --method DELETE repos/oneezy/skills/issues/<n>/labels/<label>`
- **Assign**: `gh api repos/oneezy/skills/issues/<n>/assignees -f "assignees[]=$(gh api user --jq .login)"`
- **Close**: comment first, then `gh api --method PATCH repos/oneezy/skills/issues/<n> -f state=closed -f state_reason=completed` (`not_planned` for won't-do).

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues:

- **Read a PR**: `gh api repos/oneezy/skills/pulls/<n>` and its comments with `gh api repos/oneezy/skills/issues/<n>/comments`; the diff with `gh api repos/oneezy/skills/pulls/<n> -H "Accept: application/vnd.github.diff"`.
- **List external PRs for triage**: `gh api "repos/oneezy/skills/pulls?state=open&per_page=100" --paginate --jq '.[] | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`, then keep only `author_association` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR` or `NONE`.
- **Comment / label / close**: the issue calls above work on PR numbers; close a PR with `gh api --method PATCH repos/oneezy/skills/pulls/<n> -f state=closed`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: `gh api repos/oneezy/skills/issues/42` answers for both, and a `pull_request` key in the result means it is a PR.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the issue and its comments as above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions-so-far / Not-yet-specified / Out-of-scope body. Create it as above with `-f "labels[]=wayfinder:map"`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue: `gh api repos/oneezy/skills/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Database id**: dependency and sub-issue calls take the issue's numeric database id, `gh api repos/oneezy/skills/issues/<n> --jq .id`, _not_ the `#number` or `node_id`.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation: `gh api --method POST repos/oneezy/skills/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. GitHub reports `issue_dependencies_summary.blocked_by` on the issue (open blockers only, the live gate). A ticket is unblocked when every blocker is closed.
- **Frontier query**: `gh api "repos/oneezy/skills/issues/<map>/sub_issues?per_page=100" --paginate --jq '.[] | select(.state == "open" and .issue_dependencies_summary.blocked_by == 0 and (.assignees | length) == 0) | {number, title}'`; first in map order wins.
- **Claim**: assign the ticket as above, the session's first write.
- **Resolve**: comment the answer, close the issue as above, then append a context pointer (gist + link) to the map's Decisions-so-far: read the map body with `gh api repos/oneezy/skills/issues/<map> --jq .body > map.md`, edit it, and write it back with `gh api --method PATCH repos/oneezy/skills/issues/<map> -F body=@map.md`.
