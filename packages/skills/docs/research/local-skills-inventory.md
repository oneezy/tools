---
title: Local skills inventory (every skill folder on this machine outside the library)
date: 2026-09-30
sources:
  - C:/Users/Justin/.claude/skills (and skills/synced), C:/Users/Justin/.agents/skills, C:/Users/Justin/.codex/skills
  - C:/Users/Justin/.codex/config.toml, C:/Users/Justin/.claude/skills-sync.json
  - V:/dev/skills (main checkout, branch dev): skills-sync.json, .agents/skills, .claude/skills, .agents/skills/.gitignore
  - V:/dev/skills/.claude/worktrees/skills-skills: skills/, skills-lock.json, .gitignore, .legacy/
  - V:/dev/tridentcubed, V:/dev/brain, V:/dev/brain-invoice-status-transition, V:/dev/wake-plate, V:/dev/tools, V:/dev/advancedfamilydental, V:/dev/ai-workflow
  - https://github.com/mattpocock/skills (git tree at HEAD, pushed 2026-09-29; .changeset/remove-resolving-merge-conflicts.md)
  - https://github.com/backnotprop/pstack (git tree at HEAD, pushed 2026-09-14; skills/architect/SKILL.md, skills/tdd/SKILL.md)
---

# Local skills inventory

## Summary

Claude Code and `~/.agents` hold only junctions into the main checkout `V:\dev\skills` (37 Matt Pocock + 6 own) plus Anthropic's `synced` bucket; one junction is broken (`find-skills`). Codex holds 76 real skill folders: 25 Matt Pocock, 47 pstack (`backnotprop/pstack`, two renamed `pstack-tdd`/`pstack-teach`), 2 of Justin's own (`obsidian-memory`, `priority-brief`), 2 of unknown origin (`global-capability-selector`, `transcribe`). Trident (`V:\dev\tridentcubed`) has two Trident-only skills (`oneezy-app-route`, `oneezy-ui-component`) plus stale copies of `oneezy-merge`/`oneezy-status`. `ai-workflow` has two untracked OpenAI "Sites" skills. The lock is stale against upstream: `resolving-merge-conflicts` was removed upstream and three lock paths moved from `in-progress/` to `engineering/`.

## Facts

