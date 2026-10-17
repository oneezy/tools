---
title: "@oneezy/skills-sync: tested baseline the skills repo depends on"
date: 2026-09-30
sources:
  - V:/dev/tools (branch dev, HEAD 3404da7937bea93d192784e8db8a7fdac0a03aea) clis/skills-sync/{package.json,README.md,.gitignore,src/cli.ts,src/library.ts,test/sync.test.ts}
  - git -C V:/dev/tools show origin/feature/skills-sync-npx:clis/skills-sync/src/{cli.ts,library.ts,package.json} (dd3c1519ce1d98bd0d4761c8aab6f20339595391)
  - https://github.com/oneezy/tools/pull/69 (gh pr view / gh api repos/oneezy/tools/pulls/69/files)
  - https://registry.npmjs.org/@oneezy%2fskills-sync (npm view, npm pack, npx --yes; all E404)
  - V:/dev/skills (main checkout, branch dev): .gitignore, skills-sync.json, .git/skills-sync-pulled, .agents/skills, .claude/skills
  - V:/dev/skills/.claude/worktrees/skills-skills/skills/oneezy-skills/{SKILL.md,scripts/sync.sh,scripts/sync.ps1}
  - C:/Users/Justin/.claude/settings.json, C:/Users/Justin/.claude/skills, C:/Users/Justin/.agents/skills, C:/Users/Justin/.skills-sync
  - C:/Users/Justin/.claude/jobs/432033f7/tmp/skills-sync-baseline (copy of HEAD, pnpm install + pnpm test), .../skills-sync-pr69 (git archive of PR #69), .../tools-bare (bare clone for merge-tree)
---

## Summary

`@oneezy/skills-sync` at tools `dev` HEAD (3404da7, v0.1.0) builds and passes 11/11 node:test tests, and a fresh build is byte-identical to the checkout's gitignored `dist/`. The package is **not published on npm** (E404 for every version), so the `oneezy-skills` wrapper's `npx --yes @oneezy/skills-sync` fails before any flag is parsed. Even if 0.1.0 were published, the wrapper's `add`/`update` paths pass `--quiet`, which 0.1.0 rejects with `unknown option --quiet` (exit 2); `--quiet` only exists in the unmerged 0.2.0 on PR #69 (`feature/skills-sync-npx`, CONFLICTING against dev). A local, unpushed rebase of that same content exists as `feature/skills-sync-plugins` (1a7f859, worktree created 17:26 today), so another agent is in flight on it. On this machine the library is `V:/dev/skills`, and 43 skills (6 own + 37 third-party) are junction-linked into `~/.claude/skills` and `~/.agents/skills`; no git hooks, husky or GitHub workflows exist in the skills repo.

## Facts

### 1. Git baseline of the source (V:/dev/tools)

- HEAD = `3404da7937bea93d192784e8db8a7fdac0a03aea`, branch `dev`, working tree clean, `dev` == `origin/dev`. Source: `git -C V:/dev/tools rev-parse HEAD`, `branch --show-current`, `status --short`. **verified**
- Only one commit on `dev` touches `clis/skills-sync`: `3404da7 feat(skills-sync): npx @oneezy/skills-sync replaces the Python tool (#67)` (squash-merge of PR #67, 2026-09-30T08:16Z). Source: `git -C V:/dev/tools log --oneline -8 -- clis/skills-sync`. **verified**
- `origin/main` = `54bc508 release: promote dev to main (...) (#68)`, so main also carries 3404da7. Source: `git log -2 origin/main`. **verified**
- Remote branches: `origin/dev`, `origin/feature/30-remote-sessions-picker`, `origin/feature/oneezy-remote-skill`, `origin/feature/skills-sync-npx`, `origin/fix/task-manager-caller-checkout`, `origin/main`. Source: `git -C V:/dev/tools branch -r`. **verified**
- **In flight, pushed:** PR #69 `feat(skills-sync): one command that works out where it is; tools stops committing skill copies`, OPEN, `feature/skills-sync-npx` @ `dd3c1519ce1d98bd0d4761c8aab6f20339595391` -> `dev`, created 2026-09-30T09:45Z, `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, no checks, no review. 398 files: 14 added, 3 modified, 381 removed (the committed skill copies). Source: `gh pr view 69 -R oneezy/tools --json ...`, `gh api repos/oneezy/tools/pulls/69/files`. **verified**
- PR #69 body states: "the npm package must be published before the skill's script works." Source: `gh pr view 69 --json body`. **verified**
- The conflicts are add/add in exactly `clis/skills-sync/README.md`, `package.json`, `src/cli.ts`, `src/library.ts` (branch keeps unsquashed 6e025b0 while dev has the squash 3404da7; merge-base d83d042). Source: `git -C tmp/tools-bare merge-tree --write-tree --name-only dev feature/skills-sync-npx`. **verified**
- PR #69 branch commits not on dev: `dd3c151 fix(skills-sync): sidecar generation is opt-in (--sidecars); it writes into skills/`, `c252799 revert(skills-sync): no session hooks; the oneezy-skills skill runs the sync instead`, `0c83188 feat(skills-sync): one command that works out where it is ... (#66)`, `6e025b0 feat(skills-sync): npx ... replaces the Python tool (#66)`. Source: `git log --oneline dev..origin/feature/skills-sync-npx`. **verified**
- **In flight, local only:** branch `feature/skills-sync-plugins` @ `1a7f859b62bb4019b74a1ef523390236ed151369`, merge-base with dev = 3404da7 (i.e. rebased onto dev), three commits all dated `2026-09-30 17:26:59 -0500`, content identical to PR #69 head (`git diff --stat dd3c151 1a7f859` is empty). Worktree `V:/dev/tools/.claude/worktrees/tools-skills-sync-plugins` created 17:26:59 today, status clean. Not on origin. Source: `git -C V:/dev/tools worktree list`, `merge-base`, `log --format=%ci`. **verified**; that it belongs to another agent of this workflow (task "Implement tools-side CLI changes on feature/skills-sync-plugins") is **inferred** from the task list and timestamps.
- Other worktree: `V:/dev/tools/.claude/worktrees/tools-issue-9-skills-sync` is checked out at `dd3c151 [feature/skills-sync-npx]` (PR #69's branch). Source: `git worktree list`. **verified**

### 2. Build and test of HEAD (copy in tmp/skills-sync-baseline)

- Toolchain: node v24.21.0, pnpm 12.5.1 (pnpm reports v12.8.1 at run time), npm 11.19.0; `pnpm install --frozen-lockfile` resolved 10 packages (`@clack/prompts 1.8.1`, `yaml 2.9.1`, `@types/node 24.19.0`, `typescript 5.9.3`). Source: shell. **verified**
- `pnpm test` = `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`: **tests 11, pass 11, fail 0, cancelled 0, skipped 0, todo 0**, duration ~1957 ms, exit 0. Test names: own skills linked; second run changes nothing; plan touches nothing; removed own skill drops links; stale copy becomes link / real folder is conflict; user folders one link per skill; unlink removes only ours; sidecar from frontmatter; projects link/copy; findLibrary walks up then env; windows paths to /mnt. Source: `tmp/skills-sync-baseline/test-output.txt`. **verified**
- `dist/` is **generated, not committed**: `clis/skills-sync/.gitignore` = `node_modules/`, `dist/`, `*.tgz`; `git ls-files clis/skills-sync` lists only `.gitignore README.md package.json pnpm-lock.yaml src/*.ts (8) test/sync.test.ts tsconfig.json`. **verified**
- The checkout's untracked `V:/dev/tools/clis/skills-sync/dist/` (built 2026-09-30 03:55:57 -0500) is byte-identical to the fresh build: `diff -r` clean, `sha256(cli.js) = 02cfd661cbcc90187511a3fadc93beb37b4a1a056b69e25492abf29ad4659791` on both. **verified**
- package.json: `"version": "0.1.0"`, `"bin": {"skills-sync": "dist/src/cli.js"}`, `"files": ["dist/src","README.md"]`, `"engines": {"node": ">=20"}`, no `prepublishOnly`/`prepack` script (nothing builds `dist/` on publish). Source: `V:/dev/tools/clis/skills-sync/package.json`. **verified**

### 3. npm registry

- `npm view @oneezy/skills-sync versions time dist-tags` -> `E404 Not Found - GET https://registry.npmjs.org/@oneezy%2fskills-sync`; `npm pack @oneezy/skills-sync` -> same E404, no tarball; `npx --yes @oneezy/skills-sync --help` -> same E404, exit 1. Registry is `https://registry.npmjs.org/`, `npm whoami` = `oneezy` (publish rights exist; nothing published). `npm search @oneezy` shows only `@oneezy/test`, `@oneezy/ui`. **verified**
- Therefore "published package vs repo HEAD" cannot be compared: there is no published package. **verified**
- No publish automation: `V:/dev/tools/.github/workflows/` contains only `task-manager.yml`; no `npm publish` anywhere in `.github`. **verified**

### 4. The wrapper bug

- `skills/oneezy-skills/scripts/sync.sh` `add` and `update` branches run `npx --yes @oneezy/skills-sync --quiet` (and `[ -d "$lib/skills" ] || npx --yes @oneezy/skills-sync --quiet`); default branch passes `"$@"` through. `sync.ps1` mirrors this. Both read `$SKILLS_REPO` else `~/.skills-sync`. Source: the two script files. **verified**
- HEAD build (0.1.0): `node dist/src/cli.js --quiet --plan --repo V:/dev/skills/.claude/worktrees/skills-skills` -> **exit 2**, stdout empty, stderr `unknown option --quiet` followed by the full HELP text. `--quiet` alone -> exit 2, same. `--help` -> exit 0, prints `skills-sync 0.1.0 ...`. The HELP has no `--quiet`; `parseArgs` in `src/cli.ts` rejects any unknown `-`-prefixed token with exit 2. **verified**
- Today, on this machine, the wrapper fails one step earlier: `npx` cannot resolve the package (E404, exit 1) before any argument is parsed. **verified**
- PR #69 / `feature/skills-sync-plugins` (0.2.0) adds `--quiet` (`src/cli.ts` line 46 help, 108 parse, 117 `if (a.quiet) a.yes = true`), skips WSL fan-out and chatter, prints only changes and problems. Its build (tmp/skills-sync-pr69) also passes 11/11 tests, and `--quiet --plan --repo <worktree>` exits 0. Source: `git show origin/feature/skills-sync-npx:clis/skills-sync/src/cli.ts`, shell. **verified**
- 0.2.0 also changes defaults that matter to the wrapper: library discovery order becomes `--repo`, `$SKILLS_REPO`, `~/.skills-sync`, walk-up, and the 0.2.0 walk-up skips any dot-folder such as `~/.claude` (0.1.0: walk-up, `$SKILLS_REPO`, `~/dev/skills`, then `~/skills`; source `clis/skills-sync/src/library.ts` lines 154-165 at HEAD, PR branch lines 160-178); it clones `oneezy/skills` into `~/.skills-sync` when none is found; it creates/relinks `~/.skills-sync` to the library; it `git pull --ff-only` the library at most every 30 min via stamp `.git/skills-sync-pulled`; sidecars become opt-in (`--sidecars`). Source: PR cli.ts lines 143-185, library.ts 179-215, HELP text. **verified**

### 5. What is linked today (HEAD build, `--repo V:/dev/skills`)

- `status`: `library V:\dev\skills: 6 own, 37 third-party, 1 in the lock but not installed` (`resolving-merge-conflicts`); `.claude\skills: 43 linked, 0 missing`; `C:\Users\Justin\.claude\skills: 43 linked, 0 missing`; `C:\Users\Justin\.agents\skills: 43 linked, 0 missing`. Own: oneezy-brain, oneezy-estimate, oneezy-merge, oneezy-remote, oneezy-skills, oneezy-status. **verified**
- `--plan --repo V:/dev/skills -y` (0.1.0): `1 would change, 141 already right, 0 left alone`; the one change is `+ write V:\dev\skills\skills\oneezy-skills\agents\openai.yaml (Codex sidecar)`, i.e. 0.1.0's default sidecar step would write into the committed `skills/` tree (the other five own skills already commit `agents/openai.yaml`). The 0.2.0 build's plan: `0 would change, 136 already right`. **verified**
- User folders are Windows junctions: `C:\Users\Justin\.claude\skills\<third-party> -> V:\dev\skills\.agents\skills\<name>` and `\<own> -> V:\dev\skills\skills\<name>` (cmd `dir /AL`); `~/.agents/skills` mirrors this; `V:/dev/skills/.claude/skills/*` link to `V:/dev/skills/.agents/skills/*` (third-party, real folders restored from the lock) or `V:/dev/skills/skills/*` (own). Extra unmanaged entries: `~/.claude/skills/synced/`, `~/.agents/skills/synced/`, and a dangling junction `~/.claude/skills/find-skills -> C:\Users\Justin\.agents\skills\find-skills` (target missing). **verified**
- `C:/Users/Justin/.skills-sync -> /v/dev/skills` (symlink, 2026-09-30 04:43 local) and `V:/dev/skills/.git/skills-sync-pulled` = `2026-09-30T09:43:39.582Z`: both are only written by the 0.2.0 code, so the PR #69 build has already been run once against this library. **verified** (artifacts) / **inferred** (which run made them)
- `V:/dev/skills/skills-sync.json` (gitignored) remembers `agents: [claude-code, codex]`, `global: true`, `dev: "V:\\dev\\tools\\.claude\\worktrees\\tools-issue-9-skills-sync\\clis\\skills-sync"` (a stale cwd from an earlier run), `projects: []`, `mode: link`, `wsl: []`, `unavailable: ["resolving-merge-conflicts"]`. **verified**
- `V:/dev/skills/.gitignore` ignores `.agents/skills/`, `.claude/skills/`, `.goose/`, `.hermes/`, `skills-sync.json`, `.claude/worktrees/`; main checkout `git status` is clean. **verified**
- Hazard: 0.2.0 `--quiet --plan --repo <this worktree>` plans `~ relink C:\Users\Justin\.skills-sync -> <worktree> (was V:\dev\skills)` plus 12 conflicts (every user-folder own-skill link "points outside the skills library"). A non-plan run with `--repo` pointing at a worktree would re-home the library. **verified** (plan output); the walk-up would not pick a worktree by itself because 0.2.0's `findLibrary` checks `$SKILLS_REPO`, then `~/.skills-sync`, before walking up (PR branch `src/library.ts` lines 164-167) - **verified** in source by the skeptic pass.

### 6. Hooks and workflows baseline (skills repo)

- `git config --global core.hooksPath` -> unset (exit 1); `git -C V:/dev/skills config core.hooksPath` -> unset. Global git: `core.symlinks=true`, `core.longpaths=true`, `core.autocrlf=input`. **verified**
- `V:/dev/skills/.git/hooks` contains no non-sample hooks (empty apart from samples). No `.husky/` and no `.github/` in `V:/dev/skills` or in this worktree; `gh api repos/oneezy/skills/contents/.github?ref=dev|main` -> 404. Branches on origin: `dev`, `main`. **verified**
- Claude Code hooks: `~/.claude/settings.json` has one `SessionStart` hook `bash "$HOME/.claude/hooks/sync-dev.sh"` (timeout 30). `V:/dev/skills/.claude/settings.local.json` only allows `git fetch *`, `git rev-list *`, `gh pr *`, `gh api *`; no project `settings.json`. **verified**

## Open questions

1. Which branch is meant to land the 0.2.0 CLI: PR #69 (`feature/skills-sync-npx`, conflicting) or the local rebase `feature/skills-sync-plugins` (clean on dev, unpushed)? Both carry identical content; PR #69 also deletes 381 committed skill copies from tools.
2. Who publishes `@oneezy/skills-sync` to npm, from which commit, and does `package.json` get a `prepublishOnly: pnpm build` so `dist/` exists at publish time?
3. Should the wrapper stop passing `--quiet` until 0.2.0 is published, or should the skill pin `@oneezy/skills-sync@^0.2`?
4. Is the 0.1.0 default of writing `skills/oneezy-skills/agents/openai.yaml` wanted (commit the sidecar) or is 0.2.0's opt-in the intended contract?
5. `resolving-merge-conflicts` is in `skills-lock.json` but "gone upstream": drop it from the lock or keep a copy in `skills/`?

## Blockers

- `@oneezy/skills-sync` is not on npm: every `oneezy-skills` wrapper path (`sync.sh`, `sync.ps1`) fails with E404 on this machine and on any fresh machine.
- `--quiet` (used by the wrapper's `add`/`update`) does not exist in the only code on `dev`/`main` (0.1.0 -> exit 2); it needs 0.2.0, which is unmerged and whose PR conflicts with dev.
- Another agent's worktree (`tools-skills-sync-plugins`, branch `feature/skills-sync-plugins`) was created during this run; tools-side edits must coordinate with it.

## Raw notes

- HEAD probe transcript (0.1.0): `--quiet --plan --repo <worktree>` exit 2 / `unknown option --quiet` + HELP; `--help` exit 0; `--quiet` exit 2.
- 0.2.0 probe (tmp/skills-sync-pr69): `--quiet --plan --repo <worktree>` exit 0, `plan: 14 would change, 0 already right, 12 left alone`, stderr `38 lock entries are not installed yet`; `--plan --repo V:/dev/skills -y` exit 0, `0 would change, 136 already right`.
- 0.1.0 `status --json` lists 37 third-party names (ask-matt ... writing-shape) and `missingFromLock: ["resolving-merge-conflicts"]`.
- PR #69 files kept: `.github/workflows/task-manager.yml` (6/6), `.gitignore` (+3), `AGENTS.md` (+2), and all 14 `clis/skills-sync/*` files as "added" relative to its base.
- `git worktree list` for tools also shows Codex worktrees under `C:/Users/Justin/.codex/worktrees/*` (detached, unrelated).
- tmp artefacts: `tmp/skills-sync-baseline/test-output.txt`, `tmp/npx-out.txt`, `tmp/npx-err.txt`, `tmp/pr69-out1.txt`, `tmp/pr69-err1.txt`, `tmp/tools-bare/`.

## Skeptic pass

Re-fetched on 2026-09-30 against the primary sources the note cites. Five claims a design decision depends on:

1. **`@oneezy/skills-sync` is not on npm.** `npm view @oneezy/skills-sync version` -> `E404 Not Found - GET https://registry.npmjs.org/@oneezy%2fskills-sync`, exit 1. **Holds.**
2. **The wrapper's `add`/`update` paths pass `--quiet`, and 0.1.0 rejects it with exit 2.** `skills/oneezy-skills/scripts/sync.sh` lines 8, 10, 15 and `sync.ps1` lines 7, 10, 15 run `npx --yes @oneezy/skills-sync --quiet`; `grep quiet V:/dev/tools/clis/skills-sync/src/cli.ts` at HEAD 3404da7 finds nothing; the HEAD build `--quiet --plan --repo <worktree>` exits 2 with stderr `unknown option --quiet` then the HELP. **Holds.**
3. **PR #69 is OPEN and CONFLICTING at dd3c151, and local `feature/skills-sync-plugins` (1a7f859) carries identical content rebased onto dev, unpushed.** `gh pr view 69` -> `state OPEN, mergeable CONFLICTING, mergeStateStatus DIRTY, headRefOid dd3c151..., changedFiles 398`; `git merge-base dev feature/skills-sync-plugins` = 3404da7; `git diff --stat dd3c151 feature/skills-sync-plugins` empty; `git ls-remote --heads origin feature/skills-sync-plugins` empty; `dev` == `origin/dev` == 3404da7. **Holds.**
4. **0.1.0 package.json has `bin dist/src/cli.js`, `files [dist/src, README.md]`, no `prepublishOnly`/`prepack`, and `dist/` is gitignored.** Confirmed from `clis/skills-sync/package.json` (scripts are only `build`, `test`, `start`), `.gitignore` (`node_modules/`, `dist/`, `*.tgz`) and `git ls-files` (14 tracked files, no `dist/`). **Holds.**
5. **0.2.0 discovery order `--repo`, `$SKILLS_REPO`, `~/.skills-sync`, walk-up; clones into `~/.skills-sync`; `git pull --ff-only` throttled to 30 min via `.git/skills-sync-pulled`; sidecars opt-in.** PR branch `src/library.ts` lines 160-178 (`findLibrary`), 179-186 (`cloneLibrary`), 189-212 (`pullLibrary`, stamp `.git/skills-sync-pulled`, `pull --ff-only --quiet`); `src/cli.ts` line 182 `pullLibrary(lib.root, 30, log)`, line 42/104 `--sidecars` default `false`. **Holds**, with one omission corrected: 0.1.0's fallback list also ends with `~/skills`, and 0.2.0's walk-up skips dot-folders.

Corrections applied: (a) section 4 bullet on discovery order now lists 0.1.0's `~/skills` fallback and 0.2.0's dot-folder skip, with line references; (b) section 5 hazard note upgraded from **inferred** (HELP order) to **verified** (source of `findLibrary`). No claim was found false.
