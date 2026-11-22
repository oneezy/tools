# ADR-0018: /oneezy-agents reads only the installed copy of agents.md

Date: 2026-10-13. Status: accepted; decision 4 (the loose source and its copy step) superseded by ADR-0019. Supersedes decisions 3 (a stale copy is a note), 4 (live from `dev`) and 5 (edited straight on `dev`) of ADR-0017; the rest of ADR-0017 stands.

## Context

ADR-0017 had `/oneezy-agents` fetch `skills/oneezy/agents.md` from `raw.githubusercontent.com` on `dev` first and fall back to the copy packaged in the plugin. Justin never meant the rules to come from GitHub: he wants every session to run on the `agents.md` inside the plugin it installed. On 2026-10-13 a claude.ai cloud session also showed a second gap: the Skill tool reported the skill's base directory as `/mnt/skills/plugins/oneezy:oneezy-agents/`, which did not exist, while the real install sat under `/root/.claude/plugins/synced/<id>/oneezy/skills/oneezy-agents/`. An agent that only reads `references/agents.md` beside the reported path finds nothing there.

## Decision

1. **The installed copy is the only source.** `/oneezy-agents` reads `references/agents.md` from the installed plugin. It fetches no remote copy, from GitHub or anywhere else.
2. **Find the installed copy when the reported path is wrong.** When the reported base directory lacks the file, the agent searches the harness's plugin folders for `oneezy-agents/references/agents.md` and reads that. When no installed copy exists, it tells Justin where it looked and stops.
3. **The copy line names the plugin.** The reply opens with `Loaded agents.md from the installed plugin`, plus the plugin version when readable.
4. **A rule change ships as a release.** The source stays `skills/oneezy/agents.md`, outside every package. A change refreshes the packaged copy (`node scripts/oneezy-capabilities.mjs --write`), bumps `library.version` and lands like any other library change, normally on a `land/*` branch. `scripts/oneezy-capabilities.test.mjs` fails while the packaged copy differs from the source, so an edit cannot reach `main` without shipping.

## Considered options

- **Keep the live fetch, packaged copy as fallback:** rules change without a release, but every session depends on GitHub and runs text no release recorded. Justin rejected it.
- **No fallback search when the reported path is wrong:** simpler, but the 2026-10-13 cloud session would have stopped with the file present on disk.
- **Keep a stale copy as a note:** a rule edited on `dev` would then never reach a session until someone noticed; the failing test makes the next pull request or push refresh it.

## Consequences

- A rule change reaches a harness after the next release and its sync, not at once; open sessions keep the rules they loaded.
- Every session runs the rules of a released, recorded plugin version, with no network needed to load them.
- An edit to `skills/oneezy/agents.md` without `--write` turns CI red until the copy is refreshed and the version bumped.
