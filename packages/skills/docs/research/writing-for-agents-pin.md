---
title: writing-for-agents pin: which upstream revision the lock hash names, and what SKILL-MECHANICS.md says
date: 2026-09-30
sources:
  - https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/local-lock.ts (computeSkillFolderHash, collectFiles)
  - https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/blob.ts (computeSnapshotHash, snapshotHash)
  - https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/add.ts (where computedHash is written)
  - https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/update.ts (how staleness is checked)
  - https://github.com/mattpocock/skills (cloned with full history to C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/repo)
  - https://github.com/mattpocock/skills/blob/d81f3a183412e71a5b1e84ca21bc1a35eea03a60/skills/productivity/writing-for-agents/SKILL-MECHANICS.md
  - https://github.com/mattpocock/skills/blob/d81f3a183412e71a5b1e84ca21bc1a35eea03a60/.agents/invocation.md
  - https://skills.sh/api/download/mattpocock/skills/writing-for-agents
  - https://registry.npmjs.org/skills (npm view skills)
  - V:/dev/skills/.claude/worktrees/skills-skills/skills-lock.json
  - C:/Users/Justin/.claude/skills/writing-for-agents (symlink) -> V:/dev/skills/.agents/skills/writing-for-agents
  - C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/hash.mjs (reimplementation, this run)
---

# writing-for-agents pin

## Summary

The lock hash `95da47fc...959f` is the SHA-256 that `npx skills` computes over the skill folder's files, and it matches exactly one upstream revision: mattpocock/skills commit `321658273cb1d20b76026717d027d505790106d4` (2026-08-19, "Remove all em-dashes from the repo"). The folder has not changed since: its git tree SHA at that commit and at today's `main` HEAD (`d81f3a18...ea03a60`, 2026-09-29) are identical, so the pin is current, not stale. The local copy at `C:/Users/Justin/.claude/skills/writing-for-agents` (a symlink into `V:/dev/skills/.agents/skills/`) hashes to the same value and is byte-identical to upstream HEAD. `SKILL-MECHANICS.md` lives inside the skill folder and covers only invocation (model- vs user-invoked via `disable-model-invocation`), splitting by invocation, and router skills; it says nothing about name/description limits, `argument-hint`, `references/` or `scripts/`. One anomaly: the skills.sh download API reports a different `hash` (`0071124a...`) for the identical files, and the CLI's blob-install path writes that server hash into the lock, so a future re-add could change the lock value without any upstream change.

## Facts

### The hash algorithm

1. `computedHash` in a project `skills-lock.json` is produced by `computeSkillFolderHash(skillDir)` in `src/local-lock.ts` lines 145-184 (vercel-labs/skills `main` @ `3694740352eeef5cdd689af694c485f1ff62eec3`, 2026-09-28; package.json version 1.7.0). Source: https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/local-lock.ts. **verified**
2. Recipe, quoted from that function: walk the skill folder recursively with `readdir`; skip directories named `.git` or `node_modules`; every regular file is collected with `relativePath = relative(baseDir, fullPath).split('\\').join('/')`; `files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))`; then `createHash('sha256')`, and for each file `hash.update(file.relativePath); hash.update(file.content)` (no separators, path then raw bytes); `hash.digest('hex')`. **verified**
3. `localeCompare` (ICU collation) is load-bearing: it orders `agents/openai.yaml, SKILL-MECHANICS.md, SKILL.md`. Plain byte order (`SKILL-MECHANICS.md, SKILL.md, agents/openai.yaml`) gives `8365ebe1d0c343d3d46970526f30fcf7c5e0c5e49fd39a3c882977024626ff3c`, which is not the lock value. Source: run of `hash.mjs` (both variants). **verified**
4. `add.ts` writes `computedHash` on two paths. For a `well-known` source it is `computeSkillFolderHash(installDir)` (line 1029). For a `github` source such as this lock entry (`sourceType: "github"`), lines 2075-2078 pick `(skill as BlobSkill).snapshotHash` when the skills.sh blob path succeeded (`blobResult && 'snapshotHash' in skill`), else `computeSkillFolderHash(skill.path)`; the value is stored in `installedSkillHashes` and written to the lock at lines 2156-2167. `blob.ts` lines 695-696 set `snapshotHash` to the skills.sh server's `download.hash` when the file count matches, else to a local `computeSnapshotHash(files)` (same recipe: sort by `path` with `localeCompare`, `update(path)`, `update(contents)`). Source: https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/add.ts and `src/blob.ts`. **verified**
5. `update.ts` decides staleness for a project lock by cloning the source, running `computeSkillFolderHash` on the skill folder in the clone, and comparing to `entry.computedHash` (lines 893-896, 926: equal means "up to date", else reinstall). So my recomputation is the CLI's own check. Source: https://github.com/vercel-labs/skills/blob/3694740352eeef5cdd689af694c485f1ff62eec3/src/update.ts. **verified**
6. Reimplementation: `C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/hash.mjs` (Node, ~40 lines). It reproduces the lock hash bit-for-bit on the matching tree (fact 8), which validates the reimplementation. **verified**

