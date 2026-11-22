# ADR-0006: Plugin versions belong to their sources

Date: 2026-10-10. Supersedes the version rule in ADR-0003; related release policy: oneezy/tools#135 and layerdbiz/tridentcubed#157.

## Context

Generated `0.<build count>.0+<commit>` versions hid the source version and made an installed wrapper incomparable to upstream. Builds also treated every content change as a minor release.

## Decision

Imported plugins use the plain semantic version of their locked source snapshot. No published source version means no manifest version and `null` in release records. Source commits, dates and per-skill pins remain provenance, separate from version numbers.

Authored plugins share the explicit `library.version`. Start at `0.43.1`: a patch from Oneezy's previous `0.43.0`, and the migration point for Trident and Play to one repository version. Emoji-first conventional titles choose patch for fix, minor for feat, major for breaking changes, otherwise none. The highest required bump applies once to the release. Skill Sync reads the resulting version and never computes it from changed files or git history.

## Consequences

Matt Pocock packages report `1.3.1`, PStack `0.15.15`, and all authored groups `0.43.1` for this migration, without hash suffixes. The lock and skill selections do not move. Immutable bundle releases retain independent tags and content hashes, allowing snapshots and pinned skill combinations to differ while preserving their official source version.

The release validator compares authored semantic precedence and permits source snapshot changes and requested upstream downgrades. The native Codex installer records a separate content digest to refresh changed cache bytes at the same source version. Only tool-owned legacy generated versions bypass the newer-installed-version guard during migration.

Stable authored versions are supported first. Prereleases, release engine selection and automated repository-wide changelogs remain decisions for tools#135; Trident's rollout remains #157.
