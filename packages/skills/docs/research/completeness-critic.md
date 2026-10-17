---
title: "Completeness critic: what decisions A-F can and cannot rest on after the eight research notes"
date: 2026-09-30
sources:
  - V:/dev/skills/.claude/worktrees/skills-skills/docs/research/{skills-cli,claude-code-plugins,codex-plugins,pstack,writing-for-agents-pin,oneezy-meeting-hunt,skills-sync-baseline,local-skills-inventory}.md (all eight, read in full)
  - gh issue view 15..24 -R oneezy/skills (decision tickets; A=#15/#21, sources=#16/#24, B=#19, C=#17/#18, D=#20, E=#22, F=#23)
  - git -C V:/dev/tools show feature/skills-sync-plugins:clis/skills-sync/src/{cli.ts,library.ts,fs.ts} (1a7f859, content == PR #69 head dd3c151)
  - C:/Users/Justin/.claude/jobs/432033f7/tmp/skills-cli/upstream (vercel-labs/skills @3694740) src/skills.ts L253-330, src/plugin-manifest.ts L1-140
  - C:/Users/Justin/.claude/jobs/432033f7/tmp/claude-code-plugins-skeptic/skills.md L370-412 (frontmatter table, "Using skill frontmatter outside Claude Code")
  - https://agentskills.io/specification (frontmatter table, `metadata`, `name`)
  - https://raw.githubusercontent.com/openai/codex/main/codex-rs/core-plugins/src/marketplace.rs L20-25
  - https://docs.npmjs.com/cli/v11/commands/npm-install (git and tarball forms)
  - https://docs.github.com/en/actions/concepts/security/github_token and .../how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow ("When GITHUB_TOKEN triggers workflow runs")
  - Local: `codex --help`, `codex cloud exec --help`, `codex plugin list --json`, `codex debug prompt-input`, C:/Users/Justin/.codex/automations/daily-brief/automation.toml, C:/Users/Justin/.codex/plugins/cache/openai-curated-remote/plugin-creator/0.1.22/, V:/dev/tools (no root package.json), this worktree's README.md, .gitignore, skills/, skills-lock.json, C:/Users/Justin/.claude/CLAUDE.md
---

# Completeness critic

## Summary

The eight notes settle the mechanics of every tool involved (vercel `skills` CLI, skills-sync 0.1.0 vs 0.2.0, Claude Code plugins/marketplaces, Codex plugins/marketplaces, ChatGPT Plugin Creator, PStack's home, the writing-for-agents pin, the local inventory, and the missing oneezy-meeting).
Four facts the notes did not state were added here: skills-sync 0.2.0 has no add/update/refresh/build and reads only one level under `skills/`; a root `.claude-plugin/marketplace.json` with `./plugins/<x>` sources makes the vercel CLI scan `plugins/<x>/skills` too (duplicate-name risk); the Agent Skills spec limits `metadata` to string values and requires `name` == directory; GitHub does not re-trigger workflows on `GITHUB_TOKEN` pushes.
What still cannot be established from this machine: Justin's ChatGPT plan, whether Plugin Creator is reachable outside a chat, whether the cloud `remote-skills` path still exists (a `codex cloud exec` from here could answer it under Justin's login), and any policy call on branches other than `main`.
Decisions A-D are decidable now with the listed verification runs; E and F are decidable only as "Justin-only checklist" answers.

## Facts (added by this pass)

1. skills-sync 0.2.0 command set is `sync` (default), `status`, `unlink`, `projects`; there is no `add`, `update`, `refresh` or `build`. `--quiet` sets `yes = true` (`if (a.quiet) a.yes = true`). Any unknown `-` flag exits 2. Source: `git show feature/skills-sync-plugins:clis/skills-sync/src/cli.ts` L17-45, L83-118. **verified**
2. 0.2.0 `Library.ownSkills()` = `readdirSync(<root>/skills)` filtered by `isSkillDir` (a `SKILL.md` file directly inside), one level only; `skills/oneezy/<skill>` would be invisible until the CLI changes. Source: library.ts L23-29, fs.ts L81-87. **verified**
3. `oneezy/tools` has no root `package.json` or workspace file (`clis/skills-sync/package.json` only); npm's git install forms (`github:owner/repo#ref`, git URLs) carry no subdirectory syntax; a `https://` tarball URL is installable and a `prepare` script runs for git deps. So `npx github:oneezy/tools#<ref>` cannot resolve the CLI; a packed tarball on a GitHub release (or npm publish) can. Source: `ls V:/dev/tools`; npm docs. **verified** (absence of subdir syntax is the docs' silence: **inferred**)
4. vercel `skills` discovery (same code at 1.7.0 and HEAD): after the root and the `skills/` container (depth 3), it reads `.claude-plugin/marketplace.json`; for every plugin whose `source` is a string starting `./` (object sources are skipped) it appends `<pluginRoot>/<source>/skills` (plus the parent dir of each explicit `skills` entry) as a depth-1 search dir. A root `.claude-plugin/plugin.json` `skills` list is handled the same way. Source: src/plugin-manifest.ts L52-107; src/skills.ts L253-271, L305-308. **verified**. Consequence: `plugins/<cat>/skills/<name>/SKILL.md` copies of `skills/...` names are dropped on `add` (first seen wins, `skills/` first) but make consumers' `npx skills update` skip those names as ambiguous (skills-cli note §3). **inferred** (code read, not run)
5. Agent Skills spec: allowed frontmatter is `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`; `metadata` is "a map from string keys to string values"; `name` "must match the parent directory name". Claude Code accepts `metadata` as a free-form map it never acts on ("drops a value that isn't a map"); claude.ai uploads / Skills API / `package_skill.py` reject any other key with `Unexpected key(s) in SKILL.md frontmatter: argument-hint ...`. Source: agentskills.io/specification; skills.md L388-406. **verified**
6. Codex 0.156.1 loads a skill whose frontmatter carries a nested `metadata.cursor` map (`setup-pstack` in `~/.codex/skills`, pstack note fact 18, listed in `codex debug prompt-input`). Source: prompt-input output. **verified**
7. Codex probes marketplace files in this order: `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`. Source: marketplace.rs L20-25. **verified**; that the first existing file wins is **inferred**.
8. On this machine `codex plugin list --json` shows `plugin-creator@openai-curated-remote` installed and enabled, yet `codex debug prompt-input` lists no `plugin-creator:create-plugin` / `update-plugin` skills; only the system scaffold skill `plugin-creator` (`.system/plugin-creator/SKILL.md`, "required `.codex-plugin/plugin.json` ... personal-marketplace") appears. Its `.app.json` requires connector `connector_openai_plugin_creator`. Source: both commands; cache `.app.json`. **verified** (why the CLI omits it: **unknown**)
9. codex-cli 0.156.1 has `codex cloud exec --env <ENV_ID> [--branch <b>] [--attempts n] QUERY`, `codex cloud list|status|diff|apply`. Source: `codex cloud exec --help`. **verified**
10. Codex desktop automations live in `~/.codex/automations/<id>/automation.toml` (`kind = "heartbeat"`, `prompt`, `rrule`, `status`, `target_thread_id`) with a `memory.md`; nine exist here (daily-brief, weekly-review, ...). Source: listing. **verified**; whether an automation can call connector plugins: **unknown**
11. GitHub Docs: "When you use the repository's `GITHUB_TOKEN` to perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run, with the following exceptions: `workflow_dispatch` and `repository_dispatch` events always create workflow runs. `pull_request` events with the `opened`, ..." Source: the two pages above (heading "When GITHUB_TOKEN triggers workflow runs"). **verified**
12. Justin's rules: "`main` is known-good. Never merge into, push to, or modify `main`. Justin promotes `dev` to `main` by hand." An autopilot grant covers only the autopilot branch. Source: C:/Users/Justin/.claude/CLAUDE.md. **verified**
13. Repo today (this worktree): `skills/` holds six flat `oneezy-*` skills; no `plugins/`, `upstream/`, `artifacts/`, `.claude-plugin/`, `.agents/plugins/`, `.github/`; lock v1 with 38 entries; README says others install with `npx skills add oneezy/skills`. **verified**
14. The decision tickets exist and map to the orchestrator's letters: A = #15 + #21 (wrapper), sources = #16 + #24, B = #19, C = #17 + #18, D = #20, E = #22, F = #23. Each is open with 0 comments. Source: `gh issue view`. **verified**

## Open questions

- Does Claude Code's Skill tool address a plugin skill as `oneezy:brain` or `oneezy-brain`? (claude-code-plugins note, still open.)
- Does a `codex cloud exec` task in the oneezy/skills environment still see `/root/.codex/skills/remote-skills/skill-6abd...`? Runnable from here under Justin's login; not run (uses his account).
- Why does Codex CLI omit the curated Plugin Creator skills although the plugin is enabled (connector-only surface?)

## Blockers

- Justin-only: ChatGPT plan tier, the personal Skills/Plugins UI (Download, Upload plugin), owned plugin/release ids, and any rule change about branches other than `main`.
- Nothing else blocks A-D; each missing fact below names a command or URL.

## Raw notes

- `codex debug prompt-input` roots here: r0 `~/.codex/skills`, r1 `~/.agents/skills`, r2 `.system`, r3-r9 plugin caches; Matt skills appear twice (r0 and r1).
- plugin-manifest.ts: `isContainedIn` blocks traversal; `metadata.pluginRoot` honoured only when it starts `./`; comment in skills.ts: "plugin-manifest-declared dirs ... stay at depth-1 to honor the manifest spec".
- The GitHub tutorial page `/actions/tutorials/authenticate-with-github_token` no longer carries the re-trigger sentence; the concept page and trigger-a-workflow page do.
- Fixture recipe for fact 4 (not run): `skills/alpha/SKILL.md` + `plugins/x/skills/alpha/SKILL.md` + `.claude-plugin/marketplace.json` listing `{"name":"x","source":"./plugins/x"}`; run `DISABLE_TELEMETRY=1 HOME=<tmp> USERPROFILE=<tmp> node <npx-cache>/skills/bin/cli.mjs add ../fixture -y` then `update -p -y` from a temp cwd and look for "Multiple current paths match".
