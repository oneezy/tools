# ADR-0019: Justin's rules live only in the oneezy-agents skill, as references/AGENTS-GLOBAL.md

Date: 2026-10-13. Status: accepted. Supersedes decision 3 of ADR-0017 (one source, outside every package) and decision 4 of ADR-0018 (the source stays outside the skill and is copied in).

## Context

ADR-0017 kept Justin's rules in a loose file, `skills/oneezy/agents.md`, so an edit there never changed a package, and `node scripts/oneezy-capabilities.mjs --write` copied it into `skills/oneezy/oneezy-agents/references/agents.md`. ADR-0018 made the packaged copy the only one sessions read. Two `agents.md` files with the same text, one copied from the other, read to Justin as the global rules being taken from a repo file. He wants one global file, the one inside the skill, edited directly and named `AGENTS-GLOBAL.md` so it reads as the global rules. The repo's root `AGENTS.md` is separate: it guides only work on oneezy/skills and was never part of this chain.

## Decision

1. **One file, named for what it is.** Justin's rules are `skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md`, edited in place. The capitalised, self-describing name keeps it apart from any repo's own `AGENTS.md`, on Windows too. The loose `skills/oneezy/agents.md` and the copy step in `scripts/oneezy-capabilities.mjs` are removed.
2. **A rule edit is a skill edit.** It changes the oneezy package, so it lands like any skill change: bump `library.version`, run `npx @oneezy/skills-sync build` and `check`, and push a `land/<topic>` branch (or a pull request into `dev`). The release that follows carries it to every harness.
3. **The root `AGENTS.md` stays repo-only.** Nothing is copied from it or into it.
4. **Sessions reach it through the pointer.** skills-sync's global block keeps telling every session to load `/oneezy-agents`, which reads this file; a repo's own `AGENTS.md` layers on top. skills-sync does not copy the rules into global files.

## Considered options

- **Copy the rules into the global files with skills-sync:** Claude Code and Codex would load them with no skill call, but Justin chose to keep the pointer for now.
- **Keep the loose file and the copy:** an edit never drifts the build, but there are two files with one meaning, and Justin rejected it.
- **Let `build --check` skip `references/AGENTS-GLOBAL.md`:** a commit straight to `dev` from the GitHub site would stay green, but `plugins/` and `dist/hermes/` would ship stale text, and it needs a change to skills-sync in oneezy/tools. Not now.

## Consequences

- An edit to `references/AGENTS-GLOBAL.md` that is committed without a rebuild turns `build --check` red until `build` runs and the version is bumped. The agent route in `/oneezy-agents` ("Changing a rule") does both.
- `scripts/oneezy-capabilities.test.mjs` fails if `skills/oneezy/agents.md` or `references/agents.md` comes back.
