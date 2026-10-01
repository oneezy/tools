# @oneezy/skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx @oneezy/skills-sync
```

Run it anywhere and it works out the rest:

- **No library on this machine?** It clones one into `~/.skills-sync` (default `oneezy/skills`; `--library owner/repo` for another) and asks nothing.
- **Library present?** It pulls it, brings the third-party skills up to date (or restores what the lock has), rebuilds the library's harness layers, and links every skill into each harness's user folder. Every step is skipped when its result is already right, so a no-op run is silent and fast.
- **On another machine or in a cloud session?** Run the same command there (or ask the agent to run the `oneezy-skills` skill, which does exactly that). Nothing is installed into any harness's settings.

First run on a machine with a terminal asks which harnesses, whether to link the user folders, which projects (if any) should carry copies, and (on Windows) which WSL distros. Answers are remembered in `skills-sync.local.json` beside the config, gitignored, so the committed config is the same on every machine; `--ask` prompts again. Node 20+, git.

Edit a skill in the library and every harness sees the change immediately: the user-folder entries are links. `git push` from the library is how it reaches other machines; their next session start pulls it.

## The library

A skills library is a folder with `skills/` beside `skills-sync.json` or `skills-lock.json`:

| path | holds | written by |
|---|---|---|
| `skills/<name>/` | a flat own skill, bare Agent Skills form (`SKILL.md`, optional `scripts/`, `references/`, `agents/openai.yaml`) | you |
| `skills/<group>/<name>/` | an own skill inside a group; the group's name is its plugin id | you |
| `skills-sync.json` | the committed config: the library itself, the two generation switches, third-party sources with their selections, renames and pins, the plugins | you, and `add` |
| `skills-lock.json` | what is installed: one entry per third-party skill in the `npx skills` format (source repo, upstream path, content hash) plus the commit it was taken at | `refresh`; or `npx skills add/update` in a library without a config |
| `plugins/<id>/` | the plugin form, one package per plugin in the config: skill copies, `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `LICENSE`, `NOTICE.md`. Committed. | `build` |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | the two marketplace catalogs, each listing `./plugins/<id>`. Committed. | `build` |
| `skills-sync.local.json` | this machine's answers: harnesses, user folders, projects, WSL distros, skills found gone upstream, link mode. Gitignore it. | the tool, after every run |