### Which upstream commit the lock names

7. Commits on mattpocock/skills `main` touching `skills/productivity/writing-for-agents/` (`git log -- <path>` in the clone), oldest first, with the folder hash computed from `git archive <sha> <path>`:
   - `1fc6573e0e300118ce342fb9365521c9c34eefd4` 2026-07-31T18:04:40+01:00 "feat!: rename writing-great-skills to writing-for-agents and restructure" (creates the folder: SKILL-MECHANICS.md, SKILL.md, agents/openai.yaml). Hash `1a596d31464f285e86ce0d25133fb878862f78e6b1fb6c35476201761dbfe486`.
   - `f054defc3f694558dbd1f418cd9046057594283b` 2026-07-31T18:04:40+01:00 "feat(writing-for-agents): add the cache leading word for environment truth" (SKILL.md +1). Hash `29b5360d2a4539cd565d0dd683c4971dedb3c405e40038462e582282976eceb1`.
   - `4aaccb58d40559d7e3c59a029b2290ae5ba538de` 2026-08-05T16:53:54+01:00 "fix: make writing-for-agents model-invokable in Codex" (agents/openai.yaml). Hash `ccfa1e94d8f6ab5c6a1edd55293ca477faf93c39207771331efdb1e798ed21d6`.
   - `321658273cb1d20b76026717d027d505790106d4` 2026-08-19T10:03:37Z "Remove all em-dashes from the repo", committer "Remote Box Agent" (SKILL-MECHANICS.md, SKILL.md; 30 lines changed). Hash `95da47fc97af998e85b7d7e6d57b3ac76727c1e290cfe9ea09005aacb826959f`.
   Source: clone at `C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/repo`; extracted trees under `.../trees/<sha>/`. **verified**
8. The locked hash equals the hash at `3216582...06d4` and no other commit. That commit is the pinned revision. **verified**
9. Upstream default branch is `main`; HEAD at clone time (2026-09-30) is `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`, 2026-09-29T13:37:40+01:00, "Merge pull request #1120 from mattpocock/release/v1.3". Source: `git log -1` and `git remote show origin` in the clone. **verified**
10. The folder's git tree SHA is `ad2925850efb8973a72d2e666f7a975f9a2d4a9b` at both `3216582` and HEAD `d81f3a1`; `git log 3216582..origin/main -- skills/productivity/writing-for-agents/` is empty; the folder hash at HEAD is also `95da47fc...959f`. The pin is not stale. **verified**
11. `git log --follow` additionally lists `d4e8664be22d7079e50536761c30db2c1f8eacad` (2026-07-28) and `17f22a371b664caa1fc0dd53cc8f0d4ea0e9ef25` (2026-07-23), same subjects as `f054def` / `1fc6573`: pre-rename history under the old `writing-great-skills` path (a rebased pair). They never contain the current path, so they cannot match the lock. **inferred** (from identical subjects and dates; rename detection by `--follow`)

### The local copy

12. `C:/Users/Justin/.claude/skills/writing-for-agents` is a symlink (created 2026-09-30 01:34) to `/v/dev/skills/.agents/skills/writing-for-agents/`. That folder holds `SKILL.md` (10886 bytes, sha256 `551adca9...a74a`), `SKILL-MECHANICS.md` (2629 bytes, `c768e630...0059`), `agents/openai.yaml` (102 bytes, `eacb24b2...7e4b`), all dated 2026-09-30 03:55. Source: `ls -la`, `readlink -f`, `sha256sum`. **verified**
13. `hash.mjs` over that folder yields `95da47fc97af998e85b7d7e6d57b3ac76727c1e290cfe9ea09005aacb826959f`, equal to the lock; `diff -r` against the upstream HEAD extract reports no differences, and per-file sha256 values match upstream HEAD exactly (no CRLF drift). The local copy matches the lock. **verified**
14. The lock entry was introduced in this repo's commit `e7f47b1` (2026-09-21T18:56:06-05:00, "init") and has not changed since (`git log -S<hash> -- skills-lock.json`). **verified**
15. Both cached `npx` copies of the `skills` CLI on this machine are version 1.7.0 (`~/AppData/Local/npm-cache/_npx/5606f1555d02ef53`, 2026-09-17; `.../ac0ed6aa23b37c1e`, 2026-09-18); npm `latest` is 1.7.0. Source: their `package.json`; `npm view skills version dist-tags`. **verified**

### skills.sh hash anomaly

