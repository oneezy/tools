# Imported automation inventory

What the Library brought from the standalone `oneezy/skills` repository, who calls each piece, and what happens to it in tools. Read this before you move, delete or activate anything under `packages/skills/.github/`, or before you change a skill that drives a merge, a promotion or a release. Ticket: oneezy/tools#216 (spec #209). Inventory date: 2026-10-17.

## Ground rules

- **Two routes, kept apart.** *Git merge and promotion* moves commits: a `land/*` branch onto `dev`, then `dev` into `main`. *Plugin publication* turns a `main` commit into a GitHub release `release-<n>` that every machine's sync reads. A green merge is no proof that a release happened.
- **The live route is the standalone repository.** GitHub runs only workflows under a repository's root `.github/workflows/`. The copies under `packages/skills/.github/` are inert in tools. `oneezy/skills` still has its own registered `land`, `library`, `run` and `task-manager` workflows, and still cuts the releases that machines read (`DEFAULT_REPO` in `packages/skills-sync/src/release.ts`). That route stays as it is until the release destination is decided.
- **Activation is a migration.** Moving a nested workflow to the root `.github/` would make it run against tools: `land.yml` would promote all of tools' `dev` to `main`. Keep nested workflows nested until a tested migration says otherwise. Root `.github/` changes go through a person's merge.

Callers in the standalone repository were traced from the imported copy. A read of `oneezy/skills` over `gh api` was refused (HTTP 403) on 2026-10-17. The list of registered workflows above comes from the read-only audit in `packages/skills-sync/docs/skills-import-audit.md`.

## Classes

- **Retained**: kept as it is. It is live in `oneezy/skills`, or it is the source of a behavior we still need.
- **Adapted**: kept and changed to fit the workspace.
- **Consolidated**: merged into another copy. Nothing is in this class yet. See *Decision-dependent items*.
- **Removed**: deleted after its callers and its replacement were checked.

## Workflows (`packages/skills/.github/workflows/`)

| File | Route | Class | Callers | Calls and produces |
| --- | --- | --- | --- | --- |
| `land.yml` | Git merge and promotion | Retained | A push of `land/**` to `oneezy/skills`. Pushed by agents through `/oneezy-skills` (`references/changes.md` **Land**), `/oneezy-migrate` (`references/workflow.md`) and `/oneezy-agents` (`flow.yaml`), and by `run.sh`. | It squashes the branch onto `dev` and refuses changes to `.github/`. Then it runs the published CLI checks, pushes `dev`, and merges `dev` into `main` with a merge commit. It calls `gh workflow run library.yml --ref main -f job=release` and deletes the branch. It uses `actions/skills-sync-cli`. |
| `library.yml` | Plugin publication (`release` job); CI (`check` job) | Retained | Pull requests and pushes to `dev` and `main` of `oneezy/skills`. Also `workflow_dispatch job=release` from `land.yml`. | `check` runs the capability test, `refresh --frozen`, `build --check`, `check`, the Brain, provider and debug tests, the release-script tests and `claude plugin validate`. `release` runs `build --artifacts`, then `release.mjs`, then `gh release create release-<n>` with the archives and `release.json`. |
| `run.yml` | Library command; hands off to Git promotion | Retained | Daily at 08:23 UTC. Also `workflow_dispatch` from `/oneezy-skills` (`references/changes.md` **Dispatch**: `gh api repos/oneezy/skills/actions/workflows/run.yml/dispatches`). | `run.sh` with the published CLI and the `PROJECT_PAT` secret. It produces one `land/<command>-<args>-<run id>` branch, or nothing. |
| `task-manager.yml` | Board automation | **Removed** | `oneezy/skills` events, in that repository's own registered copy. In tools, nothing: GitHub never reads this path. | It called `oneezy/tools/.github/workflows/task-manager.yml@main`. It was a stale copy of `packages/task-manager/caller.yml` that lacked the `start` input. |

Why the removal is safe: tools' own events already reach the root `.github/workflows/task-manager.yml`, which is the host workflow, not a caller. `task-manager.ps1` (`Ensure-Caller`) writes any other repository's caller from `packages/task-manager/caller.yml` and opens a pull request when a copy is missing or different. It leaves tools alone as the host. Two comments still mention a `task-manager.yml` secret: `run.yml` and `run.sh` mean the `PROJECT_PAT` that `oneezy/skills`' own copy uses. That copy is not this file. Nothing reads the deleted file.

## Actions

| File | Class | Callers | Notes |
| --- | --- | --- | --- |
| `packages/skills/.github/actions/skills-sync-cli/action.yml` | Retained | The nested `land.yml`, `library.yml` and `run.yml` (`./library/.github/actions/skills-sync-cli`). | It installs `@oneezy/skills-sync@latest` from npm and outputs `cli` and `version`. |
| `.github/actions/skills-sync-cli/action.yml` (root, tools) | Retained, untouched | Root `branches.yml`. | Same install, plus `package-manager-cache: false`. setup-node v5 enables a pnpm cache from the root `packageManager` field and fails without pnpm on `PATH`. Only this copy works in a tools checkout. The two are not duplicates. |

