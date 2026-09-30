# skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx skills-sync
```

Run it anywhere and it works out the rest:

- **No library on this machine?** It clones one into `~/.skills-sync` (default `oneezy/skills`; `--library owner/repo` for another) and asks nothing.
- **Library present?** It pulls it, restores whatever the lock file has that is missing, rebuilds the library's harness layers, and links every skill into each harness's user folder. Every step is skipped when its result is already right, so a no-op run is silent and fast.
- **On another machine or in a cloud session?** Run the same command there (or ask the agent to run the `oneezy-skills` skill, which does exactly that). Nothing is installed into any harness's settings.

First run on a machine with a terminal asks which harnesses, whether to link the user folders, which projects (if any) should carry copies, and (on Windows) which WSL distros. Answers are remembered in `skills-sync.json` beside the lock; `--ask` prompts again. Node 20+, git. Windows uses junctions (no admin), everything else symlinks.

Edit a skill in the library and every harness sees the change immediately: the user-folder entries are links. `git push` from the library is how it reaches other machines; their next session start pulls it.

## The library

A skills library is a folder with two committed things:

| path | holds | written by |
|---|---|---|
| `skills/<name>/` | your own skills, bare Agent Skills form (`SKILL.md`, optional `scripts/`, `references/`, `agents/openai.yaml`) | you |
| `skills-lock.json` | pins for third-party skills: source repo, path, hash | `npx skills add <owner>/<repo>` and `npx skills update` |

Everything else in it is generated and should be gitignored:

| path | holds |
|---|---|
| `.agents/skills/<name>` | the working set: third-party skills restored from the lock, plus one link per own skill. Codex reads this folder directly. |
| `.claude/skills/<name>`, `.goose/skills/<name>`, `.hermes/skills/<name>` | one link per working-set entry, for each harness that does not read `.agents/skills` |

`oneezy/skills` is one such library; `npx skills add oneezy/skills` installs its own skills anywhere, and cloning it plus one `npx skills-sync` gives a new machine the whole set.

## What a run does

1. **Find the library.** `--repo`, else `$SKILLS_REPO`, else `~/.skills-sync` (the clone, or a link to wherever the library really lives), else a library folder above the current one (both `skills/` and `skills-lock.json`; never a dot-folder). Found somewhere else than `~/.skills-sync`? A link is left there so the next run finds it from anywhere. Nothing found? Clone one.
1. **Pull.** Fast-forward the library from its remote, at most every 30 minutes, only when its tree is clean (`--pull` forces, `--no-pull` skips).
2. **Restore.** Lock entries with no folder in `.agents/skills` are fetched: one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it. Skills upstream deleted are reported, remembered, and skipped until `--retry`. (`npx skills experimental_install` clones once per skill and stops at the first stale path, so this is done natively.)
3. **Layers.** `.agents/skills/<name>` links to `skills/<name>` for own skills, listed in a generated `.agents/skills/.gitignore`. Each selected harness that has its own project folder gets one link per working-set entry. With `--sidecars`, own skills that lack `agents/openai.yaml` get one generated from their frontmatter, so Codex sees the same policy; it writes into `skills/`, so it is opt-in.
4. **User folders.** One link per skill in each selected harness's user skills folder (`~/.claude/skills`, `~/.agents/skills`, `~/.config/goose/skills`, `~/.hermes/skills`), pointing at the real folder. Every project on the machine now sees the set, and an edit in the library is live everywhere.
5. **Projects.** Optional. Git repos under the dev folder that you check get their skills too: **link** mode makes the same links inside the repo and hides them from git through `.git/info/exclude`; **copy** mode writes real folders meant to be committed, for repos that must carry their own (cloud sessions, other people).
6. **WSL.** Windows only, optional. Each checked distro runs the same sync for its own user folders through `/mnt/<drive>/…`. The distro needs Node.


Then it prints one line per change and a summary. `--plan` prints the same without touching anything.

## Rules it never breaks

- A link is created, retargeted or removed only when its target is inside the library. A real folder in the way, or a link pointing elsewhere, is reported as a conflict and left alone.
- `synced/` (Claude's account skills) and `.system/` are never touched.
- Third-party copies in `.agents/skills` are never modified; `npx skills update` owns them.
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
```

Commands: `sync` (default), `status`, `unlink` (remove every link this tool made in the user folders), `projects` (only step 5).

`--watch` keeps running and redoes layers and user folders when `skills/` or the lock changes, so a skill you add is linked the moment its folder appears.

## Development

```
cd clis/skills-sync
pnpm install && pnpm build
pnpm test          # node:test on temp folders; junctions on Windows, symlinks elsewhere
node dist/src/cli.js --repo <library> --plan
```
