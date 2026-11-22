# ADR-0003: Built plugins are committed in the library; the catalogs point at `./plugins/<id>`

Date: 2026-09-30, superseded 2026-10-01 by Justin's decision (oneezy/skills#27, corrections item A). The original text proposed a generated `plugins` branch fed by CI; that design is withdrawn. On machines, "both forms stay" is amended by ADR-0007: the library builds both, each harness gets one.

## Context

A Claude Code marketplace resolves relative plugin paths from its own clone, so packages listed as `./plugins/<id>` must be committed on the branch users add. The first draft kept generated files off `dev`/`main` by publishing them to a `plugins` branch from CI. Justin's rule for this library: CI only checks; it never pushes or publishes; the library is its own marketplace.

## Decision

`build --plugins` writes `plugins/<id>/` beside the source and the result is committed on `dev` and `main` like any other change, by Justin or by an agent on a task branch. The root catalogs `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` list each plugin with a `./plugins/<id>` source. Both forms stay: the loose-skill form (`skills/`, linked into harnesses) and the plugin form, each behind a boolean in `skills-sync.json` (`generate.skills`, `generate.plugins`, default true). `.claude-plugin/plugin.json` inside a package carries no `version`, so Claude Code tracks commits; the portable and legacy manifests carry `0.<commit count>.0+<sha12>`. CI runs `check` (including `build --check`) and fails on drift.

## Consequences

- `/plugin marketplace add oneezy/skills` and `codex plugin marketplace add oneezy/skills` work from the default branch with nothing else running.
- Every `SKILL.md` of an own skill exists twice in the tree (`skills/…` and `plugins/<id>/skills/…`); how `npx skills add oneezy/skills` lists such a skill is a verification item on tools #72, and a duplicate listing is fixed there, not ignored.
- Reviews contain generated files; `build --check` in CI keeps them honest.
- Reversal to a generated branch is the original text of this ADR, in git history.

## Amendment 2026-10-01: the copies carry `metadata.internal: true`

The duplicate-listing probe (`docs/research/duplicate-listing-probe.md`) showed that committed plugin copies make `npx skills update` in a consumer project skip every own skill as ambiguous. Justin chose fix d1: `build --plugins` inserts `metadata.internal: true` into the frontmatter of every skill copy under `plugins/<id>/skills/` (own and third-party), `build --check` compares after that transform, and `INSTALL_INTERNAL_SKILLS=1` re-exposes the copies. The copies therefore differ from their sources by that one line; everything else in this ADR stands.
