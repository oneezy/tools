# @oneezy/skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx @oneezy/skills-sync
```

Run it anywhere and it works out the rest:

- **No library on this machine?** It clones one into `~/.skills-sync` (default `oneezy/skills`; `--library owner/repo` for another) and asks nothing.
- **Library present?** It pulls it, installs the third-party skills exactly as the committed lock records them (nothing moves upstream), rebuilds the library's harness layers, installs its built plugins on Claude Code and Codex, and links every skill no plugin carries into each harness's user folder. Every step is skipped when its result is already right, so a no-op run is silent and fast.
- **On another machine?** Run the same command there (or ask the agent to run the `oneezy-skills` skill, which does exactly that). The tool never edits a harness's settings: plugins go in through each harness's own plugin commands.
- **In a cloud session?** The container starts with no library. Put `npx --yes @oneezy/skills-sync -y --agents claude-code --global --no-projects --no-wsl` in the cloud environment's setup script so the skills are linked before the session starts. Run mid-session instead, Claude Code lists them about a minute later. A cloud session (`CLAUDE_CODE_REMOTE=true`) keeps loose links unless `--plugins` asks: claude.ai already syncs its own plugins into the container.

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
| `skills-sync.local.json` | this machine's answers: harnesses, user folders, projects, WSL distros, skills found gone upstream, link mode, the user folders' form when a flag chose one, and the plugins the tool installed per harness. Gitignore it. | the tool, after every run |

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
2. **Pull.** Fast-forward the library from its remote, at most every 30 minutes, only when its tracked tree is clean (`--pull` forces a check, `--no-pull` skips). Dirty generated locks are user work too: sync preserves their bytes and HEAD rather than resetting them to make a pull succeed. Divergent branches are not merged. A landed library update arrives only through a clean compatible fast-forward.
3. **Restore.** With a config: a `refresh --frozen` (below), always, whatever the pull did: every third-party skill at the commit the lock records, nothing moves upstream, nothing written but the snapshots and the working set, never the lock. A plain sync (the default command, `--watch`, a setup script or session-start hook) therefore installs exactly what the library commits; only an explicit `refresh` moves a source. Without a config: lock entries with no folder in `.agents/skills` are fetched from `skills-lock.json`, one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it, exactly as 0.2.0 did. Either way, skills upstream deleted are reported, remembered, and skipped until `--retry`.
4. **Layers.** `.agents/skills/<name>` links to each own skill's folder (`skills/<name>` or `skills/<group>/<name>`), listed in a generated `.agents/skills/.gitignore`. Each selected harness that has its own project folder gets one link per working-set entry. With `--sidecars`, own skills that lack `agents/openai.yaml` get one generated from their frontmatter, so Codex sees the same policy; it writes into `skills/`, so it is opt-in.
5. **Plugins.** On Claude Code and Codex, when the library has built plugins, each one its catalog lists is installed through the harness's own commands and verified; see [The plugin form](#the-plugin-form). Goose and Hermes have no plugins. `--links` turns this off.
6. **User folders.** One link per skill in each selected harness's user skills folder (`~/.claude/skills`, `~/.agents/skills`, `~/.config/goose/skills`, `~/.hermes/skills`), pointing at the real folder, except the skills a verified plugin carries on that harness. Every project on the machine now sees the set, and an edit in the library is live everywhere.
7. **Projects.** Optional. Git repos under the dev folder that you check get their skills too: **link** mode makes the same links inside the repo and hides them from git through `.git/info/exclude`; **copy** mode writes real folders meant to be committed, for repos that must carry their own (cloud sessions, other people).
8. **WSL.** Windows only, optional. Each checked distro runs the same sync for its own user folders through `/mnt/<drive>/…`. The distro needs Node.

Then it prints one line per change, a line saying how many links it made and of which kind, and a summary. `--plan` prints the same without touching anything.

### Focused Brain-link adoption

`adopt-brain` is an explicit recovery command, not broad sync or unlink. It accepts a version 1 `--adoption-file` manifest with a `links` array of `{path, expectedTarget}` pairs, limited to the two historical links on this host: `C:\\Users\\Justin\\.agents\\skills\\oneezy-brain` and `C:\\Users\\Justin\\.claude\\skills\\oneezy-brain`, expected at `V:\\dev\\skills\\skills\\oneezy\\oneezy-brain`; or their WSL `/home/justin/` counterparts, expected at `/mnt/v/dev/skills/skills/oneezy/oneezy-brain`.

Pass `--repo <reviewed-clean-library> --expect-revision <full-sha> --remote-ref <exact-ref> --receipt <durable-json>`. Preview with `--plan --json`, then repeat without `--plan`. The command verifies the local/remote revision, checks required Brain files, immediately rechecks the expected link target, preserves the original link as a named sibling backup, reads back the replacement, and propagates only verified Brain global instruction blocks. It does not change other skills, repositories, native plugin installations, saved selections or `~/.skills-sync`. Failed destinations are reported separately; independent valid destinations may continue. Run it again to prove idempotence.

`rollback-brain --repo <library> --receipt <same-json>` restores only those preserved links, refusing changed adopted links or backups. It does not undo instruction blocks; retain the before-images for a reviewed instruction rollback. Receipts and the reviewed library must outlive the links. Generated package versions and installed plugin versions are separate facts. A newer installed semver plugin is preserved rather than reinstalled at an older built version.

### Explicit historical Skills/Status alias handoff (0.7.4)

`migrate-aliases --alias-file <manifest> --receipt <durable-json> --repo <verified-library> --expect-revision <full-sha> --remote-ref <exact-ref>` handles only the historical `oneezy-skills` and `oneezy-status` aliases in Justin's Windows `.agents/skills` and `.claude/skills`, or Ubuntu `/home/justin/` equivalents. The version 1 manifest supplies literal `path`/`expectedTarget` pairs at `V:\dev\skills\skills\oneezy\<skill>` or `/mnt/v/dev/skills/skills/oneezy/<skill>`. Preview with `--plan --json` first.

The enabled native plugin must match this library's registered source/version, expose the exact skill, and carry all reviewed files before an alias moves. Every selected alias on a harness passes preflight together. The tool rechecks immediately before mutation and moves the original link into `.skills-sync-alias-backups` under that harness's config directory, outside skill discovery. The receipt records replacement hashes and backup ownership. Independent harnesses can succeed while a failed prerequisite holds the other. This command does not pull, install plugins, remember choices or write instructions. Ordinary sync still preserves foreign links.

Repeat with the same manifest/receipt to verify idempotence. `rollback-aliases --repo <library> --receipt <receipt> [--plan --json]` restores only unchanged preserved aliases, refuses later destination edits and retains installed plugins. Keep receipts and backups durable. Verify fresh default discovery and actual Skills-to-Status execution separately from installed-file checks.

Claude write commands negotiate `--json` from their own `--help`; older versions with JSON listings but no JSON writes remain supported. Failed native commands retain structured `diagnostic.command`, `exitCode`, `stdout` and `stderr` on their conflict actions, with credential-bearing transport text redacted. No settings patch is used to hide failures.

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

Every source whose commit is not the one the lock had is reported, from and to, as `updated up: 1.2.0 (+1 commit) 4f2a9c1 -> 1.3.0 8d0e3b7` on stdout and in `--json` as `updated: [{ id, from: { version, commit, ahead }, to: { version, commit, ahead }, direction, changelog, changelogReason? }]` (`from` is null for a source new to the lock; `ahead` is null where it is not known). A source that did not move is not in it.

With each one comes what upstream's `CHANGELOG.md` says between the two versions, so breaking changes and migration notes are seen: the whole sections whose version heading (`## 1.3.0`, `## [1.3.0] - 2026-10-01`, `## v1.3.0`, matched as plain semver) is above the lower version and at or below the higher one, in the file's order, read at the higher side's commit from the `CHANGELOG.md` nearest the source's `root` (that folder, then each parent up to the repo root). 1.2.3 to 1.3.1 gives the 1.3.1 and 1.3.0 sections; a downgrade, 1.3.1 to 1.2.3, gives the same range as the one it undoes (`direction: "downgrade"`, else `"upgrade"`). On stdout the sections follow the `updated` line, indented under `changelog after 1.2.3 up to 1.3.1:` or `undoes the changelog after 1.2.3 up to 1.3.1:`. `changelog` is null, with `changelogReason` (printed as `changelog: none (<reason>)`), when there is no `CHANGELOG.md` upstream, either version has no heading in it, either side has no version, both sides are the same version, or the source is new to the lock.