16. `GET https://skills.sh/api/download/mattpocock/skills/writing-for-agents` (HTTP 200) returns the same three files with identical bytes (SKILL.md is 10886 UTF-8 bytes) but `"hash": "0071124a923559493bc8924a90fb87bceb048d31ad2ce785fa4281d7c506bfa7"`. Recomputing `computeSnapshotHash` over the API's own `files` gives `95da47fc...959f`, not `0071124a...`. The server's hash therefore uses some other recipe. **verified** (both values observed; the recipe behind `0071124a` is unknown)
17. Because `add.ts` records the server's `snapshotHash` when the blob path succeeds and the file count matches (fact 4), a fresh `npx skills add mattpocock/skills` today may write `0071124a...` for this skill even though the content is unchanged; `update.ts` would then recompute `95da47fc...` locally, see a mismatch, and reinstall (fact 5). The present lock value `95da47fc` means it was produced by the local-compute path (git-clone fallback, or a CLI/server state where the two agreed). **inferred**

### SKILL-MECHANICS.md

18. Path: `skills/productivity/writing-for-agents/SKILL-MECHANICS.md`; it is the only file by that name in the repo at HEAD (`git ls-tree -r HEAD | grep -i SKILL-MECHANICS`). 22 lines. Its only change after creation was the em-dash removal in `3216582` (punctuation only, `git diff 1fc6573 HEAD -- <file>`). **verified**
19. Summary of its rules (source: the file at HEAD `d81f3a1`):
   - It is "the skill-specific branch of writing-for-agents": frontmatter, the invocation choice, and router skills; everything else is the universal reference in `SKILL.md`.
   - **Invocation** is a trade between two loads (context load on the agent vs cognitive load on the human).
   - **Model-invoked** skill: keeps a `description`; the agent can fire it and other skills can reach it; typing its name still works. The description is the skill's always-loaded top-level context pointer (permanent context load for discoverability). A model-invoked all-reference skill is the one home for reference shared by several skills. Mechanics: omit `disable-model-invocation`; write a model-facing description carrying the trigger branches, following the pointer-writing rules in `SKILL.md`.
   - **User-invoked** skill: only the human typing its name can invoke it; no other skill can. Zero context load, costs cognitive load. Mechanics: `disable-model-invocation: true`; `description` becomes human-facing: one-line summary, trigger lists stripped.
   - Pick model-invocation only when the agent, or another skill, must reach it on its own; otherwise make it user-invoked.
   - Reference shared by two user-invoked skills can live in neither; push it to a plain file outside the skill system that any skill can point at.
   - **Splitting by invocation**: split off a model-invoked skill only when a distinct leading word you actually use should trigger it, or another skill must reach it; the new always-loaded description costs context load.
   - **Router skills**: when user-invoked skills pile up, one user-invoked router names the others and when to reach for each; it can only hint, never fire them.
   - Absent from the file: name or description length limits, `argument-hint`, `references/` or `scripts/` folder conventions, `allowed-tools`. **verified**
20. How a skill points at other files, per the folder and repo conventions: `SKILL.md` links sibling files by relative Markdown link (`[SKILL-MECHANICS.md](SKILL-MECHANICS.md)`) with the condition stated inline ("When the document you're writing is a skill, read ..."), which `SKILL.md` calls a context pointer / disclosed reference. Cross-skill dependencies are expressed as "Call the Skill tool with \"name\"", not `../other-skill/FILE.md` links; shared reference lives inside the skill that owns it. Source: `SKILL.md` lines 1-8 and 30-40; `.agents/invocation.md` "Dependencies between them". **verified**
21. Frontmatter fields actually used in the repo: `name`, `description`, `disable-model-invocation` (16 promoted skills), `argument-hint` (only `skills/in-progress/claude-handoff/SKILL.md:4` and `skills/in-progress/loop-me/SKILL.md:5`). Every skill also carries `agents/openai.yaml` with `interface.display_name` / `interface.short_description`, and `policy.allow_implicit_invocation: false` for user-invoked skills, kept in sync with `disable-model-invocation`. Source: `git grep` at HEAD; `.agents/invocation.md`; `CLAUDE.md` line 19. **verified**
22. The only "1024 characters" description limit mentioned in the repo is inside `skills/engineering/triage/AGENT-BRIEF.md` (an example brief for the triage skill), not a rule for authoring skills. **verified**

## Open questions

- What recipe produces the skills.sh `hash` value `0071124a...` for this skill? It is not `computeSnapshotHash` over the served files. Not answerable from the CLI source; the server is closed.
- Was this repo's lock written by the git-clone path or by a blob install at a time when the server hash agreed with the local one? The lock records no `ref`, `sourceUrl`, or CLI version, so the path cannot be recovered from the file.
- Does `npx skills update` on this machine report writing-for-agents as up to date? Not run (would write files).

