# Local skill development

`@oneezy/skills` is a private workspace package. The authored source was copied from `V:\dev\skills`; its Git history and generated installations were not imported. The source checkout remains untouched. `skills-sync.json` and `skills-sync.lock.json` preserve the declared third-party skills and their pinned revisions.

From the monorepo root:

```powershell
pnpm install
pnpm dev
```

This prepares the Skills Sync CLI and viewer engine with Vite Plus's content-aware task cache, then starts the skills watcher and skills viewer together. The viewer opens in **Local** mode, reading this package's authored skills and restored dependencies. **Web** retains the GitHub search. Local mode is available only on the development server; it accepts no arbitrary filesystem path. Ctrl+C stops the running tasks.

`pnpm skills` starts the same local installation and watcher without the viewer. `pnpm skills:watch` is an alias; `pnpm skills:dev` remains the one-time restore/link command and exits. The first restore downloads locked upstream sources; subsequent restores reuse those snapshots. No global installation or release is performed.

Edit `skills/<group>/<name>/SKILL.md` and its neighboring scripts and references here. Root `.agents/skills/<name>` and `.claude/skills/<name>` link to the authored source, so edits need no publish, version bump, copy, or watcher. All packages inherit the root discovery location. Third-party working copies are generated under this package's `.agents/skills`; edit the source selection/adaptation in `skills-sync.json`, or promote a skill into authored `skills/` before customizing it permanently.

While the watcher runs, adding, removing, or renaming a skill folder updates the local links automatically. Content saves already flow through those links; the viewer refreshes its graph without a page reload. Unchanged saves do nothing. Watch events are debounced, generated plugin outputs are ignored, and config/lock changes restore pinned dependencies before reconciling links. Invalid or conflicting changes are reported and retried after the next save. Outside watch mode, run `pnpm skills:dev` after structural changes. Installation refuses to overwrite unrelated skill folders. Preview the link/config changes with:

```powershell
node packages/skills-sync/dist/src/cli.js develop --repo packages/skills --root . --plan
```

## Codex

Start a fresh chat with working directory `V:\dev\tools` and select a local skill using `$<name>` or the skills picker. Existing chats can retain their startup catalog; restart Codex if a fresh chat still shows stale metadata. Skills marked `disable-model-invocation` need an explicit request.

The development command writes ignored `.codex/config.toml` switches disabling cached copies of the library's plugins for this workspace. It also requests exclusions for external skill paths found in user skill folders and the Codex plugin cache. System skills and unrelated plugins/tools remain available. Global/account installations are unchanged. The command refuses an existing manually managed project skills or plugin policy rather than overwriting it. Rerun after external plugins update, because versioned cache paths can change. Codex must trust the project to load its configuration.

**Verified runtime limitation (2026-10-15):** Desktop's bundled Codex `0.162.0-alpha.17.2` loads the project skill rules but ignores them when filtering skills. Project plugin switches work: the duplicate library plugins disappear in a fresh-process catalog. Loose global skills and unrelated plugins can still appear. This matches [Codex issue 29846](https://github.com/openai/codex/issues/29846). A fresh chat alone does not fix that bug; do not claim this setup makes the entire picker repo-only. Select the local entry and verify its path. Resolving the remaining external entries requires runtime support or an explicitly chosen broader configuration change.

Desktop may supply account skills differently from the CLI. Verify the actual selected skill's path in a fresh Desktop chat; it should resolve inside this monorepo. CLI discovery alone is not proof that an already-running Desktop chat reloaded. Claude receives repo links, but its account plugin settings are unchanged by this command.

## Development plugin builds

`pnpm skills:dev:build [<plugin>...]` restores the locked Sources and runs `skills-sync develop build`. It builds Development builds of the named Plugins (all of them when none is named) into `dist/development/plugins/<id>`. They keep their normal names and are the same packages as the release build's `plugins/<id>`, except that NOTICE names the working Library instead of a commit. Release output and the source are untouched.

Each run rewrites only Plugins whose output differs. It stages them whole and swaps them in. A Plugin that fails validation is `failed` when it has no output yet, and nothing is written. It is `stale` when an earlier output exists, and that complete output stays in place. `dist/development/status.json` records the last outcome per Plugin. Exit 1 means at least one Plugin is stale or failed. This command does not install or activate anything in Claude Code, Codex or a project; project setup and the shared watcher build on it.

## Development projects

Connect another local project to this Library with the launcher, from that project's folder:

```powershell
pnpm skills:dev:launcher                                   # once, from the tools root: a global skills-sync linked to this checkout
skills-sync develop setup play --repo V:\dev\tools\packages\skills   # in the project: name the Plugins it uses, by id
skills-sync develop status                                 # what is connected, built and active
skills-sync develop remove                                 # take back exactly what setup made
```

Setup links `.agents/skills-library` to this package, so an edit made there is an edit here. It also writes the project record `.agents/skills-sync-project.json` and keeps both out of git through `.git/info/exclude`. It refuses any name that is not exactly one Plugin's id. It activates nothing in Claude Code or Codex yet. The Claude Code adapter exists but stays unverified until its Windows proof (#213); the Codex adapter is #214. Once verified, setup builds the selection first, and a failed build activates nothing. In Claude Code the development copy arrives through a local-scope marketplace over `dist/development`, and the released copy is off in that project only. A running chat keeps what it loaded until you type `/reload-plugins` or start a new chat. The research is in `packages/skills-sync/docs/research/`. `skills-sync --help` has the details. The decisions are in `packages/skills-sync/docs/adr`.

## Generated output and validation

Never commit `.git` from another repository, `.agents`, `.claude-plugin`, `plugins`, `dist`, `upstream`, `artifacts`, or local install receipts/configuration. Skills Sync recreates those outputs. The imported nested `.github` files are inactive in tools; their live copies run in `oneezy/skills`. Before moving, deleting or activating any of them, read `docs/agents/imported-automation.md`.

```powershell
vp run --filter @oneezy/skills test
pnpm --filter @oneezy/skills check
pnpm --filter @oneezy/skills build
```

`pnpm build` uses Vite Plus's content-aware task cache to skip unchanged builds. On a cache miss, Skills Sync compares generated files with disk and writes only changed output. Development does not generate plugins on each save: local links and the viewer read the source directly. Build generates plugin packages/catalogs for review; it does not publish or install them globally. The standalone library's release metadata remains for compatibility. Moving its release automation waits on the release-destination decision (`docs/agents/imported-automation.md`).

Validation on the Windows checkout: 107 installed skills, 214 live links, no nested `.git`, and a repeated `pnpm skills:dev` reports zero changes. All 145 authored files were copied; the debug script has two Windows path fixes. The package's 21 Node tests and capability check pass. Skills Sync's full run passed 315 tests with one skipped; its sole failure was the command-list expectation, then corrected and verified with the focused 9-test rerun. `pnpm check` passes with 14 existing warnings in other code. Plugin generation passes.

The fresh CLI startup catalog showed 81 implicit local skills, zero duplicate library-plugin entries, and 64 remaining external/system entries. Explicit-only skills are installed but not part of that implicit catalog. A temporary description edit to `play-unslop` appeared in a fresh catalog launched from `packages/skills-sync`; the original bytes were restored afterward. The current Desktop chat's startup catalog is not reload proof.