**`update <source> --to <version>|previous|latest`** moves one source (`--to` with no source, or with two, is refused):

- `--to 1.3.0` takes that release, as a held version would; a leading `v` is accepted.
- `--to previous` takes the highest stable release below the version the lock records: the next lower tag, or for a source versioned by its manifest the newest commit carrying the next lower distinct version.
- `--to latest` takes the tip of `ref`, past any held version.

The config is not written. The change that makes the move stick is printed for the caller to land, `skills-sync.json: sources.up.version = "1.3.0"`, or `remove sources.up.version` for `latest` when a version is held (nothing when the config already says so); `--json` carries it as `config: [{ source, version }]`, `version` null for a removal. Until it lands, the next plain `update` puts the source back where the config says. A version the source has not released, or `previous` below its lowest release, is refused with the versions it has, newest first, `up: 1.5.0 is not a release (versions: 1.3.1, 1.3.0, 1.2.3)`; nothing is written and the exit code is 1 (`--json`: `{ "refused": "..." }`).

**`versions <source>`** lists what a source has released on `ref`'s history, highest first, each with its commit and date, the one the lock is at marked `*` with how far past it the lock is. Release tags when any is reachable (stable ones only, unless there are none; `v1.3.0` over `skills@1.3.0` when both name a version), else each distinct version of the manifest that versions it, at the newest commit carrying it. `--json`: `{ source, repo, ref, current: { version, commit, ahead }, versions: [{ version, commit, date, current }] }`. It stages a temp clone and writes nothing.

