---
title: "Hunt for the original /oneezy-meeting skill"
date: 2026-09-30
resolves: "oneezy/skills #13 (facts) — feeds #23 (decision)"
sources:
  - "C:/Users/Justin/.codex (skills/, sessions/, archived_sessions/, chats/, memories/, *.sqlite, config.toml)"
  - "C:/Users/Justin/.claude/projects/**/*.jsonl (Claude Code session logs)"
  - "C:/Users/Justin/{.agents,.cursor,.config,AppData/Roaming,AppData/Local,Documents,Desktop,Downloads,Google Drive}"
  - "V:/dev/* (skills, tools, brain, ai-workflow, sheetari, tridentcubed, wake-plate, advancedfamilydental)"
  - "V:/dev/tools/clis/task-manager-cli/.legacy/agile-meetings/{prompt.txt,prompt_old.txt,data/instructions-v2.md,data/meetings.json}"
  - "V:/dev/tools/docs/research/2026-09-21-legacy-task-manager-sources.md"
  - "gh: repo list oneezy; search code; gist list; issues on oneezy/skills #13 #23, oneezy/tools #8, oneezy/brain"
  - "https://learn.chatgpt.com/docs/environments/cloud-environments.md (Codex docs, mirrored in https://developers.openai.com/codex/codex-manual.md)"
  - "https://learn.chatgpt.com/docs/build-skills (skill locations)"
  - "https://help.openai.com/en/articles/20001066-skills-in-chatgpt (Skills in ChatGPT)"
  - "https://github.com/openai/codex (codex-rs/ext/skills/src/cloud_skill.rs, provider/executor.rs; code search)"
---

## Summary

The original `/oneezy-meeting` is not on this machine, in any `oneezy` repo, gist or issue, nor in any Codex or Claude session log, so it cannot be retrieved locally and its `SKILL.md` text is not recoverable verbatim from a log.
The only things found are references: the cloud path in Justin's own pasted text (2026-09-30), issues #13/#23 that quote it, tools #8 (future meeting skills), and a 2024 "Meeting Leader" custom-GPT prompt in `oneezy/tools` with a seven-item meeting menu that is a likely ancestor, not the skill.
Official Codex docs say repo skills are available in cloud tasks and local personal skills are not synced; the Codex source has a cloud skill catalog, but the literal `remote-skills` path is not in public code.
The skill lives in Justin's ChatGPT/Codex cloud account only. Export options are listed under Blockers; nothing is reconstructed.

## Facts

### This machine (all read-only scans; excludes `node_modules`, `.git`, Temp, Packages, Microsoft, site-packages)

