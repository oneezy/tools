# ADR-0008: Every caller runs `@oneezy/skills-sync@latest`, guarded so a sync never leaves a broken setup

Date: 2026-10-11. Status: accepted. Replaces the `@^0.7.x` range in `skills/oneezy/oneezy-skills/scripts/sync.ps1` and `sync.sh`. Decided in the Skills Sync repair grilling of 2026-10-10 (Q4, Q9).

## Context

The wrapper scripts pinned `^0.7.6`, CI pinned a commit that exists only on a tools feature branch (`SKILLS_SYNC_REF: 914a0ab`), and machines ran whatever they had cached, so the PC sat on a local 0.3.0 while npm had 0.7.6. A range pin keeps a fix from reaching machines; plain `@latest` risks a bad publish reaching every machine at once.

## Decision

- Every caller (wrapper scripts, hooks, setup script, CI) runs `npx --yes @oneezy/skills-sync@latest`.
- Publishing is guarded: the publish workflow in oneezy/tools runs the new build against oneezy/skills `main` and refuses to publish if it fails.
- A sync checks before it changes: it compares what each harness has against the latest release of oneezy/skills and changes only what differs. If any step fails, it leaves the working setup as it was and reports what failed.
- Installed plugins follow the latest release (main). Repo checkouts follow dev.
