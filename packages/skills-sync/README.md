# @oneezy/skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx @oneezy/skills-sync
```

Run it anywhere and it works out the rest:

- **No library on this machine?** It clones one into `~/.skills-sync` (default `oneezy/skills`; `--library owner/repo` for another) and asks nothing.
- **Library present?** It pulls it, installs the third-party skills exactly as the committed lock records them (nothing moves upstream), rebuilds the library's harness layers, and links every skill into each harness's user folder. Every step is skipped when its result is already right, so a no-op run is silent and fast.
- **On another machine?** Run the same command there (or ask the agent to run the `oneezy-skills` skill, which does exactly that). Nothing is installed into any harness's settings.
- **In a cloud session?** The container starts with no library. Put `npx --yes @oneezy/skills-sync -y --agents claude-code --global --no-projects --no-wsl` in the cloud environment's setup script so the skills are linked before the session starts. Run mid-session instead, Claude Code lists them about a minute later.

First run on a machine with a terminal asks which harnesses, whether to link the user folders, which projects (if any) should carry copies, and (on Windows) which WSL distros. Answers are remembered in `skills-sync.local.json` beside the config, gitignored, so the committed config is the same on every machine; `--ask` prompts again. Node 20+, git.

Edit a skill in the library and every harness sees the change immediately: the user-folder entries are links. `git push` from the library is how it reaches other machines; their next session start pulls it.

## The library

A skills library is a folder with `skills/` beside `skills-sync.json`, `skills-sync.lock.json` or `skills-lock.json`:

| path | holds | written by |
|---|---|---|
| `skills/<name>/` | a flat own skill, bare Agent Skills form (`SKILL.md`, optional `scripts/`, `references/`, `agents/openai.yaml`) | you |
| `skills/<group>/<name>/` | an own skill inside a group; the group's name is its plugin id | you |
| `skills-sync.json` | the committed config: the library itself, the two generation switches, third-party sources with their selections, renames and pins, the plugins | you, and `add` |
| `skills-sync.lock.json` | what a config library has installed, per source as in the config: repo, ref, upstream version, commit, date, and each skill's upstream path and content hash (plus a commit where a pin holds it elsewhere) | `refresh`, `add` |
| `skills-lock.json` | what a library without a config has installed, in the `npx skills` format. In a config library it is the lock skills-sync 0.4.0 wrote, which `refresh` migrates to `skills-sync.lock.json` | `npx skills add/update` |
| `plugins/<id>/` | the plugin form, one package per plugin in the config: skill copies, `plugin.json`, `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`, `LICENSE`, `NOTICE.md`. Committed. | `build` |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | the two marketplace catalogs, each listing `./plugins/<id>`. Committed. | `build` |
| `skills-sync.local.json` | this machine's answers: harnesses, user folders, projects, WSL distros, skills found gone upstream, link mode. Gitignore it. | the tool, after every run |

A library with a config gets its third-party skills through `refresh` (see [Third-party sources](#third-party-sources)). A library with only `skills-lock.json` keeps working exactly as before: `sync` restores from that lock and `npx skills update` owns the copies.

A folder directly under `skills/` that holds `SKILL.md` is a flat own skill. One without `SKILL.md` is a **group**: its children are own skills, and the group's name (`oneezy`, `trident`) is the plugin id they will be packaged under. A skill is known everywhere by its folder name alone, so `skills/oneezy/oneezy-status` links as `oneezy-status`, exactly as `skills/oneezy-status` would, and moving a skill into a group retargets its links without dropping any. Groups do not nest: a `SKILL.md` two levels below a group, or a second skill with a name already taken, is reported once on every run and never linked. `status --json` lists each own skill with its `plugin` (null when flat) and its `path` under the library.

The group named `play` is the playground: a place to try a skill (your own idea, or one copied from someone else's repo) before promoting it into another group. It is packaged, cataloged and linked exactly like any other group, and every skill in it is named `play-<name>` (`skills/play/play-unslop`, used as `/play-unslop`), so it never clashes with a skill from a source; `check` fails on one that is not. Other groups' skill names are not held to a prefix.

Before 0.3.0 the answers lived in `skills-sync.json` itself. A `skills-sync.json` that holds only answers is moved to `skills-sync.local.json` on the next run, reported as one `move` line; one that has a `version`, `sources` or `plugins` key is the config and is never read as answers.

Everything else in it is generated and should be gitignored:

| path | holds |
|---|---|
| `upstream/<source>/<upstream path>` | snapshots: each source's selected skill folders and attribution files at their upstream paths, plus `.snapshot.json`. Never edited. |
| `.agents/skills/<name>` | the working set: one copy per third-party skill (from its snapshot, with its rename applied), plus one link per own skill (flat or grouped). Codex reads this folder directly. |
| `.claude/skills/<name>`, `.goose/skills/<name>`, `.hermes/skills/<name>` | one link per working-set entry, for each harness that does not read `.agents/skills` |
| `artifacts/` | the upload archives `build --artifacts` writes: one ZIP per plugin, `releases.json`, and a `<id>.changes.md` note when one is due (see [Artifacts](#artifacts)) |

`oneezy/skills` is one such library; `npx skills add oneezy/skills` installs its own skills anywhere, `/plugin marketplace add oneezy/skills` and `codex plugin marketplace add oneezy/skills` offer its plugins (see [Plugins and catalogs](#plugins-and-catalogs)), and cloning it plus one `npx @oneezy/skills-sync` gives a new machine the whole set.

## What a run does

1. **Find the library.** `--repo`, else `$SKILLS_REPO`, else `~/.skills-sync` (the clone, or a link to wherever the library really lives), else a library folder above the current one (`skills/` beside `skills-sync.json`, `skills-sync.lock.json` or `skills-lock.json`; never a dot-folder). Found somewhere else than `~/.skills-sync`? A link is left there so the next run finds it from anywhere. Nothing found? Clone one.
2. **Pull.** Fast-forward the library from its remote, at most every 30 minutes, only when its tree is clean (`--pull` forces, `--no-pull` skips). In a config library a change to the lock alone does not count: a lock moved on this machine (by a `refresh` run here, or by the sync of a version before 0.5.0) is put back at the library's committed one by the pull, or left as it was when the pull fails. The pull is the only way a new lock arrives: an update lands as a library commit, and the next pull brings it.
3. **Restore.** With a config: a `refresh --frozen` (below), always, whatever the pull did: every third-party skill at the commit the lock records, nothing moves upstream, nothing written but the snapshots and the working set, never the lock. A plain sync (the default command, `--watch`, a setup script or session-start hook) therefore installs exactly what the library commits; only an explicit `refresh` moves a source. Without a config: lock entries with no folder in `.agents/skills` are fetched from `skills-lock.json`, one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it, exactly as 0.2.0 did. Either way, skills upstream deleted are reported, remembered, and skipped until `--retry`.
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
      "ref": "main",                        // the branch or tag followed: its tip at every update
      "version": "1.3.0",                   // optional: hold the source at this upstream release; latest when omitted
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

**Latest is the default.** Every selected skill is taken at the tip of its source's `ref` on each `update`; `sync` never moves one. A **held version** is the first exception: a source with `"version": "1.3.0"` is taken at that release (the commit of its tag, or for a source versioned by its manifest the newest commit on `ref`'s history whose manifest carried that version) until the config changes; plain semver only, `v1.3.0` is refused by the schema. A **pin** is the second: a skill listed in `pins` is taken at that commit while its siblings move; change the commit to move it, remove it to let it follow. A `ref` that is a full commit holds the whole source. The tool never writes `version` (or anything else in `skills-sync.json` but what `add` declares): `update --to` prints the change and whoever lands it commits it. The `generate` switches say which forms the library builds (the loose-skill layers, the plugin packages); `build` reads `generate.plugins`.

**`update [<source>...]`** (`refresh` is the same command, kept for scripts and CI) resolves the named sources, every one when none is named, and makes the library match. A source not named resolves frozen, as `sync` does: its lock entry stays byte for byte and its working copies at the commits the lock records. For each named source:

1. Each source's commit: the tip of `ref` (one `git ls-remote`), or `ref` itself when it is a commit; with a held `version` (or `--to`, below), that release's commit, found in a blobless clone of `ref` with its tags. With `--frozen` every skill is taken at the commit `skills-sync.lock.json` records for it (a `skills-lock.json` from 0.4.0 is read in its place, unchanged), a skill the lock does not record is left alone and reported, and no lock is written; this is what CI runs, and what every `sync` runs.
2. Each selected skill is found under `root` by folder name, at its pin when it has one. When the snapshot already holds that commit's content (its hash matches the lock) nothing is fetched; otherwise a temp clone is staged (blobless, with the history and tags behind that commit) and deleted when done. A skill not found upstream is reported once as gone, remembered in `skills-sync.local.json`, and not looked for again until `--retry`.
3. The snapshot `upstream/<source>/` gets the skill folders and attribution files at their upstream paths, and a `.snapshot.json` (source, repo, ref, commit, date, version and commits past it, skills with their path, hash and commit, attribution). Folders no longer selected are deleted. Snapshots are generated and never edited; gitignore `upstream/`.
4. The working set: `.agents/skills/<name>` becomes a copy of the snapshot folder, under the new name with the frontmatter `name` rewritten when renamed. A copy whose files already match is skipped; a copy no longer selected is deleted. One name selected by two sources: the first source by id wins and owns the lock entry; the other is reported until the config renames it. An own skill with the same name keeps it.
5. `skills-sync.lock.json` is written (never with `--frozen`), version 2, grouped per source like the config, sources and skills sorted:

   ```json
   {
     "version": 2,
     "sources": {
       "mattpocock": {
         "repo": "mattpocock/skills",
         "ref": "main",
         "version": "1.3.1",
         "commit": "<40-hex commit>",
         "date": "<the commit's ISO date>",
         "skills": {
           "tdd": { "path": "skills/engineering/tdd", "hash": "<recipe sha256>" },
           "writing-for-agents": { "path": "skills/writing-for-agents", "hash": "<recipe sha256>", "commit": "<its pin>" }
         }
       }
     }
   }
   ```

   Skills are keyed by their working-set name (a rename shows here) with their upstream path; a skill carries a `commit` only when a pin holds it at another commit than its source's. A `skills-lock.json` that skills-sync 0.4.0 wrote (every entry with a `commit`) is migrated once: the new lock is written, the old file removed, one line says so. An `npx skills` lock of its own is never touched.

**Versions.** A source's version is plain semver (`1.3.1`, never `v1.3.1`), resolved at its commit in this order: the nearest release tag at or before it (a leading `v` or `name@` stripped; pre-release tags only when no stable one is reachable); else the `version` of the nearest of `.claude-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json` and `package.json`, looking in the source's `root` and then each parent up to the repo root; else none (`null`). Output names each source by its version and how far past it the commit is, `mattpocock: 1.3.1 (+4 commits)`, counted from the tag's commit or from the commit that set the manifest to that version; a source without a version shows its date and short commit. The lock stores only the version and the commit; `--json` carries `version` and `ahead` (the count) per source.

The hash is the `npx skills` recipe (SHA-256 over every file's relative path then bytes, sorted by `localeCompare`), computed over bytes exactly as upstream committed them, so a lock written on one machine verifies on any other. `refresh --plan` shows the actions without touching the library (it still stages clones in the temp folder). `--json` adds `sources` (per source: `commit`, `date`, `version`, `ahead`, `moved`), `updated`, `config` (both above), `gone`, `unlocked` and `problems` to the usual actions. A source that cannot be reached keeps its lock entries and snapshot, and the exit code is 1.

Every source whose commit is not the one the lock had is reported, from and to, as `updated up: 1.2.0 (+1 commit) 4f2a9c1 -> 1.3.0 8d0e3b7` on stdout and in `--json` as `updated: [{ id, from: { version, commit, ahead }, to: { version, commit, ahead } }]` (`from` is null for a source new to the lock; `ahead` is null where it is not known).

**`update <source> --to <version>|previous|latest`** moves one source (`--to` with no source, or with two, is refused):

- `--to 1.3.0` takes that release, as a held version would; a leading `v` is accepted.
- `--to previous` takes the highest stable release below the version the lock records: the next lower tag, or for a source versioned by its manifest the newest commit carrying the next lower distinct version.
- `--to latest` takes the tip of `ref`, past any held version.

The config is not written. The change that makes the move stick is printed for the caller to land, `skills-sync.json: sources.up.version = "1.3.0"`, or `remove sources.up.version` for `latest` when a version is held (nothing when the config already says so); `--json` carries it as `config: [{ source, version }]`, `version` null for a removal. Until it lands, the next plain `update` puts the source back where the config says. A version the source has not released, or `previous` below its lowest release, is refused with the versions it has, newest first, `up: 1.5.0 is not a release (versions: 1.3.1, 1.3.0, 1.2.3)`; nothing is written and the exit code is 1 (`--json`: `{ "refused": "..." }`).

**`versions <source>`** lists what a source has released on `ref`'s history, highest first, each with its commit and date, the one the lock is at marked `*` with how far past it the lock is. Release tags when any is reachable (stable ones only, unless there are none; `v1.3.0` over `skills@1.3.0` when both name a version), else each distinct version of the manifest that versions it, at the newest commit carrying it. `--json`: `{ source, repo, ref, current: { version, commit, ahead }, versions: [{ version, commit, date, current }] }`. It stages a temp clone and writes nothing.

**`add <source>`** declares a source and brings its skills in: `add mattpocock/skills`, `add cursor/plugins#main --root pstack/skills --as tdd=pstack-tdd,teach=pstack-teach`, `add ../some/repo --skills a,b`. It stages the repo in a temp clone, lists the skills under `--root` (default `skills/` when the repo has one, else the root), writes the config entry (`--id`, default `owner-repo`; the default branch unless `#ref`; every skill unless `--skills`; a map when `--as` renames; the nearest `LICENSE` and `README.md` as attribution) and the plugin entry that packages it (`--plugin <id>`, default the source id, display name from the id; `--no-plugin` for none; an id already in `plugins` is refused before anything is written), and runs `refresh` with that clone. `build --plugins --catalogs` then writes the package. Nothing is installed anywhere: no agent folder, no `~/.skills-sync`, no `npx skills` run against the library. `add --plan` prints the entries it would write and stops. Add a pin or drop a skill by editing the config, then `refresh`.

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