**`add <source>`** declares a source and brings its skills in: `add mattpocock/skills`, `add cursor/plugins#main --root pstack/skills --as tdd=pstack-tdd,teach=pstack-teach`, `add ../some/repo --skills a,b`. It stages the repo in a temp clone, lists the skills under `--root` (default `skills/` when the repo has one, else the root), writes the config entry (`--id`, default `owner-repo`; the default branch unless `#ref`; every skill unless `--skills`; a map when `--as` renames; the nearest `LICENSE` and `README.md` as attribution) and the plugin entry that packages it (`--plugin <id>`, default the source id, display name from the id; `--no-plugin` for none; an id already in `plugins` is refused before anything is written), and resolves that one source with that clone, as `update <source>` would: every other source stays exactly where the lock has it, and the new one is reported as updated. `build --plugins --catalogs` then writes the package. Nothing is installed anywhere: no agent folder, no `~/.skills-sync`, no `npx skills` run against the library. `add --plan` prints the entries it would write and stops. Add a pin or drop a skill by editing the config, then `refresh`.

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

The version in `plugin.json` and `.codex-plugin/plugin.json` comes from the package's owner. A third-party plugin uses its source's locked upstream version, with a leading `v` and build metadata removed. A source with no published semantic version stays unversioned: the manifests omit `version`, the archive uses `-unversioned.zip`, and the release record stores `null`. A build never fabricates an upstream version.

An authored plugin uses the explicit `library.version` in `skills-sync.json` (plain `MAJOR.MINOR.PATCH`). Every authored plugin in that repository shares it. Set it before the first build and bump it deliberately for a release; a build neither counts changed files nor increments any component. Missing authored versions are conflicts. Keep the source commit and date in `NOTICE.md` and artifact records, separate from the version.

Unchanged inputs preserve their recorded provenance, so repeated builds are byte-identical even after committing the generated files, squash merges or shallow clones. Legacy generated versions are replaced by the declared or locked version on the first build. Existing NOTICE commits and dates remain checked when the checkout has that commit.

The reusable release calculator is `node scripts/release-version.mjs <current> <message>... --require-emoji`. It accepts titles such as `🐛 fix(sync): preserve upstream versions (#135)`: `fix` bumps patch, `feat` bumps minor, `!` or a `BREAKING CHANGE:` footer bumps major, and other conventional types do not bump. It selects the highest bump once across the release. Scope, issue number and emoji do not change the bump. It prints `{version,bump}` and does not edit files, tag or publish. Stable versions only; release automation and prerelease policy remain tracked in oneezy/tools#135 and layerdbiz/tridentcubed#157.

A package that cannot be built is a conflict: a source that is not in the config, a source with no snapshot under `upstream/` (a clone before `refresh`), a link inside `plugins/<id>` (never followed, never written through). `build` leaves whatever `plugins/<id>` holds and exits 1; `build --check` lists `plugins/<id>` as drift. A link inside a source skill folder is not copied, with a note.