## Scripts and tests

| File | Class | Callers | Coverage |
| --- | --- | --- | --- |
| `.github/scripts/release.mjs` | Retained | The `library.yml` release job. Its `release.json` (schema 3) is read by `parseRelease` and `latestRelease` in `packages/skills-sync/src/release.ts`, by every machine's `sync` and `status`, by `/oneezy-skills` `references/chatgpt-update.md`, and by `release-chain.test.mjs`. `packages/skills-sync/test/fixtures/fake-github/fake-github.mjs` copies its shape. | `release.test.mjs`, `tests/release-chain.test.mjs` |
| `.github/scripts/release.test.mjs` | Retained, now in workspace validation | `library.yml` `check` and `land.yml` (`node --test library/.github/scripts/*.test.mjs`). In tools: the package `test` task. | 10 tests |
| `.github/scripts/run.sh` | Retained | `run.yml`. | `run.test.mjs` |
| `.github/scripts/run-report.mjs` | Retained | `run.sh` (`apply-config`, `message`). Its commit message becomes `dev`'s squash message in `land.yml`. `/oneezy-skills` (`references/changes.md` **Dispatch** step 4) reads it back for `/oneezy-migrate`. | `run-report.test.mjs`, `run.test.mjs` |
| `.github/scripts/run-report.test.mjs` | Retained, now in workspace validation | Same glob as `release.test.mjs`. | 10 tests |
| `.github/scripts/dry-run.mjs`, `run.test.mjs`, `land.test.mjs` | Added | The package `test` task, and the same glob in the standalone CI. | Offline dry runs on a bare repository and a fake `gh`. They need bash and skip on a host without it. |
| `tests/release-chain.test.mjs` | Added | The package `test` task, which builds `@oneezy/skills-sync` first. | Offline publication chain. |
| `scripts/oneezy-capabilities.mjs` and its test | Retained | The package `check` and `test`, `library.yml` `check`, and `docs/agents/release.md` step 2 (`--write`). It copies `docs/agents/capabilities/` into 11 skills. | Its own test |
| `tests/brain-drive`, `provider-capture`, `oneezy-debug-trace` `.test.mjs` | Retained | The package `test` task and `library.yml` `check`. | Their own tests |
| `tests/brain-visible-capture.test.mjs` | Retained | Only the package `test` task. `library.yml` `check` does not list it. | Its own test |

## Configuration

| File | Class | Callers and notes |
| --- | --- | --- |
| `package.json` | Adapted | The `test` script moved into `vite.config.ts` as a task. |
| `vite.config.ts` | Adapted | It adds a `test` task that runs `tests/`, the capability test and `.github/scripts/*.test.mjs`. The task depends on `@oneezy/skills-sync#build` and is uncached. Root `pnpm test` (`vp run -r test`) runs it. For this package alone, run `vp run --filter @oneezy/skills test`. `package-plugins` is unchanged. |
| `skills-sync.json`, `skills-sync.lock.json` | Retained | The workspace build and `develop`. In `oneezy/skills`, `releaseConfig` reads the copy at the release commit. The root `publish-skills-sync.yml` guard runs the new CLI against a fresh `oneezy/skills` checkout, not against this copy. |
| `.gitignore` | Retained | It ignores `plugins/`, `.claude-plugin/`, `.agents/` and `artifacts/`. The standalone repository commits the first three, and `library.yml` (`build --check`) and `release.mjs` (it reads committed `plugins/`) depend on that. This mismatch is the main reason the workflows cannot run from tools unchanged. |
| Root `publish-skills-sync.yml`, `branches.yml`, `automerge.yml` | Retained, untouched | Root tools workflows that name the standalone Library: the publish guard checks against it, `branches` keeps its schedule clear of `run.yml`, and `automerge` mirrors `land.yml`'s gate. |

## Skill instructions that target the standalone workflows

Every one names `oneezy/skills` explicitly, so each is still correct while the standalone route stays. Class: **Retained, decision-dependent**. Adapt them once the release destination is chosen.