Every copied `SKILL.md` gains `metadata.internal: true` in its frontmatter (into an existing `metadata:` map, or a new one at the end; nothing else in it changes). `npx skills` skips a skill so marked, so a consumer of the library installs and updates each own skill from `skills/` exactly once rather than finding it twice; `INSTALL_INTERNAL_SKILLS=1` re-exposes the copies. `build --check` compares after that transform.

The version in `plugin.json` and `.codex-plugin/plugin.json` is `0.<n>.0+<sha12>`: `n` counts the builds that changed the package (1 for a new one) and the sha is the library's HEAD at that build (`git rev-parse --short=12 HEAD`); a library without git, or a checkout without a commit yet, gets `0.0.0+nogit` (its NOTICE says which). A package whose files did not change keeps the version and commit it was built with: the HEAD moves with every commit, including the one that commits the build, so a rebuild rewrites a package only when its inputs changed, and then it takes the next `n` after the one on disk, with the new HEAD's sha. `n` never comes from git history: a commit count shrinks across a squash merge or a promotion, and a version must never move backwards (0.3.0 used the commit count; 0.4.0 continues from whatever version a package carries). Two builds of the same inputs are byte-identical; a build with nothing new is a no-op. A package for an id no longer in the config is removed with a report line, and a skill copy no longer in its package goes the same way. Commit dates in a NOTICE spell UTC as `Z` whatever git printed (git before 2.45 prints `+00:00`), so every git builds the same bytes.

