# ADR-0010: The tool writes one session-start hook per harness

Date: 2026-10-11. Status: accepted. Reverses "no session hooks; the oneezy-skills skill runs the sync instead" (tools commit c252799 on `feature/skills-sync-npx`, PR #69; see `docs/research/skills-sync-baseline.md`) and the `oneezy-skills` rule "never hand edit settings or hooks" for this one entry. Decided in the Skills Sync repair grilling of 2026-10-10 (Q1, Q5, Q7, Q8).

## Context

Without a hook, a machine only caught up when someone asked `/oneezy-skills`, so skills drifted. The one hook that did exist, a hand-made `sync-dev.sh` on the PC, failed on dirty checkouts and had no Codex equivalent.

## Decision

- The tool adds exactly one entry per harness on PC and WSL (`~/.claude/settings.json`, `~/.codex/hooks.json`): `npx --yes @oneezy/skills-sync@latest hook`. It never edits or removes entries it did not write. `sync-dev.sh` is retired.
- `hook` runs quietly: it syncs (ADR-0008), refreshes the global block (ADR-0011), fast-forwards clean `dev` checkouts of oneezy/skills and oneezy/tools, warns about dirty or off-dev checkouts, and prints one line for branches and PRs not yet in dev.
- Cloud sessions never read user hooks; there the account plugins arrive on their own and the setup script only writes the global block.

## Consequences

- If Codex asks to trust the hook, that is a one-time manual step, listed at the end of `/oneezy-skills` with step-by-step instructions. A probe checks whether Codex asks at all.
