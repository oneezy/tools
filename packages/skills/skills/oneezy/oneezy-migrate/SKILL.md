---
name: oneezy-migrate
description: "Apply the breaking and migration notes of third-party skill updates across Justin's repos (brain, skills, tools, ai-workflow, Trident), or say in one line that none applies. Use after every /oneezy-skills update, upgrade, downgrade or add, and when Justin says 'migrate my repos', 'migrate my repos to Matt 1.3.1' or 'catch up on what upstream changed'."
argument-hint: "an update report (skills-sync update --json) | <source> [<from>] <to>, e.g. 'matt-pocock 1.3.1'"
---

Apply consumer-facing upstream migration notes to Justin’s repositories, using the update report or named version range. Read `references/workflow.md` before extracting notes: it owns input fields, range/downgrade handling, recipes, repo/base/landing paths and report shape. Read `MIGRATIONS.md` for an applicable recipe; add a missing recipe in that shape.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

No consumer migration note: report one line and stop. Inspect fresh clones; do not change working checkouts. Apply only a matching old convention, run the repo’s own checks, and use its landing path within the user’s requested scope. A review-only/no-publication request holds changes on a review branch; it overrides automatic landing. Report unreachable repos and unapplied notes precisely.

## Boundaries

- Never re-run a third-party setup skill to apply a rename (`/setup-matt-pocock-skills` renames nothing, and its GitHub template writes `gh issue` commands, which undo the REST-only `docs/agents/issue-tracker.md` these repos keep).
- Change what the repo reads today: its own files and live docs. Dated records (`docs/research/`, `.research/`, ADR history, changelogs) and test fixtures of other tools (the skills-viewer examples in `oneezy/tools`) say what was true when written and stay as they are.
- Third-party skills are never edited, deselected or removed to fit a repo; the repo changes, or the note is reported.
- Own skills that name another repo's file (`skills/trident/*` naming Trident's `packages/ui/CONTEXT.md`) change in the same skills-repo landing as that repo's rename, never before it.

Done means every applicable repo is changed and verified, no change, or reported not reached; every unapplied note has a reason.