The package is the record of the version it was built with: the commit that version names need not be in HEAD's history, or in the checkout at all. A squash merge lands a package built on a branch and leaves the branch's commits behind, and a shallow clone (what `actions/checkout` fetches unless told otherwise) holds only the newest commit, so on the branch pull requests merge into, and in CI, a version routinely names a commit git cannot show there. Such a package is as built: `build --check` and `check` need no history, and are clean after a squash merge and in a shallow clone. What every checkout can verify is verified: the version has the rule's form; an own package's `NOTICE.md` names, in full and with a date, the commit the version abbreviates; and when the repository does hold that commit, its date is the recorded one. A package that fails one of these (a hand-set version, `0.0.0+nogit` once the checkout has a commit, a NOTICE naming another commit) is treated as changed and rebuilt with the next version. A hand-set version naming a commit the checkout does not hold cannot be told from a squashed one, and is believed.

A new or changed package needs no history either: `build` works in a shallow clone, because the next version comes from the package on disk, not from counting commits.

A package that cannot be built is a conflict: a source that is not in the config, a source with no snapshot under `upstream/` (a clone before `refresh`), a link inside `plugins/<id>` (never followed, never written through). `build` leaves whatever `plugins/<id>` holds and exits 1; `build --check` lists `plugins/<id>` as drift. A link inside a source skill folder is not copied, with a note.

