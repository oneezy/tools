# ADR-0002: Own skills are grouped by plugin under `skills/<plugin>/<skill>/`

Date: 2026-09-30. Status: accepted, amended 2026-10-01 by Justin's decision (oneezy/skills#27, corrections item A). Decided on oneezy/skills#17 under Justin's autopilot grant.

**Amendment.** `plugins/<id>/` is built into the repo and committed on `dev` and `main` (ADR-0003); `upstream/`, `artifacts/` and the layers stay gitignored. The text below is the original decision; read it with that substitution.

## Context

Own skills sat flat under `skills/<name>/`. Packaging them as plugins (`oneezy`, optional `trident`) needs a membership rule, and a future viewer should read that membership from the tree, not from a registry. `npx skills add oneezy/skills` walks `skills/` three levels deep, so one extra level is still found; `plugins/` and `upstream/` are never scanned by it.

## Decision

A folder directly under `skills/` that holds no `SKILL.md` is a group named after a plugin id; its children are own skills of that plugin. A folder that holds `SKILL.md` directly is a flat own skill, still accepted. The six `oneezy-*` skills move to `skills/oneezy/`; Trident's two authored skills join as `skills/trident/`. Generated output (`upstream/`, `plugins/`, `artifacts/`, layers) is gitignored on `dev` and `main`.

## Consequences

- Skill folder names are unchanged, so every existing link and every `/oneezy-*` invocation keeps working; the plugin form is `/oneezy:oneezy-brain`.
- The move lands together with the tool that reads groups (0.3.0); older tool versions see no own skills in a grouped library.
- Consumers of `npx skills add oneezy/skills` see each own skill exactly once, verified by a fixture run in the integration ticket.