A group the config declares as a plugin but that holds no skill yet (a new, empty `play`) is not a conflict: `build` and `build --check` skip it with one note (`no skills under skills/<group> yet; not built, not cataloged`) and exit 0, and the catalogs leave it out. When a group's last skill goes, `build` removes its `plugins/<id>` with that reason, and until then `check` reports the package as drift.

A package holds LF line endings, whatever the checkout it was built in holds. A source file (a skill's file, the LICENSE) whose line endings are all CRLF is copied with LF: that is what `core.autocrlf=true` makes of a committed LF file, and copied as read it would give a different package, and a different archive, from the same commit, with shell scripts that fail on Linux. A file committed with CRLF is copied with LF too, the library's or upstream's; a binary file (a NUL byte, or more than one control character in 128 bytes) and a file with mixed line endings are copied as they are. Every file `build` writes is therefore LF; on a checkout where git converts to CRLF a committed file is compared as git sees it, so such a clone is as built and `build` rewrites nothing there. Give the library a `.gitattributes` with `* text=auto eol=lf` so every clone holds LF regardless of the machine's git settings.

`build --catalogs` writes the two root catalogs, each listing every plugin with a `./plugins/<id>` source, in the config's order: `.claude-plugin/marketplace.json` (`name` is `<owner>-<name>` from `library`, `owner`, `description`, `plugins[]` with `name`, `source`, `description`) and `.agents/plugins/marketplace.json` (Codex: `name`, `interface.displayName`, `plugins[]` with `name`, `source`, `description`, `policy` `installation: AVAILABLE` and `authentication: ON_USE`, `category`). `build` with no output flag writes both: the committed form. The upload archives are a third output, written only when `--artifacts` asks (see [Artifacts](#artifacts)).

**`build --check`** computes every output in memory, prints each path that differs from disk (a hand-edited copy, a source edited since the last build, a missing catalog, a stale package, a package that cannot be built), writes nothing, and exits 1; a clean library exits 0. `--check --plugins` or `--check --catalogs` narrows it to one form. It never looks at `artifacts/`. CI runs `build --check` on every push so a skipped local build cannot land drift; the default shallow checkout is enough for it. `build --plan` shows the writes without making them.

Plugin skills run namespaced: `/oneezy:oneezy-status` in Claude Code, `$oneezy:oneezy-status` in Codex; their folder names do not change. Each package passes `claude plugin validate` (the only warning is the missing Claude version, by design) and the root passes it as a marketplace.

## The plugin form

Claude Code and Codex can take the library's skills as plugins rather than loose links. When the library has built plugins (a catalog listing `./plugins/<id>`, see [Plugins and catalogs](#plugins-and-catalogs)), a sync gives each of those harnesses the plugin form; Goose and Hermes, which have no plugins, and projects (`--projects`, link or copy) keep links exactly as before. A library with no `plugins/` syncs exactly as 0.6.0 did, and asks no harness anything.

For each harness, in order:

1. **Can it?** The CLI (`claude`, `codex`) must be on PATH, else a note and links. Its `plugin --help` must list a `marketplace` command (asked through `--help` only, so an old CLI never starts a session); one that has none could only take plugins through an edit to its settings file, which the tool never makes: reported as blocked, naming that file (`~/.claude/settings.json`, `~/.codex/config.toml`, or under `CLAUDE_CONFIG_DIR` / `CODEX_HOME`), and links kept.
2. **Marketplace.** The library folder is registered under its catalog's name (`claude plugin marketplace add <library>`, `codex plugin marketplace add <library>`). A marketplace of that name registered from somewhere else is a conflict: left alone, links kept.
3. **Install.** Each catalog plugin not installed yet: `claude plugin install <id>@<marketplace> --scope user`, `codex plugin add <id>@<marketplace>`. Claude Code may read a directory marketplace's plugin in place, which needs no update, or keep a cache keyed by the library's Git revision. An existing cached Claude plugin at a different revision is updated with `claude plugin update <id>@<marketplace> --scope user`; installing it again leaves the old cache unchanged. Each Claude write command's help determines whether `--json` is supported. Codex runs a cache copy keyed by the manifest's version, so a plugin whose built `.codex-plugin` version differs is added again. A plugin of the same name installed from another marketplace, or one installed but disabled, is left alone and its skills keep their links. A plugin this tool installed that the catalog no longer lists is uninstalled.
4. **Verify, then unlink.** A plugin counts only when the harness lists it enabled at the built version/source (`plugin list --json`) and one of its skills resolves: `claude plugin details <id>@<marketplace>` names it, or `codex debug prompt-input` lists `<plugin>:<skill>`. Neither starts a session or spends tokens. Only then are the links this tool made for that plugin's skills removed from that harness's user folder (`~/.claude/skills`, `~/.agents/skills`); a link it did not make is never touched. A plugin that fails is a conflict line naming it, and its skills keep their links on that harness; the other harness carries on. A plugin already in place whose skills hold no link of the tool's is not asked again, so a sync with nothing new runs three quick listings per harness.

The harnesses write their own settings while they install (Claude Code's `extraKnownMarketplaces` and `enabledPlugins`, Codex's `[marketplaces.*]` and `[plugins.*]`); that is the harness's doing through its supported command, not an edit by this tool. What the tool installed is recorded under `plugins` in `skills-sync.local.json`, keyed by the harness's config folder (Windows and each WSL distro apart), so nothing else is ever removed.

**Rollback.** `sync --links` uninstalls the plugins the tool installed (`claude plugin uninstall --scope user`, `codex plugin remove`), keeps the marketplace registered, and restores the loose links; a second `--links` changes nothing. `--plugins` goes back. Either flag is remembered as `form` in `skills-sync.local.json`; with neither, the form is `plugin`, or `links` in a cloud session (`CLAUDE_CODE_REMOTE=true`), where claude.ai already syncs plugins of the same names into the container and the repos' instructions read `~/.claude/skills/<name>/SKILL.md`. `unlink` removes both forms the tool owns: its links, its plugins, then its marketplace (Codex's marketplace remove does not take its plugins with it, so they go first).