A group the config declares as a plugin but that holds no skill yet (a new, empty `play`) is not a conflict: `build` and `build --check` skip it with one note (`no skills under skills/<group> yet; not built, not cataloged`) and exit 0, and the catalogs leave it out. When a group's last skill goes, `build` removes its `plugins/<id>` with that reason, and until then `check` reports the package as drift.

A package holds LF line endings, whatever the checkout it was built in holds. A source file (a skill's file, the LICENSE) whose line endings are all CRLF is copied with LF: that is what `core.autocrlf=true` makes of a committed LF file, and copied as read it would give a different package, and a different archive, from the same commit, with shell scripts that fail on Linux. A file committed with CRLF is copied with LF too, the library's or upstream's; a binary file (a NUL byte, or more than one control character in 128 bytes) and a file with mixed line endings are copied as they are. Every file `build` writes is therefore LF; on a checkout where git converts to CRLF a committed file is compared as git sees it, so such a clone is as built and `build` rewrites nothing there. Give the library a `.gitattributes` with `* text=auto eol=lf` so every clone holds LF regardless of the machine's git settings.

`build --catalogs` writes the two root catalogs, each listing every plugin with a `./plugins/<id>` source, in the config's order: `.claude-plugin/marketplace.json` (`name` is `<owner>-<name>` from `library`, `owner`, `description`, `plugins[]` with `name`, `source`, `description`) and `.agents/plugins/marketplace.json` (Codex: `name`, `interface.displayName`, `plugins[]` with `name`, `source`, `description`, `policy` `installation: AVAILABLE` and `authentication: ON_USE`, `category`). `build` with no output flag writes both: the committed form. The upload archives are a third output, written only when `--artifacts` asks (see [Artifacts](#artifacts)).

**`build --check`** computes every output in memory, prints each path that differs from disk (a hand-edited copy, a source edited since the last build, a missing catalog, a stale package, a package that cannot be built), writes nothing, and exits 1; a clean library exits 0. `--check --plugins` or `--check --catalogs` narrows it to one form. It never looks at `artifacts/`. CI runs `build --check` on every push so a skipped local build cannot land drift; the default shallow checkout is enough for it. `build --plan` shows the writes without making them.

Plugin skills run namespaced: `/oneezy:oneezy-status` in Claude Code, `$oneezy:oneezy-status` in Codex; their folder names do not change. Each package passes `claude plugin validate` (the only warning is the missing Claude version, by design) and the root passes it as a marketplace.

## Artifacts

ChatGPT takes a plugin as an uploaded archive, by hand. **`build --artifacts`** writes what that upload needs into `artifacts/` (generated, gitignored, never part of a check):

```
artifacts/
  <id>-<version>.zip     one archive per built plugin, holding the package under one folder named <id>
  releases.json          per plugin: archive, sha256, version, commit, files, release
  <id>.changes.md        only when the recorded release holds a file the new archive lacks
```

The archive is the package `build --plugins` writes, at the version its manifests carry, so `--artifacts` alone archives the packages as they are on disk when they are as built, and what a build would write when they are not; it writes no package and no catalog itself. The ZIP is written by the tool with no dependency and is **deterministic**: every entry stored (no compression), entries sorted by path, forward slashes, no directory entries, one fixed timestamp (1980-01-01 00:00), no symlinks (a link inside a skill folder is never followed: it is left out, with a report line). Two builds of the same input give identical bytes on any machine and in any checkout, a CRLF one included (a package holds LF, see [Plugins and catalogs](#plugins-and-catalogs)), so the sha256 says whether a plugin changed: a library commit that touches no input of a package leaves its archive's name and bytes as they were, and editing one skill changes only its plugin's archive. An older archive of a plugin, an archive for an id no longer in the config and a note that no longer applies are removed; any other file in `artifacts/` is left alone, and so is the archive of a plugin that could not be built this run.

`releases.json` says, per plugin: `archive` (its path in the library), `sha256`, `version`, `commit` (the upstream commit for a source plugin, the library commit the package was built at for an own group, null without git), `files` (the archive's entries) and `release`, the last upload the config records for it, or null.

The config's optional `releases` section is that record, one entry per plugin id written by hand after each upload: `plugin_id`, `release_id`, `sha256` of the archive, `scope` (`personal` or `workspace`), `date`, and optionally `files`, the archive's entries as `releases.json` lists them; the schema admits nothing else there. An archive whose sha256 equals the recorded one has not changed since its upload. A ChatGPT plugin update overlays files and cannot delete one, so when the recorded `files` name a file the new archive lacks (removed, or renamed so the old name is gone), the build writes `artifacts/<id>.changes.md`: it lists those files and says to upload the archive as a new plugin, not as an update. A recorded path counts with or without its leading `<id>/` folder. No recorded `files`, or every one still in the archive: no note.

## Check

**`check`** answers one question: is what is committed consistent? It reads the library and nothing else (no network, no clone, nothing written, no harness folder), prints one line per problem as `<path>: <reason>`, and exits 1 when there is any; a clean library gets one summary line and exit 0. Run it before committing; CI runs it on every push. It is a command, never a git hook. `--json` gives `problems` as `path` and `reason` pairs, and `notes` the same way for what was passed over without failing (a declared group with no skill yet, printed as `note: <path>: <reason>`); `--quiet` says nothing when the library is clean.

1. **Frontmatter of every own skill** (`skills/<name>/SKILL.md` and `skills/<group>/<name>/SKILL.md`): `name` is the folder's name and a valid skill id (lowercase letters, digits and single hyphens, at most 64 characters), and `description` is present. A skill folder under `skills/play/` is named `play-<name>`; one that is not fails as `skills/play/unslop: a skill in the play group is named play-<name>; rename the folder (and its frontmatter name) to play-unslop`. Third-party skills are upstream's and are not checked.
2. **Every `flow.yaml` beside an own `SKILL.md`**, against `schemas/flow.schema.json` and the rules a schema cannot say:

   | key | rule |
   |---|---|
   | `skill` | required; the folder's name |
   | `purpose` | required text |
   | `runtime` | a list of tools and connections |
   | `refs[]` | `token`, `kind` (`skill`, `plugin`, `app`, `file`, `url`), `id`, `need` (`required`, `optional`, `conditional`, `example`, `mention`), optional `when` |
   | `unresolved[]` | `token` and `note` |
   | `agents.max` | an integer, 0 or more |
   | `steps[]` | required, at least one; each has a unique `id` (lowercase letters, digits, hyphens) |
   | step `after` | one step id or a list of them, each naming a step of this flow |
   | step `parallel`, `join` | `parallel` lists at least two member ids and needs `join`, the id where they meet; all name steps of this flow |
   | step `loop` | `until` required, `every` optional |
   | step `outcome` | only the keys `done`, `fail`, `input` |
   | step `does`, `if`, `returns`, `needs[]`, `calls` | free text; `needs` a list; `calls` names a `skill`, `plugin` or `app` |

   Any other key is refused, so a typo is caught. A problem reads `skills/oneezy/x/flow.yaml: $.steps[2].after: no step has the id open-pr`.
3. **Generated-file drift.** The plugin form, by the same computation as `build --check`: every file a build would write or remove, and every package it cannot build (nothing when `generate.plugins` is false). And `skills-sync.lock.json`, against the lock a `refresh` would write from the snapshots under `upstream/` as they are: an entry edited by hand, an entry no source selects, a snapshot changed since; differences are named `source` (its version, commit or date) and `source:skill`. A config library that still has only the 0.4.0 `skills-lock.json` gets one problem, `old lock format; refresh migrates it`. A library without snapshots (a clone before its first `refresh`) has nothing to compare the lock with, so CI runs `refresh --frozen` first. `artifacts/` is never drift. A `skills-sync.json` the schema refuses is reported rule by rule and nothing is computed from it. The summary line names the command that writes what drifted (`build --plugins --catalogs`, `refresh`).

A library without a config has no generated files to check; its frontmatter and flows still are.

## Rules it never breaks

- A link is created, retargeted or removed only when its target is inside the library. A real folder in the way, or a link pointing elsewhere, is reported as a conflict and left alone.
- `build` writes only `plugins/<id>/` and the two catalogs, inside the library, plus `artifacts/` when `--artifacts` asks; `build --check` and `check` write nothing at all. A package is rewritten only when its inputs changed. `build` never follows a link: one inside `plugins/<id>` is a conflict and the package is left alone.
- `check` never touches the network and never clones a library to have one to check.
- `synced/` (Claude's account skills) and `.system/` are never touched.
- Third-party copies in `.agents/skills` are written only by `refresh` (config library) or by `npx skills` (legacy library); the link steps never edit them.
- `refresh` and `add` touch nothing outside the library: no pull, no `~/.skills-sync`, no harness folder.
- `refresh --frozen` and `sync` never write the lock and never move a source upstream; only an explicit `update` (or `refresh`) does, and only the sources it names.
- `update` never writes `skills-sync.json`; a hold is a config change the caller lands.
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
update | refresh: [<source>...]  --to <version>|previous|latest  --frozen  --retry  --json
versions <source>: --json
add <source>: --id <id>  --root <path>  --skills a,b | --skills '*'  --as old=new,...  --plugin <id> | --no-plugin
build: --plugins  --catalogs  --artifacts  --check
check: --json  --quiet
```

Commands: `sync` (default), `status`, `unlink` (remove every link this tool made in the user folders), `projects` (only step 6), `update` (alias `refresh`), `versions <source>` and `add <source>` (see [Third-party sources](#third-party-sources)), `build` (see [Plugins and catalogs](#plugins-and-catalogs) and [Artifacts](#artifacts)), `check` (see [Check](#check)).

`--watch` keeps running and redoes layers and user folders when `skills/`, the config or the lock changes, so a skill you add is linked the moment its folder appears.

## Development

```
pnpm install && pnpm build
pnpm test          # node:test on temp folders and temp git repos standing in for upstream; symlinks where the machine allows them, junctions otherwise
node dist/src/cli.js --repo <library> --plan
```

Publishing is not done by hand. Bump `version` here (and `VERSION` in `src/cli.ts`), merge to `dev`, promote to `main`: `.github/workflows/publish-skills-sync.yml` publishes any version npm does not have yet, through npm trusted publishing (no token, no `npm login`, no 2FA prompt), with provenance. To retry, run that workflow from the Actions tab.

The three JSON Schemas under `schemas/` ship with the package: `skills-sync.schema.json` for the config (sources, plugins, the `generate` switches, the `releases` upload record), which `refresh`, `add`, `build` and `check` validate before doing anything; `skills-sync.local.schema.json` for this machine's answers, validated on every read; and `flow.schema.json` for an own skill's `flow.yaml`, which `check` validates. The validator and the ZIP writer are in the tool; there is no dependency for either.