| # | Claim | Source | Confidence |
|---|-------|--------|------------|
| 1 | `~/.claude/skills` has 45 entries: 43 junctions, `find-skills` (junction), `synced` (real dir). 37 junctions target `V:\dev\skills\.agents\skills\<n>`, 6 target `V:\dev\skills\skills\oneezy-*`. | `Get-ChildItem -Force C:/Users/Justin/.claude/skills` | verified |
| 2 | `~/.claude/skills/find-skills` is a junction to `C:\Users\Justin\.agents\skills\find-skills`, which does not exist. Only broken link found. Codex chat titles dated 2026-09-22 (`find-skills-c-users-justin-agents`) show it once existed. | `Test-Path` on target; `C:/Users/Justin/.codex/config.toml` `[projects...]` keys | verified |
| 3 | `~/.agents/skills` has 44 entries: the same 43 junctions (no `find-skills`) plus `synced` (real dir). All targets resolve and hold `SKILL.md`. | `Get-ChildItem -Force C:/Users/Justin/.agents/skills` + `Test-Path` per target | verified |
| 4 | All junctions point at the main checkout `V:\dev\skills` (branch `dev`), never at a worktree. `V:\dev\skills\.agents\skills` holds 37 real Matt Pocock dirs + 6 junctions to `skills/oneezy-*`; `.claude/skills` there is junctions only. | junction targets; `git -C V:/dev/skills branch --show-current` | verified |
| 5 | `synced` bucket `4cb2428b-..._88ee0a8c-...` under `~/.claude/skills/synced` holds: `docs, docx, google-workspace, import-memory, morning, pdf, pptx, skill-creator, xlsx` + `.staging/`, `manifest.json`, `.last-complete-round`. The `~/.agents/skills/synced` copy lacks `google-workspace` and `.staging`. | listing of both bucket dirs | verified |
| 6 | `~/.codex/skills`: 77 entries, all real dirs (no links): 76 skills + `.system` (Codex-managed: `imagegen, openai-docs, review-agent, skill-creator, skill-installer`, `.codex-system-skills.marker`). | `Get-ChildItem -Force C:/Users/Justin/.codex/skills` | verified |
| 7 | 25 Codex folders are Matt Pocock skills (names in `skills-lock.json`; `agents/openai.yaml` carries an `interface.display_name`). 16 have byte-identical `SKILL.md` to the library working set; 8 differ (`ask-matt, diagnosing-bugs, domain-modeling, improve-codebase-architecture, setup-matt-pocock-skills, tdd, triage, wait-what`); `resolving-merge-conflicts` exists only in Codex. | `Get-FileHash` compare vs `V:/dev/skills/.agents/skills/<n>/SKILL.md` | verified |
| 8 | 47 Codex folders are pstack: every `skills/<n>/SKILL.md` in `backnotprop/pstack` HEAD has a local folder; upstream `skills/tdd` and `skills/teach` are local `pstack-tdd`/`pstack-teach` (renamed to avoid Matt's `tdd`/`teach`). | `gh api repos/backnotprop/pstack/git/trees/HEAD?recursive=1`; local dir names | verified |
| 9 | Codex pstack copies are upstream bodies with rewritten frontmatter: description reflowed, `disable-model-invocation: true` dropped and expressed as `agents/openai.yaml` `policy.allow_implicit_invocation: false`, CRLF line endings. Only `unslop` matches upstream blob after LF normalization. | `git diff --ignore-cr-at-eol` of `architect` and `tdd` vs upstream contents API; blob-sha table | verified (2 sampled diffs; rest inferred from sha mismatch) |
| 10 | `obsidian-memory` and `priority-brief` are Justin-specific Codex skills (descriptions name Justin, his Obsidian vault, his Trello/Calendar/Gmail). `obsidian-memory` is `enabled = false` in `config.toml`; every other `[[skills.config]]` entry is enabled. | `SKILL.md` heads; `C:/Users/Justin/.codex/config.toml` | verified |
| 11 | `transcribe` (Apache-2.0 `LICENSE.txt`, "Transcribe audio using OpenAI", bundled `transcribe_diarize.py`) and `global-capability-selector` (Codex desktop helper with `scripts/selector.py`, `tests/`) are neither Matt nor pstack; origin not established. | folder contents | unknown |
| 12 | Trident is `V:\dev\tridentcubed` (remote `layerdbiz/tridentcubed`, branch `dev`, has `skills-lock.json`, no root `skills/`). `.claude/skills` = 38 junctions into `.agents/skills` + 4 real dirs: `oneezy-app-route`, `oneezy-ui-component`, `oneezy-merge`, `oneezy-status`. `.agents/skills` = 42 real dirs (same 4 + 38 Matt incl. `resolving-merge-conflicts`). | listing; `git ls-files`; `git remote get-url origin` | verified |
| 13 | `oneezy-app-route` (102 lines, 90 non-blank, "Author a new route, feature module or app-only component in apps/app or apps/site, with remote functions as the data layer") and `oneezy-ui-component` (101 lines, 90 non-blank, "Author a new @layerd/ui component in packages/ui") are tracked in git under `.claude/skills/` only; the `.agents/skills/` copies are untracked (`??`). Not in the library. | `git -C V:/dev/tridentcubed ls-files --error-unmatch`; `git status --porcelain` | verified |
| 14 | Trident's `oneezy-merge` is an older revision (24-line diff: no release mode, no "Not this skill"); its `oneezy-status/STATUS.md` differs by 1 line. Both tracked in git under `.agents/skills` and `.claude/skills`. | `git diff --no-index --stat` vs `V:/dev/skills/skills/<n>` | verified |
| 15 | `brain`, `brain-invoice-status-transition` (both `oneezy/brain`), `wake-plate`, `tools` commit real copies of the whole skill set in both `.claude/skills` and `.agents/skills` (114-115 tracked files each). Their `oneezy-brain` (missing `scripts/brain.py`, 62 lines), `oneezy-estimate` (1 line), `oneezy-merge` (24 lines) lag the library; `oneezy-status` and `oneezy-remote` match. `wake-plate` has no `skills-lock.json`. | `git ls-files` counts; `git diff --no-index --stat` | verified |
| 16 | `advancedfamilydental` has `.claude/skills` junctions -> its own `.agents/skills` (38 Matt real dirs incl. `resolving-merge-conflicts`); no `oneezy-*` skills. | listing | verified |
| 17 | `ai-workflow` (`oneezy/ai-workflow`, branch `main`) has `skills/sites-building` and `skills/sites-hosting`, untracked (`git ls-files skills` empty), OpenAI "Sites" skills (`.openai/hosting.json`, `open_in_codex`, `codex-preview`). Not in the library. | listing; `SKILL.md` heads; `git ls-files` | verified |
| 18 | `.legacy/` in the library (`domain-name-maker, saas-starter, step-by-step, stormy, what-the-func`) holds prompt-era files (`prompt.txt`, `data/`, images); none has a `SKILL.md`, so none is a skill. | listing | verified |
| 19 | `skills-lock.json` has 38 entries, all `mattpocock/skills`. Upstream HEAD (pushed 2026-09-29) has 37 `skills/**/SKILL.md`. Lock paths stale: `implement-spec`, `pr`, `retro` now live under `skills/engineering/` (lock says `skills/in-progress/`); `skills/engineering/resolving-merge-conflicts/SKILL.md` is gone. Upstream changeset: "Remove the `resolving-merge-conflicts` skill... nothing replaces it". | `gh api repos/mattpocock/skills/git/trees/HEAD?recursive=1`; `.changeset/remove-resolving-merge-conflicts.md`; lock file | verified |
| 20 | All 37 Matt skills in the library working set match upstream HEAD `SKILL.md` blob sha after LF normalization. Upstream has no skill absent from the lock. | LF-normalized `git hash-object` vs tree sha | verified |
| 21 | `V:/dev/skills/skills-sync.json`: `agents: [claude-code, codex]`, `mode: link`, `global: true`, `unavailable: [resolving-merge-conflicts]`, `dev` points at a tools worktree. `~/.claude/skills-sync.json`: `agents: [claude-code, codex, hermes]`, `dev` points at `C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\fresh`. Despite `codex` being listed, `~/.codex/skills` holds no links. | both files; Codex listing | verified |
| 22 | `~/.config/goose/skills`, `~/.hermes/skills`, `~/.cursor/skills` do not exist. `~/.agents` root holds only `skills/`; no lock file at home level. | `Test-Path`; listing | verified |
| 23 | Library `.gitignore` ignores `.agents/skills/`, `.claude/skills/`, `.goose/`, `.hermes/`, `skills-sync.json`, `.claude/worktrees/`; `.agents/skills/.gitignore` (generated) ignores the six `oneezy-*` junctions. | both files | verified |

## Open questions

1. Where did `global-capability-selector` and `transcribe` come from (Codex skill-installer catalog, openai/skills, or hand-written)? No lock, README or license names a source except `transcribe`'s Apache-2.0 text.
2. Why does `~/.codex/skills` hold real folders when both `skills-sync.json` files list `codex` in `agents` with `mode: link`? Did skills-sync skip Codex because the folders pre-existed, or was Codex populated by another tool (frontmatter reflow + `agents/openai.yaml` suggests a converter)?
3. Should the 8 Codex Matt copies that differ from the library working set be diffed before deletion, in case any carries a local edit worth keeping?
4. Are `obsidian-memory` and `priority-brief` meant to become `oneezy-*` library skills (they are Justin's, but `priority-brief` overlaps `oneezy-brain`'s "what's on the agenda" triggers)?
5. Trident's `oneezy-app-route`/`oneezy-ui-component` are tracked under `.claude/skills` but not `.agents/skills`: which layer is Trident's source of truth today?
6. Does the new layout keep `resolving-merge-conflicts` (still shipped in Codex and four repos) or follow upstream's removal?

## Blockers

None for the inventory. For the migration: the lock must be re-pinned before `npx skills` can restore (three moved paths, one removed skill), or restores will keep reporting `resolving-merge-conflicts` unavailable.

## Raw notes

### Home skill directories

| Directory | Entries | Type | Notes |
|-----------|---------|------|-------|
| `C:/Users/Justin/.claude/skills` | 45 | 44 junctions + `synced` dir | 37 -> `V:\dev\skills\.agents\skills\<n>`, 6 -> `V:\dev\skills\skills\oneezy-*`, `find-skills` broken |
| `C:/Users/Justin/.agents/skills` | 44 | 43 junctions + `synced` dir | same targets, no `find-skills` |
| `C:/Users/Justin/.codex/skills` | 77 | all real dirs | 76 skills + `.system` |
| `C:/Users/Justin/.config/goose/skills` | - | missing | |
| `C:/Users/Justin/.hermes/skills` | - | missing | |
| `C:/Users/Justin/.cursor/skills` | - | missing | |

### Codex real folders by origin (76)

| Origin | Count | Names | Evidence |
|--------|-------|-------|----------|
| mattpocock/skills | 25 | ask-matt, code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-with-docs, grilling, handoff, implement, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, setup-matt-pocock-skills, tdd, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wayfinder, wizard, writing-for-agents | names in lock; `agents/openai.yaml` has `interface.display_name`; 16/24 byte-identical to library working set |
| backnotprop/pstack | 47 | architect, arena, automate-me, blast-radius, bro, create-verification-skill, figure-it-out, how, interrogate, maintain-verification-skill, make-bot-ui, no-comments, poteto-mode, principle-* (23), pstack-tdd, pstack-teach, recall, reflect, setup-pstack, show-me-your-work, swarm, technical-writing, typescript-best-practices, unslop, why | 1:1 with upstream `skills/` tree; bodies reference `~/.cursor/rules/pstack-models.mdc` and `poteto-mode`; `metadata.cursor` blocks |
| Justin's own (Codex-only) | 2 | obsidian-memory (disabled), priority-brief | descriptions name Justin's vault / Trello / Calendar / Gmail |
| Unknown / other | 2 | global-capability-selector, transcribe | Codex desktop helper; Apache-2.0 OpenAI transcription CLI |
| Codex system | - | `.system/` (imagegen, openai-docs, review-agent, skill-creator, skill-installer) | marker file `.codex-system-skills.marker` |

Matt skills in the lock with no Codex copy (13): claude-handoff, git-guardrails-claude-code, implement-spec, loop-me, migrate-to-shoehorn, pr, retro, scaffold-exercises, setup-pre-commit, setup-ts-deep-modules, writing-beats, writing-fragments, writing-shape. No `oneezy-*` skill exists in Codex.

### Repos under V:/dev with skill folders

| Repo | Remote / branch | Layout | Real non-library skills | Lock |
|------|-----------------|--------|-------------------------|------|
| `tridentcubed` | layerdbiz/tridentcubed, dev | `.claude/skills` junctions -> `.agents/skills` (real, tracked) | oneezy-app-route, oneezy-ui-component (tracked in `.claude/skills` only); stale oneezy-merge, oneezy-status | yes |
| `brain` | oneezy/brain, dev | real dirs in both layers, 115 tracked files each | stale oneezy-brain, oneezy-estimate, oneezy-merge | yes |
| `brain-invoice-status-transition` | oneezy/brain, task/brain-invoice-status-transition | same as brain | same | yes |
| `wake-plate` | oneezy/wake-plate, dev | real dirs in both layers | stale oneezy-brain, oneezy-estimate, oneezy-merge | no |
| `tools` | oneezy/tools, dev | `.claude/skills` mixed (17 real, rest junctions); `.agents/skills` real | stale oneezy-estimate, oneezy-merge | yes |
| `advancedfamilydental` | - | `.claude/skills` junctions -> `.agents/skills` real | none (Matt only) | - |
| `ai-workflow` | oneezy/ai-workflow, main | `skills/` (untracked) | sites-building, sites-hosting (OpenAI Sites) | no |
| `skills` (library) | oneezy/skills, dev | `skills/oneezy-*` real; `.agents/skills` restored; `.claude/skills` junctions | `.legacy/` (no SKILL.md) | yes |

`sheetari` has no skill folders. `V:/dev/trident` does not exist; Trident is `tridentcubed`.

### Candidates not in `skills/` or `skills-lock.json`

| Candidate | Where | Suggested home | Note |
|-----------|-------|----------------|------|
| 47 pstack skills | `~/.codex/skills` | `upstream/pstack` | pin from `backnotprop/pstack`; local copies are converted, so restore from upstream rather than copy |
| oneezy-app-route, oneezy-ui-component | `V:/dev/tridentcubed/.claude/skills` | `skills/trident` | ~100 lines each (90 non-blank); Trident-specific paths (`apps/app`, `packages/ui`) |
| obsidian-memory, priority-brief | `~/.codex/skills` | `skills/oneezy` (decide) | Justin-specific; priority-brief overlaps oneezy-brain triggers |
| global-capability-selector, transcribe | `~/.codex/skills` | decide | origin unknown |
| sites-building, sites-hosting | `V:/dev/ai-workflow/skills` | probably not (OpenAI Sites product skills) | untracked |
| resolving-merge-conflicts | Codex + 4 repos | drop or vendor | removed upstream 2026-09 |

### Broken links

| Link | Target | Status |
|------|--------|--------|
| `C:/Users/Justin/.claude/skills/find-skills` | `C:\Users\Justin\.agents\skills\find-skills` | target missing |

All other 86 junctions across `~/.claude/skills` and `~/.agents/skills` resolve to a folder holding `SKILL.md`.

### Lock vs upstream (mattpocock/skills HEAD, 2026-09-29)

| Lock entry | Lock path | Upstream now |
|------------|-----------|--------------|
| implement-spec | skills/in-progress/implement-spec | skills/engineering/implement-spec |
| pr | skills/in-progress/pr | skills/engineering/pr |
| retro | skills/in-progress/retro | skills/engineering/retro |
| resolving-merge-conflicts | skills/engineering/resolving-merge-conflicts | removed (`.changeset/remove-resolving-merge-conflicts.md`) |

Remaining 34 lock paths match upstream; all 37 working-set copies match upstream HEAD content.

## Skeptic pass

Five decision-bearing claims re-checked against their primary sources on 2026-09-30 (this worktree, read-only except this file).

| # | Claim | Re-checked against | Holds | Note |
|---|-------|--------------------|-------|------|
| 1 | `~/.claude/skills`: 45 entries, 44 junctions (37 -> `V:\dev\skills\.agents\skills`, 6 -> `skills/oneezy-*`, `find-skills` broken) + `synced`; `~/.agents/skills`: 44 (43 junctions + `synced`) | `Get-ChildItem -Force` + `Test-Path` on every junction target and its `SKILL.md` | yes | Exact. Every non-`find-skills` target resolves and holds `SKILL.md`. |
| 8 | 47 pstack folders in `~/.codex/skills`, 1:1 with upstream `skills/*/SKILL.md`, `tdd`/`teach` renamed `pstack-tdd`/`pstack-teach` | `gh api repos/backnotprop/pstack/git/trees/HEAD?recursive=1` (pushed 2026-09-14T15:57:11Z) vs local dir names | yes | 47 upstream, 47 matched, none missing. |
| 13 | Trident `oneezy-app-route`/`oneezy-ui-component` tracked under `.claude/skills` only; `.agents/skills` copies untracked | `git -C V:/dev/tridentcubed ls-files` + `status --porcelain`; `Get-Content` line counts; `Get-FileHash` | yes, one overstatement | Tracking claim exact. "90 lines" was a `Measure-Object -Line` count (skips blanks); files are 102 and 101 physical lines, identical in both layers, unchanged vs HEAD. Corrected in Facts and Candidates. |
| 19 | Lock has 38 `mattpocock/skills` entries; upstream HEAD has 37 `SKILL.md`; `implement-spec`, `pr`, `retro` moved `in-progress/` -> `engineering/`; `resolving-merge-conflicts` removed with changeset | `skills-lock.json`; `gh api repos/mattpocock/skills/git/trees/HEAD?recursive=1` (pushed 2026-09-29T12:38:37Z); `.changeset/remove-resolving-merge-conflicts.md` contents | yes | Exactly those three moves and one removal; the other 34 lock paths match; no upstream skill absent from the lock. Changeset text matches the quote. |
| 21 | `V:/dev/skills/skills-sync.json` (`claude-code, codex`, `link`, `global`, `unavailable: [resolving-merge-conflicts]`, `dev` -> tools worktree); `~/.claude/skills-sync.json` (`claude-code, codex, hermes`, `dev` -> `jobs/9f3eb07d/tmp/fresh`); `~/.codex/skills` has 0 links; main checkout on `dev` | both files read raw; reparse-point count on Codex dir; `git branch --show-current` | yes | Exact. The home file has no `unavailable` key (the note did not claim one). |

Not re-checked: claims 7, 9 (hash comparisons of Codex Matt/pstack copies), 15 (four repos' diffs), 20 (LF-normalized blob shas). They rest on the same tooling as 8 and 19 but were not re-run.