**status** adds, per harness, `form: plugin | links` (with why, for links) and per built plugin its installed and built versions and a `match` flag; `status --json` puts it under `harnesses`. Claude Code's plugin matches when it is read in place from the built package or its cached version is the library's current Git revision; Codex's when its version is the built one. A successful update response that leaves a stale or disabled plugin is reported as unverified and keeps owned loose links.

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

The config's optional `releases` section is that record, one entry per plugin id written by hand after each upload: `plugin_id`, `release_id`, `sha256` of the archive, `scope` (`personal` or `workspace`), `date`, and optionally `files`, the archive's entries as `releases.json` lists them; the schema admits nothing else there. An archive whose sha256 equals the recorded one has not changed since its upload. A ChatGPT plugin update overlays files; omissions remain unless the current supported API receives explicit `delete_paths`. When recorded `files` are missing from a new archive, `artifacts/<id>.changes.md` lists them for review. An authorized deletion uses only verified exact plugin-root-relative paths, the current source’s `expected_release_id` and readback. The note never authorizes deletion or automatic replacement/uninstall. An API without deletion support is reported as blocked. A recorded path counts with or without its leading `<id>/` folder. No recorded `files`, or every one still in the archive: no note.

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
3. **Generated-file drift.** The plugin form, by the same computation as `build --check`: every file a build would write or remove, and every package it cannot build (nothing when `generate.plugins` is false). And `skills-sync.lock.json`, against the lock a `refresh` would write from the snapshots under `upstream/` as they are: an entry edited by hand, an entry no source selects, a snapshot changed since; differences are named `source` (its version, commit or date) and `source:skill`. A config library that still has only the 0.4.0 `skills-lock.json` gets one problem, `old lock format; refresh migrates it`. A source `skills-sync.json` holds at a version the lock does not have it at (the hold was landed, the update was not run) gets one problem on `skills-sync.json`, `sources.<id>.version holds 1.2.0 but the lock has 1.3.1; run update <id>`. A library without snapshots (a clone before its first `refresh`) has nothing to compare the lock with, so CI runs `refresh --frozen` first. `artifacts/` is never drift. A `skills-sync.json` the schema refuses is reported rule by rule and nothing is computed from it. The summary line names the command that writes what drifted (`build --plugins --catalogs`, `refresh`).

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
- No settings file of any harness is ever edited by the tool. A plugin is installed, reinstalled or removed only through the harness's own command, and removed only when the tool installed it; a skill's loose link goes only after its plugin is verified on that harness.
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
--plugins | --links
--library owner/repo   --pull | --no-pull
--no-restore  --retry  --sidecars  --no-layers
--watch  --plan  --quiet  --json  -y  --ask
update | refresh: [<source>...]  --to <version>|previous|latest  --frozen  --retry  --json
versions <source>: --json
add <source>: --id <id>  --root <path>  --skills a,b | --skills '*'  --as old=new,...  --plugin <id> | --no-plugin
build: --plugins  --catalogs  --artifacts  --check
check: --json  --quiet
```

Commands: `sync` (default), `status`, `unlink` (remove every link this tool made in the user folders, then every plugin and marketplace it installed), `projects` (only step 7), `update` (alias `refresh`), `versions <source>` and `add <source>` (see [Third-party sources](#third-party-sources)), `build` (see [Plugins and catalogs](#plugins-and-catalogs) and [Artifacts](#artifacts)), `check` (see [Check](#check)).

`--watch` keeps running and redoes layers and user folders when `skills/`, the config or the lock changes, so a skill you add is linked the moment its folder appears.

## Development

```
pnpm install && pnpm build
pnpm test          # tsc, then vp test (Vitest) on temp folders and temp git repos standing in for upstream; symlinks where the machine allows them, junctions otherwise
node dist/src/cli.js --repo <library> --plan
```

Publishing is not done by hand. Bump `version` here (and `VERSION` in `src/cli.ts`), merge to `dev`, promote to `main`: `.github/workflows/publish-skills-sync.yml` publishes any version npm does not have yet, through npm trusted publishing (no token, no `npm login`, no 2FA prompt), with provenance. To retry, run that workflow from the Actions tab.

The three JSON Schemas under `schemas/` ship with the package: `skills-sync.schema.json` for the config (sources, plugins, the `generate` switches, the `releases` upload record), which `refresh`, `add`, `build` and `check` validate before doing anything; `skills-sync.local.schema.json` for this machine's answers, validated on every read; and `flow.schema.json` for an own skill's `flow.yaml`, which `check` validates. The validator and the ZIP writer are in the tool; there is no dependency for either.

## Managed instruction entrypoints (0.6.0)

An optional `skills-sync.entrypoints.json` version-1 manifest declares named blocks with `source`, required own `skill`, selected `agents` and optional `requiredFiles`. Templates stay in the source library. Sync appends or replaces only the exact `<!-- skills-sync:<id>:start -->`/end block, preserving all outside bytes and line endings. No manifest preserves prior links-only behavior.

Codex targets the configured CODEX_HOME’s AGENTS.md and an existing AGENTS.override.md, plus selected projects’ existing nested AGENTS/override files. Claude targets the configured CLAUDE_CONFIG_DIR’s CLAUDE.md, plus selected projects’ existing CLAUDE.md, CLAUDE.local.md and .claude/CLAUDE.md. A new project CLAUDE.md imports existing AGENTS fallbacks to preserve their instructions. Symlinked files/parents, malformed markers, changed-after-plan targets and nontext instructions are conflicts left alone. Additional host-managed policies and instruction imports require actual host inspection; this is not proof of every future session’s loading.

`--plan` writes nothing. Both plan and apply gate each instruction destination on its required installed skill and references before planning a write. Links must resolve to the canonical own skill (explicit project-copy mode verifies the copy); native plugins must match the registered library, enabled identity/version, exact resolved skill and packaged bytes. A stale plugin dependency also retains that skill's owned loose link. A blocked destination exits nonzero while independent valid destinations continue. Apply rechecks dependency, source-template and destination hashes immediately before writing, then reads back. `status` inspects without writing. `--no-entrypoints` opts out; `--no-remember` avoids changing per-machine answers during a development handoff. No hook, schedule or cloud upload is added.

For a pinned rollout, pass `--expect-revision <full-commit-sha> --remote-ref refs/tags/<release-tag>` with `--no-pull`. The default remote ref is `refs/heads/main`. The selected HEAD, clean authored/generated library files, and origin's exact ref (peeled for annotated tags) must all agree before rollout. Missing access or a mismatch refuses the rollout; it never changes Git configuration or replaces dirty work. Development checkouts omit this flag until their source changes are committed and reviewed.
