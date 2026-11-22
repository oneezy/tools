---
title: PStack (Lauren Tan's Cursor skill pack) as a third-party source, and what in ~/.codex/skills is and is not PStack
date: 2026-09-30
sources:
  - https://github.com/cursor/plugins (gh api: default_branch main, license null at repo level; `pstack/` subtree; `.cursor-plugin/marketplace.json`)
  - https://github.com/cursor/plugins/blob/main/pstack/.cursor-plugin/plugin.json (version 0.15.5), pstack/LICENSE, pstack/README.md, commit history of pstack/ (gh api repos/cursor/plugins/commits?path=pstack)
  - https://raw.githubusercontent.com/cursor/plugins/b97db39ffb8c0c6cb2a85d8591ebae370851d241/pstack/skills/<name>/SKILL.md (all 47, diffed against local copies)
  - https://github.com/backnotprop/pstack (README, MIRROR.md, LICENSE via gh api)
  - https://www.skills.sh/cursor/plugins and https://www.skills.sh/backnotprop/pstack (registry pages)
  - https://github.com/vercel-labs/skills README + cached skills@1.7.0 at C:/Users/Justin/AppData/Local/npm-cache/_npx/5606f1555d02ef53/node_modules/skills/dist/cli.mjs
  - https://github.com/openai/skills/tree/main/skills/.curated (directory listing)
  - https://github.com/mattpocock/skills (git tree at main, skill names)
  - C:/Users/Justin/.codex/skills/** (76 skill folders + .system), C:/Users/Justin/.codex/config.toml, C:/Users/Justin/.cursor/
  - C:/Users/Justin/.codex/archived_sessions/rollout-2026-09-10T16-54-35-01a08d50-c4c6-7a63-bad2-e687a39c841c.jsonl (the Codex session that installed pstack)
  - oneezy/brain .research/state-of-everything-2026-09-23.md (lines 492, 594-613, 823, 827) via gh api
  - V:/dev/ai-workflow/docs/global-capability-selector.md; V:/dev/skills/.claude/worktrees/skills-skills/skills-lock.json
  - Scratch: C:/Users/Justin/.claude/jobs/432033f7/tmp/pstack/ (pin-*.md, mirror-*.md, brain-state.md, name lists)
---

# PStack as a source for the skills library

## Summary

PStack is Lauren Tan's ("poteto") Cursor plugin, canonical at `github.com/cursor/plugins`, subtree `pstack/`, MIT (© 2026 Lauren Tan), default branch `main`, version 0.15.5, skills at `pstack/skills/<name>/SKILL.md` (47 today), installed in Cursor with `/add-plugin pstack`; the repo ships a Cursor `.cursor-plugin/marketplace.json`, not a `skills-lock.json`.
`npx skills add cursor/plugins` works (skills.sh lists it, 99 unique skills across all Cursor plugins) but only via the CLI's whole-repo fallback walk, since 1.7.0 reads `.claude-plugin/` manifests, not `.cursor-plugin/`; `backnotprop/pstack` is a harness-neutral MIT mirror (`npx skills add backnotprop/pstack`, 50 skills) that lags upstream (last push 2026-09-14).
Justin's `~/.codex/skills` holds exactly 47 PStack skills copied by a Codex Desktop session on 2026-09-10 from `cursor/plugins@b97db39` (then `main`): every body is byte-identical to that pin; only the frontmatter was normalized, `tdd`/`teach` were renamed `pstack-tdd`/`pstack-teach`, and a Codex `agents/openai.yaml` was added per folder.
The other 29 folders are: 25 mattpocock/skills, 3 Justin's own (`priority-brief`, `obsidian-memory`, `global-capability-selector`), 1 openai/skills curated (`transcribe`). `make-bot-ui` and every `principle-*` folder are PStack.
Open: pin `cursor/plugins` (canonical, Cursor-only paths, moving defaults) or `backnotprop/pstack` (portable, stale); how to keep the `pstack-tdd`/`pstack-teach` rename under `npx skills` first-seen-wins dedup.

## Facts

### Canonical repository

1. PStack lives at `https://github.com/cursor/plugins`, directory `pstack/`; `pstack/.cursor-plugin/plugin.json` says `"homepage": "https://github.com/cursor/plugins/tree/main/pstack"`, `"repository": "https://github.com/cursor/plugins"`, `"author": {"name": "Lauren Tan"}`, `"license": "MIT"`, `"version": "0.15.5"`, `"skills": "./skills/"`, `"agents": "./agents/"`. Source: gh api contents/pstack/.cursor-plugin/plugin.json. **verified**
2. Author handle is "poteto": README opens "i'm [poteto](https://x.com/poteto) ... at Cursor ... react core team". First commit `24bd6eb895` 2026-05-23 "Add pstack plugin" by `lauren <lauren@anysphere.co>`; every later pstack commit is by "lauren". Source: pstack/README.md; gh api commits?path=pstack. **verified**
3. Default branch `main`; repo-level license is `null` (license endpoint 404); `pstack/LICENSE` is "MIT License / Copyright (c) 2026 Lauren Tan". Source: gh api repos/cursor/plugins, /license, contents/pstack/LICENSE. **verified**
4. Tree: `pstack/{.cursor-plugin/plugin.json, .gitignore, LICENSE, README.md, agents/{comment-sicko.md, poteto-agent.md}, assets/, automations/benny, docs/, skills/}`. `skills/` has 47 dirs at `main` (same 47 at b97db39): architect, arena, automate-me, blast-radius, bro, create-verification-skill, figure-it-out, how, interrogate, maintain-verification-skill, make-bot-ui, no-comments, poteto-mode, 23 `principle-*`, recall, reflect, setup-pstack, show-me-your-work, swarm, tdd, teach, technical-writing, typescript-best-practices, unslop, why. Each skill dir ships only `SKILL.md` (poteto-mode adds `playbooks/`, `references/`, `scripts/`); no `agents/openai.yaml` upstream. Source: gh api contents listings. **verified**
5. Marketplace: root `.cursor-plugin/marketplace.json` (name `cursor-plugins`, owner Cursor `plugins@cursor.com`) lists `{"name":"pstack","source":"pstack"}` and `dyl-stack` ("Dylan's agent style on top of pstack"). No `skills-lock.json` at the repo root or under `pstack/`. Source: gh api contents/.cursor-plugin/marketplace.json; root and pstack listings. **verified**
6. Intended install is Cursor's `/add-plugin pstack`, then `/setup-pstack` (writes `~/.cursor/rules/pstack-models.mdc`) and `/poteto-mode`. Source: pstack/README.md "## install". **verified**
7. Upstream moved after Justin's copy: #366 (2026-09-13) added the budget ask to setup-pstack; #414 (2026-09-23) "default to Opus 5.5 and Grok 4.7"; #422 (2026-09-23) rule-reading fix; README now says the default panel is "opus 5.5 / sol / grok". Local/mirror text still says fable 5.1 / sol / grok / opus 5. Source: gh api commits?path=pstack/skills/setup-pstack/SKILL.md; README diff. **verified**
8. Cursor-only dependencies in the skill text: `~/.cursor/rules/pstack-models.mdc` (setup-pstack, arena, swarm, interrogate), `subagent_type: "poteto-agent"` and `pstack/agents/*.md` (poteto-mode, no-comments), Cursor built-in `create-skill` (automate-me, poteto-mode), `cursor-team-kit` plugin skills `/deslop`, `control-cli`, `control-ui` (poteto-mode), Cursor `/loop` and `AskQuestion`, `.cursor/skills/verify-<app>/` (create-verification-skill), `node pstack/skills/poteto-mode/scripts/check-plan.mjs` and `git show origin/main:pstack/skills/...` (multi-phase-plan playbook), scripts package `@cursor-skill/poteto-mode-tools` (bun). Source: grep of ~/.codex/skills. **verified**

### Mirror and ports

9. `https://github.com/backnotprop/pstack`: not a GitHub fork (`fork: false`), default `main`, MIT (same "Copyright (c) 2026 Lauren Tan"), description "Skills and principles for rigorous AI-assisted engineering", last push 2026-09-14T15:57Z, 730 stars (2026-09-30). README top: "Mirror of cursor/plugins/pstack ... Works in Claude Code, Codex, Pi, and other agents"; install `npx skills add backnotprop/pstack`. MIRROR.md: branch `upstream` holds Cursor's files unchanged, `main` = upstream + "harness-neutral rewrites in some skills" (e.g. setup-pstack writes `~/.agents/pstack-models.md` for non-Cursor harnesses). Same 47 skill dirs plus root files. Source: gh api; raw mirror SKILL.md. **verified**
10. skills.sh shows `backnotprop/pstack` with "36.6K total installs", 50 skills (unslop 1.4K, why 864, how 864, blast-radius 837, technical-writing 821). Source: https://www.skills.sh/backnotprop/pstack. **verified** (registry page). The 50 = 47 `skills/<name>/SKILL.md` + 3 `SKILL.md` under `automations/benny/skills/` (`reproduce-and-fix-issues`, `setup-benny`, `triage-issue-reports`), which the CLI's depth-5 fallback walk also reaches. Source: gh api git/trees/main?recursive=1 on backnotprop/pstack (skeptic pass). **verified**
11. Other ports exist per web search only (michael-denyer/pstack-claude, bnema/pi-pstack, @zenspc/pi-pstack on pi.dev). **unknown** (not opened)

### `npx skills add` and cursor/plugins

12. skills.sh lists `cursor/plugins` with install command `npx skills add cursor/plugins`, "231.8K across 99 skills", including arena (3.1K), setup-pstack (2.7K), Poteto Mode (2.7K). Source: https://www.skills.sh/cursor/plugins. **verified**
13. cursor/plugins@main has 101 `SKILL.md` files, 99 unique names (dups: `pr-review-canvas`, `thermo-nuclear-code-quality-review`, each in `cursor-team-kit/` and its own plugin). No pstack skill name appears outside `pstack/`. Source: gh api git/trees/main?recursive=1. **verified**
14. skills CLI 1.7.0 discovery reads only `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json` (dist/cli.mjs ~1047-1062); `.cursor-plugin/` is never read. Priority containers are the repo root (depth 1), `skills/`, `skills/.curated|.experimental|.system`, and agent dirs (depth 3). None match cursor/plugins, so `skills.length === 0` triggers `findSkillDirs(searchPath)` (maxDepth 5, cli.mjs 1284, 1371-1380), which reaches `pstack/skills/<name>/SKILL.md` at depth 3. Source: cached cli.mjs; README "Skill Discovery". **verified** (code read); that a plain `npx skills add cursor/plugins` therefore lists all 99 is **inferred** (matches skills.sh's 99).
15. Narrower forms documented by the CLI README: tree URL `npx skills add https://github.com/<o>/<r>/tree/main/<path>` and `--skill <name>` filters; lock file is `skills-lock.json` (`LOCAL_LOCK_FILE`, version 1; entries `source`, `sourceType`, `skillPath`, `computedHash`). A cursor/plugins entry would carry `skillPath: pstack/skills/<name>/SKILL.md`. Source: README, cli.mjs, this repo's skills-lock.json. **verified** for syntax/lock shape; skillPath value **inferred**.
16. Name overlap between pstack (47) and mattpocock/skills (37 at main): exactly `tdd` and `teach`. Source: comm of both trees. **verified**

### What is in ~/.codex/skills (76 folders + `.system`)

17. Install event: Codex Desktop session 2026-09-10 (rollout-2026-09-10T16-54-35-...jsonl). User: "https://github.com/cursor/plugins/tree/main/pstack/skills — can you install these skills on the chatGPT desktop app?". Agent ran `.system/skill-installer/scripts/install-skill-from-github.py --repo cursor/plugins --ref $revision --dest .` with `b97db39ffb8c0c6cb2a85d8591ebae370851d241` (cursor/plugins commit 2026-09-10T21:54:46Z "Merge pull request #351 ... plugin-meltwater", i.e. `main` that day; pstack version 0.15.1), reported "Installed all 47 pstack skills", renamed `tdd`/`teach` to `pstack-tdd`/`pstack-teach` for conflicts, "small compatibility edits: valid skill names and preservation of the source's manual-invocation settings", and warned "Cursor-specific model, transcript, and automation workflows still need adaptation". **verified**
18. All 47 local SKILL.md bodies are byte-identical to `pstack/skills/<name>/SKILL.md` @b97db39 after dropping frontmatter and CR (local files are CRLF). Frontmatter differs: `disable-model-invocation: true` removed, descriptions re-wrapped, `name: Poteto Mode` -> `poteto-mode`, `name: Make Bot UI` -> `make-bot-ui`, Cursor keys (`mode`, `icon`, `color`, `reminder`, `paths`) moved under `metadata.cursor`. Each folder gained `agents/openai.yaml` with `policy.allow_implicit_invocation: false` (the Codex form of manual-only). Source: diffs in tmp/pstack/pin-*.md. **verified**
19. Justin's brain note (2026-09-23) records the same: "47 Cursor pstack skills (2026-09-10, pinned b97db39, Cursor-specific paths unadapted)", open item "Prune or adapt the 47 pstack skills' Cursor-specific paths", and classifies `priority-brief`, `transcribe`, `obsidian-memory` as "personal" and `global-capability-selector` as built 2026-09-14/15. Source: oneezy/brain .research/state-of-everything-2026-09-23.md. **verified**
20. `~/.cursor/` has only `argv.json`, `extensions/`, `shouldUpdate`: no `rules/pstack-models.mdc`, no skills, no plugins. `config.toml` enables every skill except `obsidian-memory`. Folder mtimes are all 2026-09-23 14:09 (a bulk rewrite; content still equals b97db39). **verified**

### Folder -> origin table

| Folder(s) | Origin | Evidence |
|---|---|---|
| architect, arena, automate-me, blast-radius, bro, create-verification-skill, figure-it-out, how, interrogate, maintain-verification-skill, make-bot-ui, no-comments, poteto-mode, recall, reflect, setup-pstack, show-me-your-work, swarm, technical-writing, typescript-best-practices, unslop, why | pstack | body == cursor/plugins@b97db39 `pstack/skills/<same name>/SKILL.md` (fact 18) |
| pstack-tdd, pstack-teach | pstack | body == `pstack/skills/tdd`, `pstack/skills/teach` @b97db39; renamed by the 2026-09-10 Codex session (facts 17-18) |
| principle-attack-the-premise, -boundary-discipline, -build-the-lever, -encode-lessons-in-structure, -exhaust-the-design-space, -experience-first, -fix-root-causes, -foundational-thinking, -guard-the-context-window, -laziness-protocol, -make-operations-idempotent, -migrate-callers-then-delete-legacy-apis, -minimize-reader-load, -model-the-domain, -never-block-on-the-human, -outcome-oriented-execution, -prove-it-works, -redesign-from-first-principles, -separate-before-serializing-shared-state, -sequence-verifiable-units, -subtract-before-you-add, -test-behavior-not-implementation, -type-system-discipline (23) | pstack | all 23 exist in `pstack/skills/` at b97db39 and main; bodies identical (fact 18) |
| ask-matt, code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-with-docs, grilling, handoff, implement, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, setup-matt-pocock-skills, tdd, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wayfinder, wizard, writing-for-agents (25) | mattpocock | 24 of the 25 names are in mattpocock/skills at `main` (37 SKILL.md); `resolving-merge-conflicts` exists only at the pinned `5b15a47` (`skills/engineering/resolving-merge-conflicts/SKILL.md`), not at `main` (skeptic pass); same names pinned to `mattpocock/skills` in this repo's skills-lock.json; brain note "25 global pinned 5b15a47"; not in pstack. Bodies not diffed against upstream (**inferred** by name + lock + brain) |
| priority-brief | justin | description "Answer Justin's daily-status questions ... Trello Inbox and Work, Google Calendar, Gmail"; brain: personal, used by Codex automation `daily-brief`; GitHub code search finds the name only in oneezy/brain (**inferred**, strong) |
| obsidian-memory | justin | hard-codes `C:\Users\Justin\Obsidian`; ships `scripts/closeout-hook.ps1`; disabled in config.toml; brain: "dropped (disabled 2026-09-23)" (**inferred**, strong) |
| global-capability-selector | justin | V:/dev/ai-workflow/docs/global-capability-selector.md "Built September 14, 2026 ... maintained project copy"; brain line 827; only public hit is oneezy/brain; not in pstack or mattpocock (**verified** ownership doc) |
| transcribe | not pstack: openai/skills `skills/.curated/transcribe` | folder exists in openai/skills .curated listing; SKILL.md says "User-scoped skills install under `$CODEX_HOME/skills`"; Apache-2.0 LICENSE.txt identical to `.system/skill-installer/LICENSE.txt`; openai.yaml with icon assets (**inferred**, not diffed) |

## Open questions

- Which source to pin: `cursor/plugins` (canonical, 0.15.5, defaults now Opus 5.5 / Grok 4.7, Cursor-only paths) or `backnotprop/pstack` (harness-neutral, MIT, 50 skills on skills.sh, last push 2026-09-14, lags #366/#414/#422)? Or pin `cursor/plugins@b97db39` to match what is installed?
- (Resolved, skeptic pass) skills.sh's 50 for backnotprop/pstack = 47 in `skills/` + 3 benny automation skills under `automations/benny/skills/` (fact 10). A plain `npx skills add backnotprop/pstack` therefore lists 50; a pstack pin should exclude the three benny ones.
- `npx skills add cursor/plugins` exposes 99 skills from 20+ plugins; does skills-sync want `--skill` lists or per-skill tree URLs, and does the lock's `computedHash` cover only `pstack/skills/<name>/`?
- The CLI dedups same names first-seen-wins and has no rename option (not searched). How should `tdd`/`teach` from pstack coexist with mattpocock's `tdd`/`teach` under skills-sync? The local `pstack-` prefix is a one-off Codex edit.
- Keep or drop the Cursor-only skills (`setup-pstack`, `make-bot-ui`, `automate-me` needing Cursor's `create-skill`, `cursor-team-kit` references) when syncing to Claude Code and Codex?
- Whether to preserve the local frontmatter normalization (`disable-model-invocation` -> `agents/openai.yaml allow_implicit_invocation:false`) on reinstall; a fresh `npx skills add` would restore upstream frontmatter.

## Blockers

- None for the research. Risk to note: the CLI finds `pstack/skills/*` only through its depth-5 fallback (it ignores `.cursor-plugin/`); a future CLI that treats any matched container as terminal, or a `skills/`, `.github/skills/`, `.agents/skills/` or other `AGENT_PROJECT_SKILL_DIRS` entry appearing at the cursor/plugins root (today `.github/` holds only `workflows/`), would hide pstack from a plain `npx skills add cursor/plugins`. `cursor/plugins` is not in the CLI's blob-install allowlist (`BLOB_ALLOWED_OWNERS` = vercel, vercel-labs, heygen-com, remotion-dev; `BLOB_ALLOWED_REPOS` = zapier/connectors), so it takes the clone + `discoverSkills` path described in fact 14.

## Raw notes

- `gh api repos/cursor/plugins` -> default_branch main, stars 9171, pushed 2026-09-30T18:08Z, license null. `gh api repos/cursor/plugins/license` -> 404.
- Root dirs: .cursor-plugin, .github, advisor, agent-compatibility, cli-for-agent, continual-learning, create-plugin, cursor-sdk, cursor-team-kit, docs-canvas, dyl-stack, grok-voice, orchestrate, pr-review-canvas, pstack, ralph-loop, schemas, scripts, teaching, thermos, third_party.
- Diff method: `awk` strips YAML frontmatter, `sed 's/\r$//'` strips CR; 47/47 bodies identical to b97db39; the earlier whole-file diff showed 100% change only because of CRLF + frontmatter.
- Local `~/.codex/skills/*/agents/openai.yaml` samples: arena -> `policy: allow_implicit_invocation: false`; ask-matt -> interface display_name "Ask Matt" + false; obsidian-memory -> true; transcribe -> icons + default_prompt. mattpocock upstream skill dirs also contain an `agents/` dir, so Matt's openai.yaml files may be upstream, pstack's are local additions.
- 2026-09-10 session also referenced `api.github.com/repos/cursor/plugins/git/trees/` and `.../commits/main` (how it resolved the ref).
- The skills CLI walk: `prioritySearchDirs = [root, skills/, skills/.curated, skills/.experimental, skills/.system, ...AGENT_PROJECT_SKILL_DIRS] + getPluginSkillPaths()`; root walked at maxDepth 1, containers at 3; fallback `findSkillDirs(root, 0, 5)` when nothing found or `--full-depth`.
- Skills.sh backnotprop page and cursor/plugins page fetched 2026-09-30; counts are as displayed that day.

## Skeptic pass

Date 2026-09-30. Five decision-bearing claims re-fetched from their primary sources; scratch at C:/Users/Justin/.claude/jobs/432033f7/tmp/pstack-skeptic/.

| # | Claim | Holds | Check |
|---|---|---|---|
| 1 | Facts 1, 3: canonical `cursor/plugins` `pstack/.cursor-plugin/plugin.json` = version 0.15.5, author Lauren Tan, MIT; `pstack/LICENSE` = MIT (c) 2026 Lauren Tan; repo-level license null, default `main` | true | `gh api repos/cursor/plugins/contents/pstack/.cursor-plugin/plugin.json`, `.../contents/pstack/LICENSE`, `gh api repos/cursor/plugins` (license null, pushed 2026-09-30T18:08Z), `/license` 404 |
| 2 | Fact 4: 47 skill dirs in `pstack/skills/` at `main`, same 47 at `b97db39` | true | `gh api contents/pstack/skills` at both refs; sorted lists identical |
| 3 | Fact 9: `backnotprop/pstack` is a non-fork MIT mirror, `main` + `upstream` branches, same 47 `skills/` dirs, last push 2026-09-14T15:57Z | true | `gh api repos/backnotprop/pstack` (fork false, license MIT, 730 stars), README mirror banner, MIRROR.md, `/branches` = main, upstream. Side finding: recursive tree has 3 more SKILL.md under `automations/benny/skills/`, which explains skills.sh's 50 (fact 10 and Open questions updated) |
| 4 | Fact 14: skills CLI 1.7.0 reads only `.claude-plugin/{marketplace,plugin}.json`; priority containers root/`skills/`/`.curated`/`.experimental`/`.system`/agent dirs; fallback `findSkillDirs` maxDepth 5 when nothing found | true | cached `dist/cli.mjs` (package.json version 1.7.0): `.claude-plugin` at lines 1048-1083, no `cursor-plugin` string; `prioritySearchDirs` 1339-1348; `findSkillDirs(dir, 0, 5)` 1284; fallback 1371-1380. `.github/skills` is a priority dir but cursor/plugins `.github/` holds only `workflows/`. Blockers section extended with the blob allowlist |
| 5 | Fact 16 and origin table: pstack/mattpocock name overlap is exactly `tdd`, `teach`; 25 local folders are mattpocock names | true, one correction | `comm` of the 47 pstack dirs against 37 SKILL.md basenames in `mattpocock/skills@main` -> `tdd`, `teach`. `resolving-merge-conflicts` is absent at `main` but present at `5b15a47`; origin table row corrected |
| (spot) | Fact 18: local bodies byte-identical to b97db39 | true (7/47 sampled) | arena, unslop, setup-pstack, principle-prove-it-works, make-bot-ui, pstack-tdd, pstack-teach: frontmatter stripped, CR stripped, `cmp` identical |

Corrections applied: origin-table mattpocock row (`resolving-merge-conflicts` only at the pin), fact 10 and the matching open question (50 = 47 + 3 benny), fact 9 star count, Blockers (agent-dir containers and blob allowlist). No refuted claims.
