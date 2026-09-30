# @oneezy/skills-sync

One skills library. Every agent harness. Every project on the machine.

```
npx @oneezy/skills-sync
```

Run it from anywhere. The first run asks a few questions and remembers the answers; every later run is silent and changes nothing unless something changed. Node 20+, git. Windows uses junctions (no admin), everything else symlinks.

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

`oneezy/skills` is one such library; `npx skills add oneezy/skills` installs its own skills anywhere, and cloning it plus one `npx @oneezy/skills-sync` gives a new machine the whole set.

## What a run does

1. **Find the library.** Walk up from the current folder for `skills/` beside `skills-lock.json`; else `$SKILLS_REPO`; else `~/dev/skills` or `~/skills`; else `--repo <path>`.
2. **Restore.** Lock entries with no folder in `.agents/skills` are fetched: one shallow clone per source, each skill copied from its recorded path, or found by folder name when upstream moved it. Skills upstream deleted are reported, remembered, and skipped until `--retry`. (`npx skills experimental_install` clones once per skill and stops at the first stale path, so this is done natively.)
3. **Layers.** `.agents/skills/<name>` links to `skills/<name>` for own skills, listed in a generated `.agents/skills/.gitignore`. Each selected harness that has its own project folder gets one link per working-set entry. Own skills with `disable-model-invocation: true` and no `agents/openai.yaml` get one generated from their frontmatter, so Codex sees the same policy.
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
--no-restore  --retry  --no-sidecars  --no-layers
--watch  --plan  --json  -y  --ask
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
