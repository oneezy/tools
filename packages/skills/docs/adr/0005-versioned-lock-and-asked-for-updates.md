# ADR-0005: A per-source lock with upstream versions, and sources that move only when asked

Date: 2026-10-06. Status: accepted; "nothing moves upstream on its own" superseded by ADR-0009. Supersedes ADR-0001's lock decisions (the `npx skills` format, latest on every sync). Decided in Justin's grilling session of 2026-10-06; spec oneezy/tools#99, built in @oneezy/skills-sync 0.5.0 (tools#100 to #105) and adopted here by tools#106 to #109.

## Context

`skills-lock.json` listed 86 skills one by one in the `npx skills` format, each repeating its source and commit, and recorded no version: nobody could see that Matt Pocock's skills sat between 1.2.3 and 1.3.0. Every sync quietly moved every source to upstream's tip whenever a pull was due, rewrote the lock on that machine only, and undid any version held on purpose, so hosts drifted from `main` and from each other. There was no way to say "update only Matt's skills" or "go back to the previous PStack release", and upstream convention changes (Matt's `CONTEXT.md` → `GLOSSARY.md` in 1.3.0) went unnoticed. There was also nowhere to try a skill without putting it straight into `oneezy` or `trident`.

## Decision

- The lock is `skills-sync.lock.json`, version 2, grouped per source like the config: repo, ref, `version` (plain semver or null: the nearest release tag, else the source's plugin or package manifest version), commit, date, and each skill's upstream path and content hash (a commit only where a pin holds it elsewhere). The name keeps `npx skills` from mistaking it for its own lock.
- The config keeps intent only. A source may carry `version` to hold it at a release; no `version` means latest. The tool never writes the config (except `add`); a hold is a config edit landed with the update.
- Nothing moves upstream on its own. A sync (setup script, session-start hook, `--watch`, CI) installs exactly the committed lock. Only `update [<source>] [--to <version>|previous|latest]` moves a source, and its report carries each moved source's old and new version and the upstream changelog between them.
- Justin asks in words through `/oneezy-skills`; each change lands through a `land/*` branch with no review, releases and syncs, then `/oneezy-migrate` applies any migration note across his repos (or says nothing applies).
- `play` is a group like `oneezy` and `trident`, packaged and released the same way; every skill in it is named `play-<name>`, and `check` enforces it. Promotion moves the folder and renames it `oneezy-<name>` or `trident-<name>` unless Justin names it.
- A third-party skill is never removed or deselected to make room for one of Justin's; his copy is renamed.

## Consequences

- Every host runs what `main` says, and a release (`release.json`, schema 2) hashes `skills-sync.lock.json`.
- Moving a source is a commit and a release, so it is visible and reversible: `update <source> --to previous`.
- Older skills-sync versions (before 0.5.0) cannot read the new lock; CI and `land.yml` build the tool at 0.5.0, and machines run `@latest`.
- The library's own `refresh` job in CI is now `update` across every unheld source, as a pull request; the day-to-day path is `/oneezy-skills`.
