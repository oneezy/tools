# Runtime details

The skill's seven `.ts` files are the source and the runtime:

```text
scripts/
  main.ts          command entry and sequential orchestration
  steps/
    backlog.ts     fields, labels, import, backlog reads and estimate guards
    board.ts       status transitions, backfill and workflow automation
    roadmap.ts     roadmap parsing, phases and milestones
  github.ts        authentication and HTTP
  project.ts       shared project spec, operations and drift checks
  types.ts         shared TypeScript interfaces
```

Node 24.12+ runs these files with its built-in type stripping. `package.json`
marks them as ES modules; it has no dependencies and requires no install. There
is no compiled copy or generator. The Tools workspace owns tests and type checks
in `packages/task-manager`. Do not put this raw TypeScript skill under
`node_modules`: Node deliberately refuses type stripping there.

## Events

Run `node <skill>/scripts/main.ts event --repo owner/name`. Inputs are environment
variables, matching the retained hosted workflow:

| Variable | Meaning |
| --- | --- |
| EVENT | issues, create, pull_request, pull_request_review, push, start, workflow_dispatch |
| ACTION | assigned, unassigned, reopened, labeled, opened, ready_for_review, converted_to_draft, closed, submitted |
| ISSUE, LABEL | Issue number and newly added label |
| REF_TYPE, REF | Branch type and name (`type/42-slug`) |
| PR, PR_BASE, PR_DRAFT, PR_MERGED | PR number, base branch and true/false flags |
| REVIEW_STATE | changes_requested, approved or commented |
| PUSH_REF | refs/heads/main (or configured release branch) |
| START, BACKFILL | Dispatch issue number, or true to backfill |
| INTEGRATION_BRANCH, RELEASE_BRANCH | Defaults dev and main |
| DRY_RUN | Any nonempty value makes event processing read-only |

Assignment moves Todo/unset to Next Up. A numbered branch, manual start or draft
PR moves Todo/Next Up/unset to In Progress. Ready PRs move to Review, excluding
research. Draft conversion or a changes-requested review returns Review to In
Progress. Merge into dev closes linked issues and moves them to Done; push to
main promotes Done to Complete. Needs-changes returns work to In Progress.
Maps/phases never move; other closed issues only move to Done/Complete. Foreign
repository references are skipped. Milestones are never changed by status rules.

Backfill preserves Complete, In Progress and Review. Closed issues become Done;
assigned Todo/unset becomes Next Up; unassigned unset becomes Todo. Setup also
corrects unassigned Next Up to Todo and imports all issues. Standalone backfill
adds missing open tickets. Roadmap sync preserves dates and existing milestone
assignments.

The hosted Bash workflow, PowerShell picker and secret setup helper remain
legacy compatibility tools. Their deployment is unchanged. Auto-add polling can
verify only the enabled flag; repository/filter and roadmap marker settings need
human verification. More than 100 project fields/views/workflows fails explicitly
before repair. Mutations are never automatically retried.