| Skill file | What it drives |
| --- | --- |
| `oneezy-skills/SKILL.md`, `references/changes.md`, `references/report.md`, `references/requests.md`, `references/chatgpt-update.md`, `flow.yaml` | **Land**: clone `oneezy/skills` at `dev`, push `land/<topic>`, wait for `land`, then for the `library` release. **Dispatch**: `run.yml`. Sync reads the latest `oneezy/skills` release. |
| `oneezy-migrate/references/workflow.md`, `flow.yaml` | A migration in `oneezy/skills` lands through `land/migrate-<slug>`. `MIGRATIONS.md` is a historical record; leave it as written. |
| `oneezy-agents/SKILL.md`, `flow.yaml`, `references/AGENTS-GLOBAL.md` | A rule change lands on a `land/*` branch. `main` changes only through `/oneezy-merge` or `oneezy/skills`' `land/*`. |
| `docs/agents/capabilities/catalog.json`, copied into 11 skills' `references/capabilities/` | The `oneezy-agents` GitHub dependency: "landed on a land/* branch". |
| `oneezy-naming/SKILL.md` | It keeps `oneezy/skills`' `release-<n>` scheme. |
| `oneezy-merge/SKILL.md`, `scripts/fast-forward-dev.mjs` | Git merge and promotion only. It leaves publication to a release skill or to the repository's main workflow. Owned by #218 and #220; `references/modes.md` is out of scope here. |
| `oneezy-status/references/skills-sync.md` | It reports against the latest `oneezy/skills` release. Owned by #218; out of scope here. |
| `README.md`, `docs/agents/library.md`, `docs/agents/release.md`, ADR-0005, 0009, 0014, 0018, 0019 | They describe the standalone route as it still runs. Keep their rationale. ADR-0020 records the local development exception. |

## Caller to command to artifact, as tested

| Route | Caller | Command | Artifact | Test |
| --- | --- | --- | --- | --- |
| Library command | `run.yml` environment | `run.sh`, then the CLI's `update`/`add`/`remove`/`versions` | One `land/<command>-<args>-<run id>` branch on `dev`'s tip with `run-report.mjs`'s message. `dev`, `main` and the tags are unchanged. Unchanged runs, `versions` and refusals push nothing. | `.github/scripts/run.test.mjs` |
| Git merge and promotion | A push of `land/<topic>` | `land.yml`'s steps, read from the workflow file | One squash commit on `dev`. `main` merges `dev`. One `gh workflow run library.yml --ref main -f job=release`. The branch is deleted, no tag is made. A `.github/` change or an empty branch lands nothing. | `.github/scripts/land.test.mjs` |
| Plugin publication | The `library.yml` release job | The workspace CLI's `build --artifacts`, then `release.mjs` | Archives and `release.json`, `release-1` then `release-2`. "Nothing changed" releases nothing. Changed files at the same authored version fail. | `tests/release-chain.test.mjs`, `release.test.mjs` |
| Machine consumption | `sync`, `status` | `parseRelease` | `release.json` read back with every file's sha256 as built. | `tests/release-chain.test.mjs` |

Not covered offline: the real GitHub triggers (a `GITHUB_TOKEN` push starts no workflow, so `run.yml` needs `PROJECT_PAT`), `gh release create` and release immutability, `claude plugin validate`, the published npm CLI, and `land.yml`'s check step.

**Finding:** `land.yml`'s check step says it checks "exactly as library.yml check does". It runs only `refresh --frozen`, `build --check`, `check` and the release-script tests. It skips the capability, Brain, provider and debug tests and `claude plugin validate`. `land.yml` pushes `dev` and `main` before the full `library.yml` check runs. The dispatched `library.yml` run still checks fully before the `release` job, so no release skips the full check, but a promotion can. Fix it in the live `oneezy/skills` workflow; this ticket edits no other repository.

## Decision-dependent items

These stay as they are until Justin decides. Each one is blocked on the release-destination decision, which spec #209 leaves open.

1. **Release destination.** It could stay `oneezy/skills`, move to a new distribution repository, or move into tools. That choice decides where `land.yml`, `library.yml` and `run.yml` run, and which repository `DEFAULT_REPO` names.
2. **Reaching the release source.** Authoring now happens in `packages/skills`, but releases are cut from `oneezy/skills` `dev` and `main`. Nothing in tools carries a `packages/skills` change there. `/oneezy-skills` **Land** clones `oneezy/skills` and pushes there, so it edits a different copy from the workspace package.
3. **Committed or ignored packages.** `library.yml` (`build --check`) and `release.mjs` expect committed `plugins/` and catalogs. tools ignores them. Running either from tools needs the release job adapted, or the packages committed.
4. **Automatic promotion scope.** `land.yml` promotes the `dev` and `main` of whichever repository it runs in. In tools that would release every package. Nobody has authorized that.
5. **Action consolidation.** Merge the nested `skills-sync-cli` action into the root one, which keeps `package-manager-cache: false`, only when the workflows move.
6. **Skill instruction adaptation.** Retarget the files in *Skill instructions that target the standalone workflows*, and the off-limits `oneezy-merge/references/modes.md` and `oneezy-status`, after items 1 and 2.
7. **The `land.yml` check gap** in the *Finding* above. Fix it in `oneezy/skills`, or as part of the migration.
8. **Development state storage** (ADR-0020). The format for a Development project's ownership and previous-state records is not chosen yet.