A library with a config gets its third-party skills through `refresh` (see [Third-party sources](#third-party-sources)). A library with only `skills-lock.json` keeps working exactly as before: `sync` restores from that lock and `npx skills update` owns the copies.

A folder directly under `skills/` that holds `SKILL.md` is a flat own skill. One without `SKILL.md` is a **group**: its children are own skills, and the group's name (`oneezy`, `trident`) is the plugin id they will be packaged under. A skill is known everywhere by its folder name alone, so `skills/oneezy/oneezy-status` links as `oneezy-status`, exactly as `skills/oneezy-status` would, and moving a skill into a group retargets its links without dropping any. Groups do not nest: a `SKILL.md` two levels below a group, or a second skill with a name already taken, is reported once on every run and never linked. `status --json` lists each own skill with its `plugin` (null when flat) and its `path` under the library.

Before 0.3.0 the answers lived in `skills-sync.json` itself. A `skills-sync.json` that holds only answers is moved to `skills-sync.local.json` on the next run, reported as one `move` line; one that has a `version`, `sources` or `plugins` key is the config and is never read as answers.

Everything else in it is generated and should be gitignored:

| path | holds |
|---|---|
| `upstream/<source>/<upstream path>` | snapshots: each source's selected skill folders and attribution files at their upstream paths, plus `.snapshot.json`. Never edited. |
| `.agents/skills/<name>` | the working set: one copy per third-party skill (from its snapshot, with its rename applied), plus one link per own skill (flat or grouped). Codex reads this folder directly. |
| `.claude/skills/<name>`, `.goose/skills/<name>`, `.hermes/skills/<name>` | one link per working-set entry, for each harness that does not read `.agents/skills` |

`oneezy/skills` is one such library; `npx skills add oneezy/skills` installs its own skills anywhere, `/plugin marketplace add oneezy/skills` and `codex plugin marketplace add oneezy/skills` offer its plugins (see [Plugins and catalogs](#plugins-and-catalogs)), and cloning it plus one `npx @oneezy/skills-sync` gives a new machine the whole set.

## What a run does

1. **Find the library.** `--repo`, else `$SKILLS_REPO`, else `~/.skills-sync` (the clone, or a link to wherever the library really lives), else a library folder above the current one (`skills/` beside `skills-sync.json` or `skills-lock.json`; never a dot-folder). Found somewhere else than `~/.skills-sync`? A link is left there so the next run finds it from anywhere. Nothing found? Clone one.
2. **Pull.** Fast-forward the library from its remote, at most every 30 minutes, only when its tree is clean (`--pull` forces, `--no-pull` skips). In a config library a change to `skills-lock.json` alone does not count: the refresh writes the lock on every machine, so a clone carries a moved lock from its first latest refresh on; the pull replaces it (or puts it back as it was when the pull fails) and the refresh writes it again.
3. **Restore.** With a config: a `refresh` (below). It runs **to latest** under the same 30-minute window as the pull, moving every unpinned third-party skill to the tip of its source's ref and writing the lock; when the pull was throttled, skipped for local changes or failed, or with `--no-pull`, it runs **frozen**: every skill at the commit the lock records, nothing moves, nothing written but the snapshots and the working set. `--pull` forces the latest refresh. Without a config: lock entries with no folder in `.agents/skills` are fetched from `skills-lock.json`, one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it, exactly as 0.2.0 did. Either way, skills upstream deleted are reported, remembered, and skipped until `--retry`.
4. **Layers.** `.agents/skills/<name>` links to each own skill's folder (`skills/<name>` or `skills/<group>/<name>`), listed in a generated `.agents/skills/.gitignore`. Each selected harness that has its own project folder gets one link per working-set entry. With `--sidecars`, own skills that lack `agents/openai.yaml` get one generated from their frontmatter, so Codex sees the same policy; it writes into `skills/`, so it is opt-in.
5. **User folders.** One link per skill in each selected harness's user skills folder (`~/.claude/skills`, `~/.agents/skills`, `~/.config/goose/skills`, `~/.hermes/skills`), pointing at the real folder. Every project on the machine now sees the set, and an edit in the library is live everywhere.
6. **Projects.** Optional. Git repos under the dev folder that you check get their skills too: **link** mode makes the same links inside the repo and hides them from git through `.git/info/exclude`; **copy** mode writes real folders meant to be committed, for repos that must carry their own (cloud sessions, other people).
7. **WSL.** Windows only, optional. Each checked distro runs the same sync for its own user folders through `/mnt/<drive>/…`. The distro needs Node.

Then it prints one line per change, a line saying how many links it made and of which kind, and a summary. `--plan` prints the same without touching anything.

### Links

Every link is a directory symlink. On Windows a symlink needs Developer Mode or elevation; when the system refuses one (EPERM) the tool makes a junction instead and says so in the run's `links:` line. `--symlinks` makes symlinks only (the run fails where one is refused), `--junctions` makes junctions only; either flag is remembered as `links` in `skills-sync.local.json` (`auto` by default) and read on every run. The mode applies to links the run creates; a link that already points at the right folder is left as it is, whatever its kind (`unlink`, then sync, remakes the user-folder links). POSIX has only symlinks.

## Third-party sources

Third-party skills come from **sources** declared in `skills-sync.json`. The config is yours to edit; `add` writes an entry for you. Its shape (the full rules are in `schemas/skills-sync.schema.json`):

```jsonc
{
  "version": 1,
  "library": { "name": "skills", "owner": "oneezy", "homepage": "https://github.com/oneezy/skills" },
  "generate": { "skills": true, "plugins": true },   // the two forms, each behind a switch; both true when absent (read by build)
  "sources": {
    "matt-pocock": {
      "repo": "mattpocock/skills",          // owner/repo, a git URL, or a local path
      "ref": "main",                        // the branch or tag followed: its tip at every refresh
      "root": "skills",                     // where the skill folders live (searched three levels deep, like npx skills)
      "skills": ["tdd", "writing-for-agents"],
      "pins": { "writing-for-agents": "321658273cb1d20b76026717d027d505790106d4" },   // one skill held at its own commit
      "attribution": ["LICENSE", "README.md"]                                          // carried into the snapshot and every package
    },
    "pstack": {
      "repo": "cursor/plugins", "ref": "main", "root": "pstack/skills",
      "skills": { "tdd": "pstack-tdd", "why": "why" },                                 // a map renames on import
      "attribution": ["pstack/LICENSE", "pstack/README.md"]
    }
  },
  "plugins": {
    "oneezy": { "displayName": "Oneezy", "description": "Justin's own skills", "group": "oneezy" },
    "pstack": { "displayName": "PStack", "source": "pstack" }
  }
}
```

**Latest is the default.** Every selected skill is taken at the tip of its source's `ref` on each `refresh`, and on each `sync` that is due for a pull. A **pin** is the exception: a skill listed in `pins` is taken at that commit while its siblings move; change the commit to move it, remove it to let it follow. A `ref` that is a full commit holds the whole source. The `generate` switches say which forms the library builds (the loose-skill layers, the plugin packages); `build` reads `generate.plugins`.

**`refresh`** resolves every source and makes the library match:

1. Each source's commit: the tip of `ref` (one `git ls-remote`), or `ref` itself when it is a commit. With `--frozen` every skill is taken at the commit `skills-lock.json` records for it, a skill the lock has no commit for is left alone and reported, and the lock is not written; this is what CI runs, and what `sync` runs when the pull is not due.
2. Each selected skill is found under `root` by folder name, at its pin when it has one. When the snapshot already holds that commit's content (its hash matches the lock) nothing is fetched; otherwise a temp clone is staged (shallow, at that commit) and deleted when done. A skill not found upstream is reported once as gone, remembered in `skills-sync.local.json`, and not looked for again until `--retry`.
3. The snapshot `upstream/<source>/` gets the skill folders and attribution files at their upstream paths, and a `.snapshot.json` (source, repo, ref, commit, date, skills with their path, hash and commit, attribution). Folders no longer selected are deleted. Snapshots are generated and never edited; gitignore `upstream/`.
4. The working set: `.agents/skills/<name>` becomes a copy of the snapshot folder, under the new name with the frontmatter `name` rewritten when renamed. A copy whose files already match is skipped; a copy no longer selected is deleted. One name selected by two sources: the first source by id wins and owns the lock entry; the other is reported until the config renames it. An own skill with the same name keeps it.
5. `skills-lock.json` is written (never with `--frozen`): one entry per working-set skill, keyed by its name, with exactly the fields `npx skills` writes (`source` as `owner/repo`, `ref` only when it is a branch or tag, `sourceType`, `skillPath` as the upstream path, `computedHash`) plus `commit`, the commit the skill was taken at. Older skills-sync versions and `npx skills` keep restoring from it without pins or renames: probed against `npx skills` 1.7.0, `list`, `list --json` and `update -p -y` read a lock with the extra field, and keep it on the entries they do not rewrite.

The hash is the `npx skills` recipe (SHA-256 over every file's relative path then bytes, sorted by `localeCompare`), computed over bytes exactly as upstream committed them, so a lock written on one machine verifies on any other. `refresh --plan` shows the actions without touching the library (it still stages clones in the temp folder). `--json` adds `sources`, `gone`, `unlocked` and `problems` to the usual actions. A source that cannot be reached keeps its lock entries and snapshot, and the exit code is 1.

**`add <source>`** declares a source and brings its skills in: `add mattpocock/skills`, `add cursor/plugins#main --root pstack/skills --as tdd=pstack-tdd,teach=pstack-teach`, `add ../some/repo --skills a,b`. It stages the repo in a temp clone, lists the skills under `--root` (default `skills/` when the repo has one, else the root), writes the config entry (`--id`, default `owner-repo`; the default branch unless `#ref`; every skill unless `--skills`; a map when `--as` renames; the nearest `LICENSE` and `README.md` as attribution) and runs `refresh` with that clone. Nothing is installed anywhere: no agent folder, no `~/.skills-sync`, no `npx skills` run against the library. `add --plan` prints the entry it would write and stops. Add a pin or drop a skill by editing the config, then `refresh`.

## Plugins and catalogs

The same library is a plugin marketplace for Claude Code, Codex and ChatGPT. **`build`** writes the plugin form into the library, beside the source, and the result is committed like any other change; nothing is generated at install time and CI only checks. It runs when the config's `generate.plugins` is true (the default); with it false, `build` writes nothing and `build --check` ignores the plugin form.

`build --plugins` writes one package per entry of `plugins` in the config:

```
plugins/<id>/
  plugin.json                  Agent Plugins 1.0: $schema, name, version, description, author, homepage, repository, license,
                               keywords, and the ChatGPT interface under extensions["com.openai"] (displayName, shortDescription,
                               longDescription, developerName, category, capabilities)
  .codex-plugin/plugin.json    the legacy flat form of the same, plus skills: "./skills/" and interface
  .claude-plugin/plugin.json   name, displayName, description, author, license, homepage, repository, keywords; no version,
                               so Claude Code tracks the library's commits
  skills/<name>/               a copy of each skill: an own group's skills from skills/<group>/, a source's selected skills
                               from the working set (renames applied)
  LICENSE                      the source's LICENSE from its attribution files; for an own plugin the library's LICENSE
                               when it has one, else none and one reported line
  NOTICE.md                    the source repo, the commit and date the files were taken at, the license, the skills
                               (renames and per-skill pins noted), and why the copies are marked internal
```

Every copied `SKILL.md` gains `metadata.internal: true` in its frontmatter (into an existing `metadata:` map, or a new one at the end; every other byte stays as it was). `npx skills` skips a skill so marked, so a consumer of the library installs and updates each own skill from `skills/` exactly once rather than finding it twice; `INSTALL_INTERNAL_SKILLS=1` re-exposes the copies. `build --check` compares after that transform.

The version in `plugin.json` and `.codex-plugin/plugin.json` is `0.<commit count>.0+<sha12>` of the library's HEAD (`git rev-list --count HEAD`, `git rev-parse --short=12 HEAD`); a library without git gets `0.0.0+nogit`. A package whose files did not change keeps the version and commit it was built with: the HEAD moves with every commit, including the one that commits the build, so a rebuild rewrites a package only when its inputs changed, and then every file of it takes the new HEAD's version. Two builds of the same inputs are byte-identical; a build with nothing new is a no-op. A package for an id no longer in the config is removed with a report line, and a skill copy no longer in its package goes the same way.

`build --catalogs` writes the two root catalogs, each listing every plugin with a `./plugins/<id>` source, in the config's order: `.claude-plugin/marketplace.json` (`name` is `<owner>-<name>` from `library`, `owner`, `description`, `plugins[]` with `name`, `source`, `description`) and `.agents/plugins/marketplace.json` (Codex: `name`, `interface.displayName`, `plugins[]` with `name`, `source`, `description`, `policy` `installation: AVAILABLE` and `authentication: ON_USE`, `category`). `build` with no output flag writes both forms. `--artifacts` (archives under `artifacts/` for the ChatGPT upload) is the next stage and prints a line saying so.

**`build --check`** computes every output in memory, prints each path that differs from disk (a hand-edited copy, a source edited since the last build, a missing catalog, a stale package), writes nothing, and exits 1; a clean library exits 0. `--check --plugins` or `--check --catalogs` narrows it to one form. CI runs `build --check` on every push so a skipped local build cannot land drift. `build --plan` shows the writes without making them.

Plugin skills run namespaced: `/oneezy:oneezy-status` in Claude Code, `$oneezy:oneezy-status` in Codex; their folder names do not change. Each package passes `claude plugin validate` (the only warning is the missing Claude version, by design) and the root passes it as a marketplace.

The config's optional `releases` section is the ChatGPT upload record, one entry per plugin id written by hand after each upload: `plugin_id`, `release_id`, `sha256` of the archive, `scope` (`personal` or `workspace`), `date`, and optionally `files`, the archive's entries; the schema admits nothing else there. `build --artifacts` reads it to say whether an archive changed since its last upload.

## Rules it never breaks

- A link is created, retargeted or removed only when its target is inside the library. A real folder in the way, or a link pointing elsewhere, is reported as a conflict and left alone.
- `build` writes only `plugins/<id>/` and the two catalogs, inside the library; `build --check` writes nothing at all. A package is rewritten only when its inputs changed.
- `synced/` (Claude's account skills) and `.system/` are never touched.
- Third-party copies in `.agents/skills` are written only by `refresh` (config library) or by `npx skills` (legacy library); the link steps never edit them.
- `refresh` and `add` touch nothing outside the library: no pull, no `~/.skills-sync`, no harness folder.
- `refresh --frozen` never writes the lock; only a latest refresh does.
- Inside WSL the library's own layers are left to Windows.

## Prompts and flags

Interactive (a terminal, no `-y`): library path, harnesses to sync (detected ones pre-checked), where (user folders, projects), which projects and link or copy, machines (Windows plus WSL distros). Answers are saved in `skills-sync.local.json` beside the config (shape in `schemas/skills-sync.local.schema.json`); `--ask` prompts again.

Every answer is also a flag, so scripts and agents never see a prompt:

```
--repo <path>        --agents claude-code,codex,goose,hermes
--global | --no-global
--projects a,b | --projects '*' | --no-projects     --dev <dir>     --copy
--wsl Ubuntu | --wsl '*' | --no-wsl
--symlinks | --junctions
--library owner/repo   --pull | --no-pull
--no-restore  --retry  --sidecars  --no-layers
--watch  --plan  --quiet  --json  -y  --ask
refresh: --frozen  --retry
add <source>: --id <id>  --root <path>  --skills a,b | --skills '*'  --as old=new,...
build: --plugins  --catalogs  --artifacts  --check
```

Commands: `sync` (default), `status`, `unlink` (remove every link this tool made in the user folders), `projects` (only step 6), `refresh` and `add <source>` (see [Third-party sources](#third-party-sources)), `build` (see [Plugins and catalogs](#plugins-and-catalogs)).

`--watch` keeps running and redoes layers and user folders when `skills/`, the config or the lock changes, so a skill you add is linked the moment its folder appears.

## Development

```
pnpm install && pnpm build
pnpm test          # node:test on temp folders and temp git repos standing in for upstream; symlinks where the machine allows them, junctions otherwise
node dist/src/cli.js --repo <library> --plan
```

The two JSON Schemas under `schemas/` ship with the package: `skills-sync.schema.json` for the config (sources, plugins, the `generate` switches, the `releases` upload record), which `refresh`, `add` and `build` validate before doing anything, and `skills-sync.local.schema.json` for this machine's answers, validated on every read. The validator is in the tool; there is no dependency for it.