## Blockers

- None. All steps completed read-only; no git write operations were run.

## Raw notes

- Temp workspace: `C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/` (`repo/` clone, `trees/<sha>/` extracts, `vercel-src/*.ts` downloaded via `gh api .../contents`, `download.json` from skills.sh, `hash.mjs`).
- Hash table (localeCompare recipe): 1fc6573 `1a596d31...`; f054def `29b5360d...`; 4aaccb5 `ccfa1e94...`; 3216582 `95da47fc...` (LOCK); HEAD d81f3a1 `95da47fc...`; local copy `95da47fc...`.
- Folder tree SHAs: 1fc6573 `b82771ab...`; f054def `8c87c5b6...`; 4aaccb5 `bd9c9c47...`; 3216582 `ad292585...`; HEAD `ad292585...`.
- `SNAPSHOT_EXCLUDED_FILES = metadata.json` and `SNAPSHOT_EXCLUDED_DIRS = .git, __pycache__, __pypackages__` apply only to blob snapshots (blob.ts ~509-510); `computeSkillFolderHash` on disk skips only `.git` and `node_modules`. The two recipes agree for this skill because none of those names occur.
- The global `~/.agents/skills-lock.json` uses a different field, `skillFolderHash` (a 40-hex git tree SHA compared via the GitHub Trees API, update.ts 592-597, 638-641). The project lock in this repo uses `computedHash` (content SHA-256). Do not compare the two.
- `.agents/invocation.md` in mattpocock/skills is a repo-authoring doc, not part of the shipped skill; it is not hashed.
- Upstream `CLAUDE.md` forbids em-dashes repo-wide; commit `3216582` is that rule applied, which is why the pinned revision differs from `4aaccb5` only in punctuation.

## Skeptic pass

Date 2026-09-30. Each claim below was re-checked against its primary source, fetched fresh (not from the first run's cached copies): vercel-labs/skills sources via `gh api repos/vercel-labs/skills/contents/src/<file>?ref=3694740352eeef5cdd689af694c485f1ff62eec3` (package.json `version` 1.7.0 at that ref), skills.sh via `curl`, the mattpocock/skills clone after `git fetch origin`. Scratch files under `C:/Users/Justin/.claude/jobs/432033f7/tmp/writing-for-agents-pin/skeptic/`.

| # | Claim | Holds | Note |
|---|-------|-------|------|
| 2 | Hash recipe: recursive `readdir`, skip `.git`/`node_modules`, `localeCompare` sort, `update(relativePath)` then `update(content)`, hex digest | true | `local-lock.ts` lines 145-184 read verbatim. Only `entry.isFile()` entries are collected, so a symlinked file would be skipped; not relevant to this skill. |
| 4 | Where `add.ts` writes `computedHash`; `blob.ts` 695-696 uses the server `download.hash` when file counts match | true, overstated | Line 1029 is the `well-known` source path, not the general case. A `github` source (this lock) takes lines 2075-2078: server `snapshotHash` if the blob path succeeded, else local `computeSkillFolderHash`; written at 2156-2167. Fact 4 corrected in place. |
| 5 | `update.ts` clones, recomputes `computeSkillFolderHash`, compares to `entry.computedHash`; equal means up to date | true | Lines 893-896 and 926 read verbatim (`!relocated && latestHash === skill.entry.computedHash` → `upToDateCount++`). |
| 7/8/10 | Lock hash `95da47fc...` equals the folder hash at `3216582` only; folder tree `ad292585...` unchanged through HEAD `d81f3a1`; pin not stale | true | After `git fetch`, `origin/main` is still `d81f3a18...` (2026-09-29). `git log origin/main -- <folder>` lists exactly the four commits; `3216582..origin/main -- <folder>` is empty; tree SHA identical at both; `hash.mjs` over `git archive origin/main` gives `95da47fc...` (byte-order variant `8365ebe1...`, confirming fact 3). |
| 16 | skills.sh API returns identical bytes but `hash: 0071124a...`; `computeSnapshotHash` over its files gives `95da47fc...` | true | HTTP 200; files `agents/openai.yaml` 102 B, `SKILL-MECHANICS.md` 2629 B, `SKILL.md` 10886 B; response keys are `files` (`path`, `contents`) and `hash`; recomputed `95da47fc...`; server `0071124a...`. Recipe behind the server value remains unknown. |
| 19 | Summary of SKILL-MECHANICS.md rules and what is absent | true | 22 lines at `origin/main`; every bullet in fact 19 maps to a sentence in the file; no mention of length limits, `argument-hint`, `references/`, `scripts/`, `allowed-tools`. |

Not re-checked: facts 11-15, 18, 20-22 (local filesystem and repo-grep claims not load-bearing for a design decision beyond what the table covers).