1. No folder or file named `*meeting*` is a skill anywhere under `C:/Users/Justin` or `V:/dev`. All name hits are third-party or unrelated: Codex plugin caches (`.codex/.tmp/plugins/plugins/{zoom,notion,google-drive,google-calendar,outlook-calendar,superhuman,atlassian-rovo,chronograph-lp}/...`), `.codex/vendor_imports/skills/skills/.curated/notion-meeting-intelligence`, hermes `productivity/teams-meeting-pipeline`, WisprFlow app migrations, client notes under `Google Drive/Layerd/Clients/Trident Cubed/**/Meetings`, and the legacy `task-manager-cli/.legacy/agile-meetings` data (see 12). Source: `rg --files` and `find` over both roots. **verified**
2. No file contains the id `6abd4e4f25b08191acd8a13b62f68df6`, and `oneezy-meeting` appears only in this workflow's own files: `C:/Users/Justin/.claude/projects/V--dev-skills--claude-worktrees-skills-skills/432033f7-7798-417d-a1e8-92aed48bb675.jsonl` plus its `workflows/` and `subagents/` folder, and `C:/Users/Justin/.claude/jobs/432033f7/{state.json,timeline.jsonl}`. Source: `rg -l` over `.codex .claude .agents .cursor .config AppData/Roaming Documents Desktop Downloads "Google Drive" V:/dev` and the ChatGPT/Codex app folders `AppData/Local/OpenAI`, `AppData/Local/Programs/OpenAI`. **verified**
3. `C:/Users/Justin/.codex` has no `remote-skills` folder. Top-level folders: `.chatgpt-projects .sandbox .sandbox-bin .sandbox-secrets .tmp .vscode ambient-suggestions app-server-daemon archived_sessions attachments automations backups bin browser cache chats code-review-plugin computer-use cross-instance-locks dictation-history generated_images mcp-oauth-locks memories node_repl packages pets plans plugins process_manager project-metadata-locks rollout-migrations rules secrets sessions shell_snapshots skills sqlite thread-writer-locks tmp vendor_imports visualizations worktrees`. `skills/` holds 77 entries at the skeptic recount (76 visible folders plus `.system/`; the first pass counted 80) covering Matt Pocock's set, `pstack-*`, `principle-*`, none meeting-related; `config.toml` `[[skills.config]]` entries list no meeting skill. **verified**
4. `.codex/backups` (config tomls, `cli-migration-20260921`, `config-repair-2026-09-20_224130-0500_228774`, folder pilots), `.codex/attachments` (three ids, `pasted-text-attachments.json` empty), `.codex/.chatgpt-projects` (two projects, `.metadata/*.json` = `{"files":[],"version":1}`), `.codex/plugins/.remote-plugin-install-staging` (a `sites-*` bundle) and `.codex/vendor_imports/skills-curated-cache.json` contain nothing about the skill. **verified**
5. Codex session logs: 73 rollouts under `.codex/sessions/2026/{07..09}`, 47 under `archived_sessions`, and `chats/` have 0 hits for `oneezy-meeting` and 0 for the id. The single `remote-skills` hit (`sessions/2026/09/30/rollout-2026-09-30T05-23-27-01a0f1d7-312d-7b62-8e58-dedcac153c42.jsonl`) is the branch name `feature/brain-remote-skills`. Therefore the SKILL.md text is **not** recoverable from any log. **verified**
6. Codex SQLite stores (`thread_history_1.sqlite` 339 MB, `logs_2.sqlite`, `state_5.sqlite`, `queue_1.sqlite`, `memories_1.sqlite`, `goals_1.sqlite`, plus WAL files) have 0 string hits for `oneezy-meeting`, the id and `remote-skills`. `thread_history_1.sqlite.thread_items` has 58 rows matching "meeting skill"; every one is either the tools issue #8 title or the `/ask-matt ... starting with #8 (meeting skills)` conversation about meeting types and boundaries with `/wayfinder`. Source: read-only `sqlite3` query (`mode=ro&immutable=1`). **verified**
7. Codex memory (`.codex/memories/MEMORY.md:775`, `raw_memories.md:1564`, `memories_1.sqlite`) records only a preference: custom meeting skills "only complement" Matt's skills and must not interfere with `/wayfinder`. **verified**
8. Claude Code logs: the only session outside the current one matching `seven-choice|remote-skills|oneezy-meeting` is `.claude/projects/V--dev-tools--claude-worktrees-tools-issue-9-skills-sync/9f3eb07d-4e99-4f65-bfd0-d1a54174c83f.jsonl`, and its 14 hits are all the `feature/brain-remote-skills` branch; 0 hits for the other two terms. **verified**
9. Provenance of the cloud path: in the current session the line `Previously available source: /root/.codex/skills/remote-skills/skill-6abd4e4f25b08191acd8a13b62f68df6` first appears in a **user-role** message at `2026-09-30T21:55:17.866Z` (Justin's pasted plan, section "6. Preserve the meeting skill and validate"); every later occurrence is the workflow quoting it. No agent on this machine ever observed the path. **verified**
10. No zip/tar/7z named `*meeting*` or `*skill*` exists under either root except hermes curator backups (`AppData/Local/hermes/skills/.curator_backups/*/skills.tar.gz`), whose listings contain only `productivity/teams-meeting-pipeline/SKILL.md`. `Downloads/` holds no skill archive. **verified**
11. Windows Recent items include `AppData/Roaming/Microsoft/Windows/Recent/agile-meetings.lnk`, pointing at the legacy folder below. **verified**

### Ancestor material (not the skill)

12. `V:/dev/tools/clis/task-manager-cli/.legacy/agile-meetings/` (also byte-identical `data/` under `agile-dev/` and `agile-story-mapping/`; nine worktree copies under `V:/dev/tools/.claude/worktrees/*`): `prompt_old.txt` (2025-01-29) and `data/instructions-v2.md` (2024-03-09) are a ChatGPT custom-GPT "Task Management System and Meeting Leader" prompt whose opening menu lists exactly seven meetings: `/standup /backlog /sprint /review /retro /quarterly /yearly`, waits for the choice (`/meeting` re-shows the menu), and reads `meetings.json`, `team.json`, `tasks.json`. `prompt.txt` ("Roy", cowboy scrum master) adds `/help`, `/meetings`, `/release`. These are GPT prompts, not `SKILL.md` skills, and carry no metadata, assets or references folders. Catalogued in `V:/dev/tools/docs/research/2026-09-21-legacy-task-manager-sources.md` (lines 9, 41, 47, 147-164). **verified**
13. The seven-item menu matches the "seven-choice menu" Justin attributes to `/oneezy-meeting`, so the skill probably descends from this prompt. **inferred** (no file links the two)
14. Only `oneezy/tools` `git log --all -S` has any meeting history (commit `0a79c74 init`, the legacy files above); `oneezy/skills`, `brain`, `ai-workflow`, `sheetari`, `tridentcubed`, `wake-plate`, `advancedfamilydental` have none for `oneezy-meeting` or the id. **verified**

### GitHub

15. `gh repo list oneezy --limit 200` returns 105 repos; none is meeting-related. `gh search code "oneezy-meeting" --owner oneezy`: 0. `gh search code "meeting" --owner oneezy --filename SKILL.md`: only Matt's `to-questionnaire/SKILL.md` copies. `gh search code` for the id (with and without `--owner`): 0. `gh gist list`: none. `gh issue list -R oneezy/brain --search meeting --state all`: `[]`. **verified**
16. `oneezy/skills` #13 "Facts: the original oneezy-meeting and the local skills inventory" (open, `wayfinder:research`, 0 comments) and #23 "Decide whether oneezy-meeting can be included" (open, `wayfinder:grilling`, 0 comments) both describe the skill only by Justin's summary (seven-choice menu, selection wait, templates/references, metadata, assets; Codex cloud path). **verified**
17. `oneezy/tools` #8 "Meeting skills: which meetings, inputs, outputs, rules" (open, `wayfinder:grilling`, assigned oneezy, estimate 5, "up to six meeting types") is the design ticket for future meeting skills and does not reference the original. **verified**

### Official docs and Codex source

18. Codex cloud environments doc: "Skills stored in your repository are available in cloud tasks. Personal skills from your local computer aren't synced to cloud environments." Source: https://learn.chatgpt.com/docs/environments/cloud-environments.md (line 394; same text in `codex-manual.md` line 18604). **verified**
19. Codex skill locations: `$CWD/.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills`, plus bundled system skills; "In the ChatGPT desktop app, open **Skills** in the sidebar". Source: https://learn.chatgpt.com/docs/build-skills. No mention of `remote-skills`, cloud paths, or exporting. **verified**
20. Skills in ChatGPT: sidebar **Plugins** > **Plugin Directory** > **Skills** tab shows **Installed**, **Created by me**, **Shared with me**, **Shared by {workspace}**; create via **Create** > **Create with chat** / **Create with editor** / **Upload from your computer**; share via the more-options menu > **Share** (link or people). A **Download** action is documented only on the admin **Skills** page (Enterprise/Edu): "Select the more options menu, then select Download to download a skill." Uploads accept skill files that are scanned before use. The same article scopes the feature: "Skills are available to eligible ChatGPT Business, Enterprise, Healthcare, and Edu users, subject to workspace settings", so whether Justin's account shows the **Skills** tab at all depends on his plan (not checked). Source: https://help.openai.com/en/articles/20001066-skills-in-chatgpt. **verified**
21. Codex CLI 0.146.0 release notes list "executor-provided skills". `openai/codex` main (pushed 2026-09-30) has `codex-rs/ext/skills/src/cloud_skill.rs` (turn-start cloud catalog refresh, `include_cloud_skills: true`, warning "Cloud skill discovery failed; retaining any catalog from the same cloud auth scope") and `provider/executor.rs`. GitHub code search for `remote-skills` / `remote_skills` in `openai/codex` returns 0 (re-run by the skeptic; `cloud_skill` 31, `include_cloud_skills` 8, so the index does cover the file). A zero result from the search API is weak evidence: it indexes only the default branch and tokenizes hyphenated terms, so it shows the literal path is **not confirmed** by public source, not that it is absent. The path may be composed at runtime by the cloud sandbox rather than appear as a string literal. Sources: `codex-manual.md` line 1311; `gh api search/code`; raw file fetch. **verified** (path semantics **unknown**)
22. Implication: a skill created in ChatGPT is stored in the account's cloud skill store and mounted into cloud sandboxes at the path Justin saw; nothing about that mechanism writes to a local machine, which is consistent with the empty local scan. **inferred**

## Open questions

- Does the personal **Skills** page (**Created by me** > more-options menu) offer **Download** for a non-admin account? The help article documents Download only on the admin page (fact 20).
- Is `/root/.codex/skills/remote-skills/skill-6abd4e4f25b08191acd8a13b62f68df6` still present in a fresh Codex cloud task, and is that mount the same as the "cloud skill catalog" in `cloud_skill.rs`?
- Which ChatGPT surface created the skill and when (fact 4 shows a same-id-family project `g-p-6abc1b82...` synced 2026-09-29)?
- Is the seven-choice menu the legacy `/standup /backlog /sprint /review /retro /quarterly /yearly` list (fact 13)?
- Is Justin's ChatGPT plan one the help article lists as skill-eligible (Business, Enterprise, Healthcare, Edu)? If not, export step 2 has no UI to use and step 1 (cloud task copy) is the only route.

## Blockers

- The original cannot be added from this machine, any `oneezy` repo, gist, issue or log. Retrieval needs Justin's own ChatGPT/Codex cloud account. Until then the library carries nothing for `oneezy-meeting` (no reconstruction).
- Export steps Justin must take, most faithful first:
  1. **Cloud copy (byte-exact, includes assets):** in ChatGPT > Codex, start a cloud task in the `oneezy/skills` environment with: `find /root/.codex/skills -maxdepth 2` then `cp -r /root/.codex/skills/remote-skills/skill-6abd4e4f25b08191acd8a13b62f68df6 skills/oneezy-meeting` on a branch off `dev` and open a PR. If `remote-skills` is absent, report the `find` output.
  2. **ChatGPT UI:** sidebar **Plugins** > **Plugin Directory** > **Skills** > **Created by me** > the skill > more-options menu; use **Download** if present (admin page always has it), else **Create with editor** view and copy every file (`SKILL.md`, `agents/openai.yaml`, `references/`, `templates/`, `assets/`) verbatim.
  3. Deliver the folder (zip or PR) so an agent can place it at `skills/oneezy-meeting/` and check the seven-choice menu, the selection wait and each referenced file before merging into `dev`.

## Raw notes

- Filename scans: `rg --files -uu -g '*meeting*' -g '*6abd4e4f25b08191*'` and `find -type d -iname '*meeting*'` over `C:/Users/Justin` and `V:/dev`; archive scan with `-g '*meeting*.zip' -g '*skill*.tar*'` etc.
- Content scans: `rg -l -i -uu -e oneezy-meeting -e 6abd4e4f25b08191acd8a13b62f68df6` per root; `grep -a -c` over each `.codex/*.sqlite*` and json; Python `sqlite3` read-only `LIKE` query over `thread_items`, `thread_turns`, `thread_realtime_items`.
- Session-log provenance: Python parse of the parent session jsonl, printing role/timestamp of every line containing the id (4 lines: 1 queue-operation, 2 user, 1 assistant `Workflow` tool_use).
- `gh issue view 13|23 -R oneezy/skills --json body,comments`; `gh issue view 8 -R oneezy/tools --comments`; `gh issue list -R oneezy/tools --search meeting`.
- Docs fetched with curl (help.openai.com blocks WebFetch with 403); `developers.openai.com/codex/skills` 308-redirects to `learn.chatgpt.com/docs/build-skills`; `learn.chatgpt.com/docs/cloud.md` has no skills text.
- Temp files: `C:/Users/Justin/.claude/jobs/432033f7/tmp/oneezy-meeting-hunt/` (`q.py`, `ctx.py`, `who.py`, fetched `*.md`/`*.html`, `cloud_skill.rs`, `executor.rs`).

## Skeptic pass

Five load-bearing claims re-checked against their primary sources on 2026-09-30 (temp files in `C:/Users/Justin/.claude/jobs/432033f7/tmp/oneezy-meeting-hunt-skeptic/`):

- Fact 18 (repo skills in cloud, personal skills not synced): re-fetched `https://learn.chatgpt.com/docs/environments/cloud-environments.md`; the sentence is at line 394 verbatim, and `codex-manual.md` line 18604 mirrors it. **Holds.**
- Fact 20 (ChatGPT Skills UI, Download only documented on the admin page): re-fetched the help article with a browser user agent (plain curl gets a bot-check page); the only "Download" occurrence is under "From the admin Skills page, admins can". **Holds**, with the plan-eligibility sentence added above.
- Fact 21 (`remote-skills` not in `openai/codex`, `cloud_skill.rs` exists): `gh api search/code` re-run gives 0 for both spellings; `cloud_skill.rs` (68 lines) and `provider/executor.rs` (367 lines) re-fetched from `main`, the warning string is at `cloud_skill.rs:62` and `include_cloud_skills: true` at line 50; release notes for 0.146.0 name "executor-provided skills" at `codex-manual.md:1311`. **Holds but was overstated**: zero search hits do not prove the path is absent from source; wording softened.
- Fact 12 (legacy seven-meeting menu): re-read `prompt_old.txt` lines 28-39 and `data/instructions-v2.md` lines 28-39; both list exactly `/standup /backlog /sprint /review /retro /quarterly /yearly` and the `/meeting` re-prompt; `prompt.txt` ("Roy") lists ten numbered items adding `/help`, `/meetings`, `/release`. mtimes 2025-01-29 / 2024-03-09 as stated. **Holds.**
- Fact 9 (cloud path provenance): parsed the parent session jsonl; the id appears on four lines (queue-operation 21:55:17.772Z, two user-role lines 21:55:17.866Z, one assistant `tool_use` 22:24:00.939Z with no "Previously available source" phrase). The two orphaned jsonl copies have no hits. **Holds.**
- Fact 3 (local `.codex` layout) checked in passing: no `remote-skills` folder and no `*meet*` skill; folder count corrected from 80 to 77.
