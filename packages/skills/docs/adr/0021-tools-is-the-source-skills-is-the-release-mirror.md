# ADR-0021: oneezy/tools is the skills source; oneezy/skills is its release mirror

Date: 2026-11-21. Status: accepted. Decided by Justin on oneezy/tools#240. Changes the landing route of ADR-0019 decision 2 (a rule edit now lands as a pull request into tools `dev`); ADR-0007, ADR-0008 and ADR-0018 stand as written.

## Context

Since spec #209 the authored skills live in oneezy/tools `packages/skills`, but everything that delivers a skill reads oneezy/skills: its `library.yml` cuts `release-<n>`, `@oneezy/skills-sync` reads its latest release (`DEFAULT_REPO`), and the claude.ai, Codex and Hermes installs read the built plugins and the two marketplace catalogs committed on its default branch. tools deliberately does not commit that build output. So a skill had to be edited in both repos (#232, #234), and a skill only in tools (`oneezy-task-manager`) reached no harness. Justin no longer edits oneezy/skills.

## Decision

1. **One source.** Every skill, rule and library doc is edited in oneezy/tools `packages/skills`, through a pull request into tools `dev`.
2. **oneezy/skills is generated.** `packages/skills/scripts/publish-mirror.mjs` copies the package into an oneezy/skills checkout, builds it there with the published `@oneezy/skills-sync`, and pushes `land/mirror-<tools sha>`. oneezy/skills' own `land.yml` squashes it into its `dev`, promotes `main`, and `library.yml` cuts the release. The mirror's root `README.md`, `AGENTS.md` and `CLAUDE.md` come from `packages/skills/mirror/`; its `.github/` is left alone.
3. **When it runs.** After each promotion of tools `main` that changes `packages/skills`, as a step of `/oneezy-merge release`.
4. **Nothing moves on any machine.** Releases keep their numbering (`release-37` onward) on oneezy/skills, and every harness keeps reading it.
5. **The daily upstream check pauses.** oneezy/skills' `run.yml` would land source updates into the mirror behind tools' back, so it is disabled; `update` runs when Justin asks, in tools.

## Considered options

- **Direct: every harness reads tools.** Needs the build output and both marketplace catalogs committed in tools, a new skills-sync default, taps on claude.ai and ChatGPT, and PC runs for Codex and Hermes. Kept open as a later stage; then oneezy/skills can be archived.
- **Keep editing both repos.** Rejected: every change is made twice, and the two drift.

## Consequences

- A hand edit in oneezy/skills is overwritten by the next mirror run.
- A release needs Justin's `/oneezy-merge release` line in tools, then the mirror run; the session that runs it needs push access to oneezy/skills.
- Third-party sources move only on request until tools has its own upstream-check workflow.
