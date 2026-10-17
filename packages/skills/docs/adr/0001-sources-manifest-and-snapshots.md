# ADR-0001: A committed config and snapshots replace `npx skills` at the library root

Date: 2026-09-30. Status: accepted, amended 2026-10-01 by Justin's decision (oneezy/skills#27, corrections item C); its lock decisions (the `npx skills` format, latest on every sync) superseded by ADR-0005; its per-machine `skills-sync.local.json` superseded by ADR-0012. Decided on oneezy/skills#16 under the autopilot grant.

**Amendment.** The committed config is `skills-sync.json` (not `skills-sources.json`); there is no `skills-sources-lock.json`: `skills-lock.json` stays the one record of what is installed, byte-compatible with `npx skills` plus the resolved commit; per-machine answers move to `skills-sync.local.json`, gitignored; the default is latest (every unpinned third-party skill moves to upstream's tip on `sync` and `refresh`), a pin is the explicit exception. The text below is the original decision; read it with those substitutions.

## Context

Third-party skills were pinned by `skills-lock.json`, written by `npx skills add/update` run at the library root. That lock records a content hash per skill but no commit, no policy and no per-source selection; `update` moves every skill or none; renames are impossible; and a root-level `add --all` writes into every agent folder it can find. The brief needs resolved commits, follow-or-pin per source, one explicit pin (`writing-for-agents`), snapshots to package third-party plugins with their licenses, and staging instead of root-level installs.

## Decision

`skills-sources.json` declares sources (repo, ref, policy, root, selected skills with optional renames, per-skill pins, attribution files) and plugins. `skills-sources-lock.json` records what `refresh` resolved (commit and date per source, path and hash per skill, transforms, releases). `upstream/<source>/` holds each source's selected folders at their upstream paths, generated and never edited. The working set copies from the snapshot. `skills-lock.json` is regenerated from the lock in the `npx skills` format so older tooling keeps restoring; `npx skills` itself no longer runs inside the library.

## Consequences

- Every machine's restore path changes with skills-sync 0.3.0; 0.1/0.2 keep working through the regenerated compatibility lock, without pins.
- Renamed third-party skills (`pstack-tdd`) exist only in the working set and packages, never in the snapshot.
- A source that follows a branch moves only when someone runs `refresh` or CI opens a refresh PR; nothing polls.
- Reversal would mean deleting the manifest and lock and returning to `npx skills` at the root, losing pins and renames.
