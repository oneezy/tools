---
name: oneezy-task-manager
description: Set up, inspect or repair a repository's GitHub backlog, board and roadmap with one bundled TypeScript command.
disable-model-invocation: true
---

Run the TypeScript bundled with this skill. It needs **Node 24.12+** and GitHub
credentials. No build, npm install, Tools checkout, or other skill is needed.

Resolve `scripts/main.ts` relative to this installed `SKILL.md`. Use its absolute
path and the verified target repository:

```text
node <skill>/scripts/main.ts run --repo owner/name --plan
node <skill>/scripts/main.ts run --repo owner/name
node <skill>/scripts/main.ts run --repo owner/name --source roadmap.md
```

`main.ts` runs **Backlog → Board → Roadmap** sequentially, then imports issues,
backfills status, and prepares the caller workflow. The three modules live
together in `scripts/steps/`. It stops if a step fails.

Use `--plan` for preview requests: it makes no GitHub writes, opens no browser,
and dispatches no workflow. For an authorized setup or repair, omit `--plan`.
Repair replaces extra views with Backlog, Board and Roadmap; existing estimates,
matching field-option IDs, dates and milestone assignments survive.

Other commands: `status`, `backlog` (JSONL), `roadmap --source <file-or-URL>`,
`backfill`, and `event`. `--help` lists options; `references/runtime.md` describes
event inputs. `--no-automation` skips caller PR creation and dispatch.

Setup does not estimate tickets. `oneezy-estimate` remains the estimation workflow.
The bundled `estimate` command can apply an explicitly supplied decision:

```text
node <skill>/scripts/main.ts estimate --repo owner/name --issue 42 --estimate 3 --priority High --comment "Reason" --plan
```

It enforces write-once Fibonacci estimates, Priority changes only in Todo/Next Up
(unless unset), one Type on open tickets, no sizing maps/phases, and a reasoning
comment. A refusal exits 2 before writing. Do not choose estimates during setup.

Authentication uses GH_TOKEN, GITHUB_TOKEN or PROJECT_PAT. Otherwise it reads and
verifies `gh`'s owner token without switching the active account. With a token and
`--repo`, gh and git are unnecessary. Never print credentials.

Auto-add and Roadmap date/marker settings may need a person. Print remaining
settings; use `--open-browser --wait-seconds 600` only for an interactive handoff.
Caller workflows need existing PROJECT_PAT and CLAUDE_CODE_OAUTH_TOKEN secrets,
and must reach the default branch before all event triggers work.

Respect host API restrictions: setup needs GitHub Projects GraphQL access. If
blocked, report that limitation. Do not bypass it. Writes are sequential, not
transactional; report completed steps and failures, and never blindly retry an
uncertain write. Finish with what changed, remaining settings and caller PR status.
