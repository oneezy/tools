# ADR-0020: Development projects are a narrow local exception to release-only installation and settings on GitHub

Date: 2026-10-17. Status: accepted. Amends ADR-0007 (one form per harness, installed from GitHub or the account, with no library on the machine) and ADR-0012 (settings live in the config on GitHub; no local file), for Development projects only. Their text and rationale stand for everything else. The behavior was confirmed by Justin on 2026-10-17 (spec oneezy/tools#209, `packages/skills-sync/docs/development-plugins.md`). Recorded by oneezy/tools#216.

## Context

ADR-0007 and ADR-0012 fixed a real failure. A machine had library clones that the tool re-pointed at whichever checkout ran last, loose links into several copies, and a per-machine settings file that drifted. There were three places to edit, and nobody could tell which copy a Harness was reading. The cure was a single editable source on GitHub, a release as the only thing a machine installs, every installed copy treated as a cache, and shared settings only in the committed `skills-sync.json`.

The Library is now a permanent workspace package in tools (`packages/skills`), and Justin authors there. He wants to try a skill change as a real Plugin, under its normal name, in a project on his own machine, before it is released. Both ADRs forbid that as written. A Development build is installed locally instead of from a release, and reversing a project's selection needs a record of that project's previous state on the machine.

## Decision

1. **The exception is the Development project.** A local project that Justin explicitly opts in may install Project plugins from the Library's Development build. In that project only, they take precedence over the matching released Plugins. Every other project, every cloud host (Claude.ai, ChatGPT.com, cloud sessions) and the account plugin selection keep the released form of ADR-0007.
2. **One editable source still holds.** Every authoring link resolves to `packages/skills`. Development output and Harness caches stay caches, never places to edit. A Development project has one active copy of each Plugin. Installed, built, loaded and invoked are reported as separate states, so it is always clear which copy a Harness reads. That is the problem ADR-0007 solved.
3. **Local records are limited to reversal.** A Development project may keep machine-local records of what development mode owns and of the selection it replaced, so that switching off restores that selection. These records are not settings. Shared settings stay in `skills-sync.json` (ADR-0012). The records are never committed in a form that changes another machine or a cloud session. Their format is not chosen yet.
4. **Release stays the only publication.** Development output is never uploaded, tagged or installed outside a Development project. Release generation never overwrites or activates development output. The release route (`docs/agents/release.md`, `docs/agents/imported-automation.md`) is unchanged.
5. **Machine commands still read the release.** `sync`, `status` and `hook` take the Library from its latest release, as ADR-0007 says. A tools checkout on the machine is a development source, not a machine library for those commands. Normal sync keeps the released form everywhere else and respects an active Development project.

## Considered options

- **Rewrite ADR-0007 and ADR-0012:** one fewer document, but it erases the reason the rules exist, and a later agent could bring back the drifting clones and settings file they removed.
- **Development-only Plugin names (a `dev-` prefix):** no precedence question, but commands and skill references would change between development and release. Rejected in spec #209.
- **Change account plugin enablement or edit Harness caches for the project:** forbidden by spec #209, because it reaches beyond the project and the cloud.

## Consequences

- The exception holds only once Harness runtime proof exists: whole-plugin loading, same-name precedence and reload in Claude Code; local installation, cache refresh and project-scoped precedence in Codex Desktop. If project-only precedence cannot be achieved through supported controls, return to Justin before building a substitute.
- When the release destination changes (`docs/agents/imported-automation.md`, *Decision-dependent items*), revisit ADR-0007's "GitHub `oneezy/skills` is the one place skills are edited". Authoring has already moved to tools. Releases have not.
