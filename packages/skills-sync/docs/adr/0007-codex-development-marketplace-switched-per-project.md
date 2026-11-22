# ADR-0007: Codex loads Development builds from a development marketplace, switched on per project

Date: 2026-10-17. Status: accepted for implementation; the adapter stays unverified until the Windows proof in Codex in the ChatGPT desktop app (#217). Recorded by oneezy/tools#214.

## Context

Codex has no project-scoped install. A plugin lives once per user, as a copy that `codex plugin add` makes in `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, and Codex loads that copy, never its source. It does not dedupe by name: with two enabled copies of `play`, both `play:*` skill sets load. A trusted project's `.codex/config.toml` overrides the user `config.toml` per plugin id (`[plugins."<name>@<marketplace>"] enabled`). An untrusted project's file is ignored. OpenAI documents that a project cannot override a workspace-managed plugin.

These behaviours were observed with codex-cli 0.163.0 against a temporary `CODEX_HOME`:

- Every `codex plugin add` sets the user switch of that id to `enabled = true`. It rewrites the value in place, keeps comments, and does so even when the value was `false`. A `-c` override does not change what it writes.
- A second add with the same version replaces the cache copy whole.
- `codex plugin list` reports the user switch only. `codex -C <project> debug prompt-input` shows what loads in that project.

`pnpm skills:dev` (develop.ts) already owns a marked block in a workspace's `.codex/config.toml`, which switches the Library's plugins off there.

## Decision

- **A development marketplace.** It is named after the release marketplace with `-dev` (`oneezy-skills-dev`), and its catalog is `<library>/dist/development/.agents/plugins/marketplace.json`. It lists every Plugin with a Development build. Setup registers it once with `codex plugin marketplace add`. Plugin names stay normal: only the marketplace part of the id differs.
- **Off for every project, on in a Development project.** The user switch of each `<id>@<dev>` is `false`. The project's block, between `# skills-sync:development-plugins:start` and `:end`, switches the selected `<id>@<dev>` on. It switches every same-name copy from another marketplace this machine added off, and the release catalog's copy even before sync installs it (ADR-0008).
- **Add, then switch off at once.** Setup adds a Plugin only when Codex's cached copy differs from the build (compared file by file, as develop-build hashes output). Right after each add, it switches the copy off again in the user `config.toml`. That write is planned against the bytes just read, then read back. When it cannot be done, setup removes that copy from Codex and activates nothing.
- **The project block comes last.** Setup writes it only once the copies are installed and off everywhere else. Remove takes it back first, and only while it is what setup wrote (CRLF line endings count as unchanged). It deletes the file and the `.codex` folder when setup made them and nothing else is left. The last project to leave removes the copies and the marketplace from Codex. They stay while a kept, changed block still switches them on, and while `dist/development/projects.json` is missing or unreadable, since then no project can tell it is the last.
- **Merged with `pnpm skills:dev`.** A key that block already switches off is left to it (recorded as `covered`). develop.ts keeps setup's block, repeats none of its keys, and leaves the development marketplace's copies alone. A key set anywhere else in the file stops setup, so no key is ever set twice.
- **Refused before anything changes:**
  - an enabled same-name copy from the ChatGPT account or a workspace (a remote marketplace this machine never added)
  - a `.codex/config.toml` that git tracks (the switches would be committed and reach cloud sessions)
  - a block changed by hand
- **A restart is reported, never forced.** After an add or a block change, setup says to restart the ChatGPT desktop app (a CLI needs a new session). `develop status` reads what loads with `codex -C <project> debug prompt-input`. It names the states `active`, `stale`, `released copy loaded`, `duplicate` and `on everywhere`, and the inactive entries that stay visible in Codex's plugin list.

## Open decision for Justin

**The re-enable window.** Between a `codex plugin add` and the switch-off that follows it, the development copy is on for every project. Setup measures and reports the window in milliseconds; a run that dies inside it leaves the copy on until the next setup, and `develop status` names it `on everywhere`. Supported controls offer no add that leaves the switch alone. Justin decides whether this guarded sequence is acceptable, or whether the desktop proof must find a safer route, such as a repo-scoped marketplace.

## Considered options

- **A project-scoped marketplace** (`<project>/.agents/plugins/marketplace.json`): the docs say the desktop app reads it, but codex-cli 0.163.0 neither lists it nor adds from it. It is unproven, and #217 checks it.
- **Disabling the development copy where an add cannot flip it** (a `-c` override, a profile): an add writes the user file regardless.
- **Editing the cache copy in place**: the spec forbids treating caches as editable source.
