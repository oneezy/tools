# @oneezy/skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx @oneezy/skills-sync
```

Run it anywhere and it works out the rest:

- **No library on this machine?** It clones one into `~/.skills-sync` (default `oneezy/skills`; `--library owner/repo` for another) and asks nothing.
- **Library present?** It pulls it, restores whatever the lock file has that is missing, rebuilds the library's harness layers, and links every skill into each harness's user folder. Every step is skipped when its result is already right, so a no-op run is silent and fast.
- **On another machine or in a cloud session?** Run the same command there (or ask the agent to run the `oneezy-skills` skill, which does exactly that). Nothing is installed into any harness's settings.

First run on a machine with a terminal asks which harnesses, whether to link the user folders, which projects (if any) should carry copies, and (on Windows) which WSL distros. Answers are remembered in `skills-sync.json` beside the lock; `--ask` prompts again. Node 20+, git. Windows uses junctions (no admin), everything else symlinks.

Edit a skill in the library and every harness sees the change immediately: the user-folder entries are links. `git push` from the library is how it reaches other machines; their next session start pulls it.

## The library

A skills library is a folder with `skills/` beside one of three marker files:

| path | holds | written by |
|---|---|---|
| `skills/<name>/` | a flat own skill, bare Agent Skills form (`SKILL.md`, optional `scripts/`, `references/`, `agents/openai.yaml`) | you |
| `skills/<group>/<name>/` | an own skill inside a group; the group's name is its plugin id | you |
| `skills-sources.json` | the sources manifest: third-party repos, policies, selections, renames, pins, plugins | you, and `add` |
| `skills-sources-lock.json` | what the last refresh resolved: commit and date per source, path and hash per skill, transforms, pins | `refresh` and `add` |
| `skills-lock.json` | the compatibility lock: the same skills in the `npx skills` format (source repo, path, hash) | `refresh`, regenerated from the sources lock; or `npx skills add/update` in a library without a manifest |

A library with a manifest gets its third-party skills through `refresh` (see [Third-party sources](#third-party-sources)). A library with only `skills-lock.json` keeps working as before: `sync` restores from that lock and `npx skills update` owns the copies.

A folder directly under `skills/` that holds `SKILL.md` is a flat own skill. One without `SKILL.md` is a **group**: its children are own skills, and the group's name (`oneezy`, `trident`) is the plugin id they will be packaged under. A skill is known everywhere by its folder name alone, so `skills/oneezy/oneezy-status` links as `oneezy-status`, exactly as `skills/oneezy-status` would, and moving a skill into a group retargets its links without dropping any. Groups do not nest: a `SKILL.md` two levels below a group, or a second skill with a name already taken, is reported once on every run and never linked. `status --json` lists each own skill with its `plugin` (null when flat) and its `path` under the library.

Everything else in it is generated and should be gitignored:

| path | holds |
|---|---|
| `upstream/<source>/<upstream path>` | snapshots: each source's selected skill folders and attribution files at their upstream paths, plus `.snapshot.json`. Never edited. |
| `.agents/skills/<name>` | the working set: one copy per third-party skill (from its snapshot, with its rename applied), plus one link per own skill (flat or grouped). Codex reads this folder directly. |
| `.claude/skills/<name>`, `.goose/skills/<name>`, `.hermes/skills/<name>` | one link per working-set entry, for each harness that does not read `.agents/skills` |

`oneezy/skills` is one such library; `npx skills add oneezy/skills` installs its own skills anywhere, and cloning it plus one `npx @oneezy/skills-sync` gives a new machine the whole set.

## What a run does

1. **Find the library.** `--repo`, else `$SKILLS_REPO`, else `~/.skills-sync` (the clone, or a link to wherever the library really lives), else a library folder above the current one (`skills/` beside `skills-sources.json`, `skills-sources-lock.json` or `skills-lock.json`; never a dot-folder). Found somewhere else than `~/.skills-sync`? A link is left there so the next run finds it from anywhere. Nothing found? Clone one.
1. **Pull.** Fast-forward the library from its remote, at most every 30 minutes, only when its tree is clean (`--pull` forces, `--no-pull` skips).
2. **Restore.** With a manifest: a frozen `refresh` (below) brings every source to the commit in `skills-sources-lock.json` and rebuilds the working set; when the snapshots already match the lock nothing is cloned. Without one: lock entries with no folder in `.agents/skills` are fetched from `skills-lock.json`, one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it. Either way, skills upstream deleted are reported, remembered, and skipped until `--retry`.
3. **Layers.** `.agents/skills/<name>` links to each own skill's folder (`skills/<name>` or `skills/<group>/<name>`), listed in a generated `.agents/skills/.gitignore`. Each selected harness that has its own project folder gets one link per working-set entry. With `--sidecars`, own skills that lack `agents/openai.yaml` get one generated from their frontmatter, so Codex sees the same policy; it writes into `skills/`, so it is opt-in.
4. **User folders.** One link per skill in each selected harness's user skills folder (`~/.claude/skills`, `~/.agents/skills`, `~/.config/goose/skills`, `~/.hermes/skills`), pointing at the real folder. Every project on the machine now sees the set, and an edit in the library is live everywhere.
5. **Projects.** Optional. Git repos under the dev folder that you check get their skills too: **link** mode makes the same links inside the repo and hides them from git through `.git/info/exclude`; **copy** mode writes real folders meant to be committed, for repos that must carry their own (cloud sessions, other people).
6. **WSL.** Windows only, optional. Each checked distro runs the same sync for its own user folders through `/mnt/<drive>/…`. The distro needs Node.


Then it prints one line per change and a summary. `--plan` prints the same without touching anything.

## Third-party sources

Third-party skills come from **sources** declared in `skills-sources.json`. The manifest is yours to edit; `add` writes an entry for you. Its shape (the full rules are in `schemas/skills-sources.schema.json`):

```jsonc
{
  "version": 1,
  "library": { "name": "skills", "owner": "oneezy", "homepage": "https://github.com/oneezy/skills" },
  "sources": {
    "matt-pocock": {
      "repo": "mattpocock/skills",          // owner/repo, a git URL, or a local path
      "ref": "main",                        // the branch or tag to follow, or a commit to hold
      "policy": "follow",                   // follow: the tip of ref at every refresh; pin: the lock's commit until the lock is edited
      "root": "skills",                     // where the skill folders live (searched three levels deep, like npx skills)
      "skills": ["tdd", "writing-for-agents"],
      "pins": { "writing-for-agents": "321658273cb1d20b76026717d027d505790106d4" },   // one skill held at its own commit
      "attribution": ["LICENSE", "README.md"]                                          // carried into the snapshot and every package
    },
    "pstack": {
      "repo": "cursor/plugins", "ref": "main", "policy": "follow", "root": "pstack/skills",
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

**`refresh`** resolves every source and makes the library match:

1. The source's commit: the tip of `ref` for `follow` (one `git ls-remote`), the lock's commit for `pin`, the commit itself when `ref` is one. With `--frozen` it is always the lock's commit, and a source or skill the lock does not know is left alone; this is what `sync` runs.
2. Each selected skill is found under `root` by folder name. When the snapshot already holds that commit's content (its hash matches the lock) nothing is fetched; otherwise a temp clone is staged (shallow, at that commit; a per-skill pin stages its own) and deleted when done. A skill not found upstream is reported once as gone, remembered in `skills-sync.json`, and not looked for again until `--retry`.
3. The snapshot `upstream/<source>/` gets the skill folders and attribution files at their upstream paths, and a `.snapshot.json` (source, repo, ref, commit, date, skills, attribution). Folders the lock no longer lists are deleted. Snapshots are generated and never edited; gitignore `upstream/`.
4. `skills-sources-lock.json` is written (never with `--frozen`): per source its `commit` and `date`, per skill (by upstream folder name) its `path`, `hash`, `pinnedCommit` when pinned, and `transforms` (`[{ "kind": "rename", "to": "pstack-tdd" }]`); `generated.manifest` is the SHA-256 of the manifest it was resolved from; `releases` is kept for `build`. Shape in `schemas/skills-sources-lock.schema.json`.
5. The working set: `.agents/skills/<name>` becomes a copy of the snapshot folder, under the new name with the frontmatter `name` rewritten when renamed. A copy whose files already match is skipped; a copy no longer selected is deleted. One name selected by two sources: the first source by id wins and the other is reported until the manifest renames it. An own skill with the same name keeps it.
6. `skills-lock.json` is regenerated in the `npx skills` format (`source`, `sourceType: github`, `skillPath`, `computedHash`, and `ref` only when it is a branch or tag) so older skills-sync versions and `npx skills` keep restoring the same skills, without pins or renames.

The hash is the `npx skills` recipe (SHA-256 over every file's relative path then bytes, sorted by `localeCompare`), computed over bytes exactly as upstream committed them, so a lock written on one machine verifies on any other. `refresh --plan` shows the actions without touching the library (it still stages clones in the temp folder). `--json` adds `sources`, `gone`, `unlocked` and `problems` to the usual actions. A source that cannot be reached keeps its lock entry and snapshot, and the exit code is 1.

**`add <source>`** declares a source and brings its skills in: `add mattpocock/skills`, `add cursor/plugins#main --root pstack/skills --as tdd=pstack-tdd,teach=pstack-teach`, `add ../some/repo --skills a,b`. It stages the repo in a temp clone, lists the skills under `--root` (default `skills/` when the repo has one, else the root), writes the manifest entry (`--id`, default `owner-repo`; the default branch unless `#ref`; policy `follow`; every skill unless `--skills`; a map when `--as` renames; the nearest `LICENSE` and `README.md` as attribution) and runs `refresh` with that clone. Nothing is installed anywhere: no agent folder, no `~/.skills-sync`. `add --plan` prints the entry it would write and stops. Change the policy, add a pin or drop a skill by editing the manifest, then `refresh`.

## Rules it never breaks

- A link is created, retargeted or removed only when its target is inside the library. A real folder in the way, or a link pointing elsewhere, is reported as a conflict and left alone.
- `synced/` (Claude's account skills) and `.system/` are never touched.
- Third-party copies in `.agents/skills` are written only by `refresh` (manifest library) or by `npx skills` (legacy library); `sync` never edits them.
- `refresh` and `add` touch nothing outside the library: no pull, no `~/.skills-sync`, no harness folder.
- Inside WSL the library's own layers are left to Windows.

## Prompts and flags

Interactive (a terminal, no `-y`): library path, harnesses to sync (detected ones pre-checked), where (user folders, projects), which projects and link or copy, machines (Windows plus WSL distros). Answers are saved in `skills-sync.json` beside the lock; `--ask` prompts again.

Every answer is also a flag, so scripts and agents never see a prompt:

```
--repo <path>        --agents claude-code,codex,goose,hermes
--global | --no-global
--projects a,b | --projects '*' | --no-projects     --dev <dir>     --copy
--wsl Ubuntu | --wsl '*' | --no-wsl
--library owner/repo   --pull | --no-pull
--no-restore  --retry  --sidecars  --no-layers
--watch  --plan  --quiet  --json  -y  --ask
refresh: --frozen  --retry
add <source>: --id <id>  --root <path>  --skills a,b | --skills '*'  --as old=new,...
```

Commands: `sync` (default), `status`, `unlink` (remove every link this tool made in the user folders), `projects` (only step 5), `refresh` and `add <source>` (see [Third-party sources](#third-party-sources)).

`--watch` keeps running and redoes layers and user folders when `skills/` or a lock changes, so a skill you add is linked the moment its folder appears.

## Development

```
cd clis/skills-sync
pnpm install && pnpm build
pnpm test          # node:test on temp folders and temp git repos standing in for upstream; junctions on Windows, symlinks elsewhere
node dist/src/cli.js --repo <library> --plan
```

The two JSON Schemas under `schemas/` ship with the package; `refresh` validates the manifest against the first before doing anything.
