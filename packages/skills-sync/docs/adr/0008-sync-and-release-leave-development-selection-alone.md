# ADR-0008: Sync and release packaging leave the development selection alone; switch-off keeps the output

Date: 2026-10-17. Status: accepted. The adapters it relies on stay unverified until the Windows proof (#217). Recorded by oneezy/tools#215.

## Context

Development projects (ADR-0002, ADR-0006, ADR-0007) share the machine with three other writers:

- **Machine sync**, which the session hook runs in whatever project a session opens.
- **The release build** (`build --plugins --catalogs`, `build --artifacts`).
- **The release job's `release.mjs`.**

All three were written before development mode existed.

Sync drives the Harness CLIs from the user's home folder (install.ts `runner`), so it reads user-level state in every project. In that state each development copy is installed and switched off. The development marketplaces are named after the release catalog:

- Claude Code: `oneezy-skills-development`
- Codex: `oneezy-skills-dev`

The Codex form used to read the development copy as a duplicate to uninstall by hand. The release build deleted `dist/development` whenever `renderings.hermes` was `dist`, and wrote among the Development builds when it named a folder inside it.

## Decision

- **The development marketplaces' copies are never sync's.**
  - `desired.ts` `developmentMarketplaceOf(catalog, harness)` names each marketplace, and both adapters take the name from it.
  - Sync never adds, removes, upgrades or switches a copy from them.
  - Claude Code's form already acts only on `<id>@<release catalog>` installs. A project's local `false` keys outrank the user state that sync changes.
  - Codex's form notes a development copy that is off and keeps it. One switched on for the user doubles the release copy in every project, so sync reports it red and changes nothing. `status` lists the same case as the manual step `development-everywhere`: run `develop setup` in a Development project, which switches the copy off again.
- **A Codex project block switches the release catalog's copy off before it is installed.** Sync can install `<id>@<release catalog>` after a project was set up. Its `codex plugin add` switches that copy on for the user. The block already holds it off in that project, so the development copy stays the only one loaded there.
- **The release build refuses a Hermes rendering that overlaps `dist/development`.** The check is `build.ts` `renderingOverlap`, which the development build shares. The release build then builds nothing and reports one conflict, and `--check` reports it as drift. Release generation writes only `plugins/`, the Hermes rendering, the two root catalogs and `artifacts/`. `release.mjs` reads `plugins/` and `artifacts/` only.
- **Development commands publish nothing.**
  - `develop build`, `setup`, `status` and `remove`, and the watcher, which runs the same build, make no GitHub request.
  - They leave `skills-sync.json`, the lock, `plugins/`, the root catalogs and `artifacts/` unchanged.
  - They run no command on the release marketplace or its plugins.
- **Switch-off keeps the development output.** `develop remove` never deletes `dist/development`, and nothing deletes the build of a Plugin dropped from the config. To delete it by hand, wait until no project is set up:
  1. Codex: the last remove has already taken `oneezy-skills-dev` out.
  2. Claude Code: run `claude plugin marketplace remove oneezy-skills-development`. The adapter never runs it, because it uninstalls the marketplace's Plugins in every project; with no project left there are none.
  3. Run `rm -r <library>/dist/development`. The next `develop setup` builds it again.

## Considered options

- **Switch-off deletes the output no remaining project uses.** Rejected for three reasons:
  - Claude Code keeps the development marketplace in the user's `known_marketplaces.json` after the last local declaration is gone. With its directory missing, it would likely read as a broken marketplace in every project (inferred; #217 checks it).
  - The watcher (ADR-0005) may still be running, and its last successful build is the safe state it promises to keep.
  - The output is derived and gitignored. Keeping it costs disk space only, while deleting it in the wrong order breaks other projects.
- **Sync re-applying each Development project's block after it installs.** Sync has no Library and does not know the projects. A block that holds the release copy off from the start needs no second writer.
- **Sync switching a development copy off when it finds it on everywhere.** That would put a second writer on the adapter's user switch. Reporting it and leaving the fix to `develop setup` keeps one owner.
