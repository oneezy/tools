---
title: The vercel-labs "skills" CLI (npx skills) as used by oneezy/skills
date: 2026-09-30
sources:
  - https://github.com/vercel-labs/skills (cloned; HEAD 3694740 2026-09-28; tag v1.7.0 = 7407f38 2026-09-17). Line numbers below are HEAD; every file cited is byte-identical at v1.7.0 except add.ts, agents.ts, remove.ts, update.ts (diff listed in Raw notes)
  - https://www.npmjs.com/package/skills (`npm view skills`: latest 1.7.0, published 2026-09-17T15:02:04Z, gitHead 7407f38; packaged README identical to README.md at v1.7.0)
  - C:/Users/Justin/AppData/Local/npm-cache/_npx/5606f1555d02ef53/node_modules/skills (cached skills@1.7.0, used for experiments)
  - V:/dev/skills/.claude/worktrees/skills-skills/skills-lock.json, skills/oneezy-skills/scripts/sync.sh, .gitignore
  - Experiments under C:/Users/Justin/.claude/jobs/432033f7/tmp/skills-cli/ (fixture/, hash.mjs, mattpocock-skills/)
---

# The `skills` CLI (vercel-labs/skills 1.7.0)

## Summary

`npx skills` 1.7.0 is the current npm `latest`; the wrapper's `add <owner/repo> --all` and `update -p -y` map to flags verified in src. `--all` = `--skill '*' --agent '*' -y`; `update -p` fixes project scope and `-y` only suppresses prompts (it never deletes skills gone upstream).
`skills-lock.json` is `src/local-lock.ts` version 1; `computedHash` is one SHA-256 over every file in the skill's source folder (path then bytes, sorted by `localeCompare`), and a re-implementation reproduced 25/38 hashes in this repo's lock against today's upstream (the rest changed upstream).
Discovery walks `skills/` (and 31 agent dirs) three levels deep, so `skills/<group>/<name>/SKILL.md` is found; `plugins/` and `upstream/` are not scanned at all unless `--full-depth`, and same-name duplicates are dropped first-seen-wins on add but make `update` skip the skill as ambiguous.
Project installs write a canonical copy to `<cwd>/.agents/skills/<name>` plus a junction/symlink in `.claude/skills/<name>` (always) and in other agents' dirs only if their root dir already exists; a single-agent target silently switches to copy mode with no canonical copy.
Refs are pinned only through the source string (`owner/repo#ref`, `#ref@skill`, `/tree/<ref>/path`, full SHA ok) and are stored per lock entry; `update <name...>` scopes to named skills.

## Facts

### 1. Commands and flags

- Dispatch: `add` (aliases `a`, `i`, `install`), `use`, `remove` (`rm`, `r`), `list` (`ls`), `find` (`search`, `f`, `s`), `update` (`upgrade`, `check`), `init`, `experimental_install`, `experimental_sync`, `--help`, `--version`. `check` is a plain alias of `update`, not a dry run. Source: src/cli.ts L336-416. verified
- `add` flags (parseAddOptions): `-g/--global`, `-y/--yes`, `-l/--list`, `--all`, `-a/--agent <agents...>`, `-s/--skill <skills...>`, `--metadata <json>`, `--full-depth`, `--json`, `--copy`, `--subagent <names...>`; `-a`/`-s` swallow following args until one starts with `-`; every other non-dash arg is a source (several allowed). Source: src/add.ts L2440-2514, help text src/cli.ts L137-148. verified
- `--all` sets `skill=['*']`, `agent=['*']`, `yes=true` (help: "Shorthand for --skill '*' --agent '*' -y"). Source: src/add.ts L1207-1212; src/cli.ts L146. verified
- `-y` with no `-s`: installs every discovered skill (L1528-1530). With no `-a`: Eve detected -> Eve; no agents detected -> all agents; otherwise detected agents + all universal agents (`ensureUniversalAgents`, L357-365). With `-g` absent -> project scope without prompting (L1745-1750). Install mode: symlink when targets span >1 skills dir, else copy (L1776-1811). Source: src/add.ts. verified
- Running inside a coding agent (`@vercel/detect-agent`; `claude`/`cowork` map to `claude-code`) forces `yes=true` and, when `-a` is absent, `agent = [detected agent + universal agents]`. Source: src/detect-agent.ts L41-54, src/add.ts L1214-1225; observed in the experiment: "claude-code_2-1-286_agent Agent detected — installing non-interactively". verified
- `-a` takes agent ids from the `AgentType` union (~80 ids, src/types.ts L1-80); `'*'` = all; an unknown id aborts with the valid list. Source: src/add.ts L1598-1612. verified
- `-s` matches case-insensitively against frontmatter `name` or the folder basename; `'*'` = all; no match aborts. `owner/repo@skill` is merged into `-s`. Source: src/skills.ts L339-348; src/add.ts L1322-1327, L1495-1522. verified
- `-g` moves the canonical dir to `~/.agents/skills`, targets each agent's `globalSkillsDir`, and records into the global lock `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`, version 3, `skillFolderHash` = GitHub tree SHA), never `skills-lock.json`. Source: src/installer.ts L128-131; src/skill-lock.ts L6-8, L67-73; src/add.ts L2088-2093 vs L2141. verified
- `--copy` writes each agent dir directly and skips the canonical `.agents/skills` copy. Source: src/installer.ts L366-376. verified
- `-l/--list` prints discovered skills and exits before any install; the experiment wrote nothing to the isolated home or cwd. Source: src/add.ts L1439+; experiment. verified
- `update` flags (parseUpdateOptions): `-g/--global`, `-p/--project`, `-y/--yes`, positional `[skills...]`. Scope: names given -> `global`/`project` if flagged else `both`; both flags -> `both`; `-g` -> global; `-p` -> project; else `-y` or non-TTY -> `project` if `hasProjectSkills()` (skills-lock.json exists or `.agents/skills/*/SKILL.md`) else `global`; else interactive select. Source: src/update.ts L65-83, L92-117, L122-169. verified
- `-y` on `update` additionally means skills that vanished upstream are only reported ("Skipping deletion in non-interactive mode"), never removed; a non-TTY stdin has the same effect. So the wrapper's `update -p -y` = project scope, no prompts, no deletions. Source: src/update.ts L261-293. verified
- `remove` flags: `-g`, `-y`, `--all` (= all + yes), `-s/--skill <names...>`, `-a/--agent <agents...>`, positional names; README: `--all` = `--skill '*' --agent '*' -y`. Deletes the canonical copy and the lock entry only when no other agent still links the skill. Source: src/remove.ts L404-443, L296-333; README "skills remove". verified
- `list`: `-g`, `-a <agents>`, `--json`; default is project scope only; scans canonical + detected agents' dirs and annotates from the matching lock. Source: src/list.ts L55-110; src/installer.ts L1120-1147. verified
- `find [query] [--owner <owner>]` queries `https://skills.sh` (`SKILLS_API_URL` override). Source: src/find.ts L17, L46-85. verified
- `experimental_install` restores `skills-lock.json` into `.agents/skills/` only (`runAdd` per source with `agent = universal agents`, `yes: true`). Source: src/install.ts L9-17, L70-76. verified
- Node `>=22.20.0` required. Source: package.json L144-146. verified

### 2. skills-lock.json format and computedHash

- File `<cwd>/skills-lock.json`, `version: 1`, `skills: { <name>: entry }`, keys sorted alphabetically, 2-space JSON, trailing newline; deliberately timestamp-free to avoid merge conflicts. Source: src/local-lock.ts L5-6, L11-14, L65-67, L106-123. verified
- Entry fields: `source` (owner/repo for github.com; SSH/other-host URLs kept verbatim; local paths stored relative), `sourceUrl?` (written only for sourceType `git`/`gitlab`), `ref?` (omitted when unset), `sourceType` (`github`|`gitlab`|`git`|`local`|`well-known`|`download`|`node_modules`), `skillPath?` (repo-relative `.../SKILL.md`, `/` separators, `SKILL.md` for a root skill), `computedHash`, `subagents?` (Eve only), `wellKnownDigest?`. Source: src/local-lock.ts L15-46, L125-138; src/add.ts L86-108, L2002-2017, L2156-2170. verified
- `computedHash` = `computeSkillFolderHash(skillDir)`: recursively collect every regular file under the skill folder, skipping directories named `.git` or `node_modules`; relative path with `\` -> `/`; sort by `relativePath.localeCompare`; one `createHash('sha256')`, for each file `update(relativePath)` then `update(contentBytes)`; hex digest. Source: src/local-lock.ts L140-184 (`computeSkillFolderHash`, `collectFiles`). verified
- The hash is taken from the skill's folder in the source clone (`skill.path`), not from the installed copy; blob installs (allow-listed owners only) use the snapshot hash instead. Source: src/add.ts L2066-2082. verified
- Verification: hash.mjs (re-implementation) against a fresh clone of mattpocock/skills (d81f3a1, 2026-09-29) reproduced 25 of this repo's 38 entries exactly; 9 differ and 4 are at paths that no longer exist (upstream edits/moves since the lock was written). Source: experiment, C:/Users/Justin/.claude/jobs/432033f7/tmp/skills-cli/hash.mjs. verified
- `update` recomputes the same hash from a fresh clone and skips skills whose hash equals `computedHash` — at HEAD only; 1.7.0 reinstalls every project skill on update. Source: src/update.ts L893-930; `git diff v1.7.0 HEAD -- src/update.ts`. verified
- `localeCompare` ordering depends on the process locale/ICU; two machines could in principle order unusual file names differently and produce different hashes. inferred (no such case observed)

### 3. Discovery in a source repo

- `discoverSkills` (used for every non-allow-listed GitHub source, local paths, GitLab and git URLs): (1) if the search root itself has SKILL.md, that single skill is returned unless `--full-depth`; (2) priority containers: root (depth 1), `skills/`, `skills/.curated`, `skills/.experimental`, `skills/.system`, and 31 agent dirs (`.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, ...), each walked 3 levels deep, never descending below a directory that has SKILL.md; plugin-manifest paths (`.claude-plugin/marketplace.json`/`plugin.json`) appended at depth 1; (3) recursive fallback (depth 5, skipping node_modules/.git/dist/build/__pycache__) only when nothing was found or `--full-depth`. Source: src/skills.ts L10-43, L135-157, L180-329; src/constants.ts L6; README "Skill Discovery". verified
- Same-name duplicates are dropped silently, first seen wins, in container order (so `skills/` beats `.agents/skills`, `.claude/skills` and anything found by fallback). Source: src/skills.ts L276, L318. verified
- Skills found under an agent dir whose name appears in the source repo's own `skills-lock.json` are skipped as "installed project skills". Source: src/skills.ts L188-189, L213-225, L240, L277. verified
- `npx skills add oneezy/skills` (and mattpocock/skills) always goes `git clone --depth 1` + `discoverSkills`; the GitHub Trees "blob" fast path is only for owners vercel, vercel-labs, heygen-com, remotion-dev or repos in `BLOB_ALLOWED_REPOS` (zapier/connectors). Source: src/add.ts L1369-1420; src/blob.ts L51-56; src/git.ts L295-302. verified
- Experiment (skills 1.7.0, `add ./fixture --list`): default found `alpha` (skills/eng), `beta`, `flat`; did NOT find `skills/a/b/c/deep` (4 levels); `plugins/alpha` and `upstream/alpha` were never scanned; `.agents/skills/alpha` and `.claude/skills/alpha` were dropped as duplicates. `--full-depth` added `deep` only; the plugins/upstream copies were still dropped by name. Source: fixture run, output in Raw notes. verified
- Consequence for the nested layout: `skills/<group>/<name>/SKILL.md` (and one more level) is found by plain `npx skills add oneezy/skills`. inferred from the above
- Consequence for committed copies in `plugins/` or `upstream/` with the same `name`: invisible to `add` (first-seen wins even with `--full-depth`), but `update` runs discovery with `fullDepth: true, includeDuplicateNames: true` and `resolveSkillLocations` marks any name with >1 path as ambiguous and skips it ("Multiple current paths match these skills ... skipping"), so consumers could no longer update those skills. Source: src/update.ts L870-874, L306-316; src/skill-relocation.ts L53-59. verified (code), not run

### 4. Where `add` writes on disk

- Project scope (default): canonical copy at `<cwd>/.agents/skills/<sanitized name>` (existing dir is rm -rf'd and recreated), then per target agent: universal agents (skillsDir `.agents/skills`: amp, codex, cursor, opencode, gemini-cli, github-copilot, cline, droid, kilo, antigravity, replit, ...) get nothing extra; non-universal agents get `<cwd>/<agent.skillsDir>/<name>` -> canonical, created only if the agent's root dir (e.g. `.goose`, `.hermes`, `.windsurf`) already exists in cwd, EXCEPT when that agent id was named explicitly with `-a <id>` (not `'*'`/`--all`): `installSkillForAgent` is then called with `createMissingAgentRoot: true` and the dir is created regardless; `claude-code` has `createProjectSkillsDirByDefault: true`, so `.claude/skills/<name>` is always created. Source: src/installer.ts L61, L95-111, L128-131, L151-181, L198-207, L389-446; src/add.ts L1203-1205, L1598-1612, L1969, L1982; src/agents.ts L155-165, L877-915. verified (skeptic: exception added)
- On Windows the link is a directory junction with an absolute target; if linking fails the CLI copies instead and prints "On Windows, enable Developer Mode for symlink support". Source: src/installer.ts L281-291, L426-439; src/add.ts L2301-2306. verified
- Without `-a`: targets = detected agents (`detectInstalled`: claude-code = `$CLAUDE_CONFIG_DIR|~/.claude` exists, codex = `$CODEX_HOME|~/.codex` or /etc/codex, cursor = `~/.cursor`, goose = `~/.config/goose`, hermes-agent = `$HERMES_HOME|~/.hermes`) + all universal agents; inside Claude Code = claude-code + universal. With `--all`/`-a '*'`: all agents, but the missing-root-dir skip still applies, so `.windsurf/` etc. are not created. Source: src/agents.ts L1-18, L80-826, L828-836; src/add.ts L1615-1680. verified
- Single-target install (all selected targets share one `skillsDir`) forces copy mode: files go straight to that agent's dir and the canonical-copy step is skipped. For a non-universal agent alone (e.g. `-a claude-code`) that means `.claude/skills/<name>` holds the files and `.agents/skills/<name>` is NOT written. For a universal agent alone (e.g. `-a codex`) the agent dir IS `.agents/skills`, so the files still land in `.agents/skills/<name>`; only `.claude/skills` is missing. Source: src/add.ts L1776-1811; src/installer.ts L128-131, L151-160, L366-376. verified (skeptic: corrected the `-a codex` example)
- Global (`-g`): canonical `~/.agents/skills/<name>`; universal agents get no link into their own global dir (`~/.codex/skills`, `~/.cursor/skills` stay empty); non-universal agents get `<globalSkillsDir>/<name>` (claude-code: `~/.claude/skills`, goose: `~/.config/goose/skills`, hermes: `~/.hermes/skills`); agents with no global dir (eve, promptscript) are rejected. Source: src/installer.ts L128-131, L168-181, L305-316, L392-402; README "Supported Agents". verified
- Lock target: project -> `<cwd>/skills-lock.json`; global -> `~/.agents/.skill-lock.json`. Source: src/add.ts L2088-2175. verified
- `update` reinstalls by spawning `node cli.mjs add <source/folder[#ref]> --skill <name> [--full-depth] -y` per changed skill with no `-a`/`-g`, so targets are re-derived by the child (detected + universal; claude-code + universal when run from Claude Code) at project scope in cwd. Source: src/update.ts L936-960; src/update-source.ts L140-149. verified

### 5. Refs and scoping

- Ref syntax: `owner/repo#ref`, `owner/repo#ref@skill`, `github.com/owner/repo/tree/<ref>[/path]`, `git@host:owner/repo.git#ref`, GitLab `/-/tree/<ref>/path`, Azure `?version=GB<branch>`; fragments count as refs only on git-like sources. There is no `--ref` flag. Source: src/source-parser.ts L183-192, L283-320, L431-451, L520-548; src/add.ts L2440-2514. verified
- Clone is `git clone --depth 1 [--branch <ref>]`; if `ref` is a 40-hex SHA and `--branch` fails, it does `fetch --depth 1 origin <sha>` + checkout, so branch, tag or full commit SHA all work. Source: src/git.ts L30-32, L58-76, L295-320. verified
- `ref` is stored per lock entry, so skills from one repo can carry different refs; `update` groups by source+ref and re-clones each group at its own ref. A branch ref tracks the branch tip on update; a tag/SHA stays fixed. Source: src/add.ts L2164; src/update.ts L549-555, L822-829, L848-870. verified
- `update <name...>` filters by exact case-insensitive name; entries without `skillPath` are "legacy" and can only be refreshed by re-adding. Source: src/update.ts L172-176, L244-259, L806-807, L997-1010. verified

## Open questions

- Should the wrapper pass `-a` on `update` (or run `add ... --all` again) so the reinstall targets match the original `--all`? Junctions in other agent dirs survive because the canonical path is recreated in place, but that is inferred, not tested.
- Is the `localeCompare` sort a real cross-machine risk for this library's file names (all ASCII so far)? Untested.
- Whether skills-sync (oneezy/tools) must reproduce `computedHash` or only read it; out of scope here.

## Blockers

None.

## Raw notes

- `npm view skills`: name skills, version 1.7.0, dist-tags latest=1.7.0 snapshot=1.5.23-snapshot.2, repository git+https://github.com/vercel-labs/skills.git, bin `skills`/`add-skill` -> bin/cli.mjs; 1.6.0 published 2026-09-17T00:01Z, 1.7.0 2026-09-17T15:02Z.
- `git diff --stat v1.7.0 HEAD -- src README.md`: README (Pi moved to `.agents/skills`), add.ts (global lock for local sources), agents.ts (Pi dirs), remove.ts (telemetry source for local), update.ts (hash-skip of unchanged project skills + "Checking" wording). skills.ts, local-lock.ts, installer.ts, cli.ts, source-parser.ts, blob.ts, git.ts, update-source.ts, skill-relocation.ts, detect-agent.ts are identical at tag and HEAD.
- Wrapper (skills/oneezy-skills/scripts/sync.sh): `add` -> `cd $lib && npx --yes skills@latest add "$@" --all`; `update` -> `cd $lib && npx --yes skills@latest update -p -y`; both followed by `npx --yes @oneezy/skills-sync --quiet`. Library `.gitignore` ignores `.agents/skills/`, `.claude/skills/`, `.goose/`, `.hermes/`, `skills-sync.json`.
- This repo's lock: version 1, 38 entries, all `source: mattpocock/skills`, `sourceType: github`, `skillPath: skills/<category>/<name>/SKILL.md`, no `ref`, no `sourceUrl`.
- Fixture: skills/eng/{alpha,beta}, skills/flat, skills/a/b/c/deep, plugins/alpha, upstream/alpha, .agents/skills/alpha, .claude/skills/alpha (descriptions name their location). Command: `DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 USERPROFILE=<tmp> HOME=<tmp> node <cache>/skills/bin/cli.mjs add ../fixture --list [--full-depth]` from tmp/cwd. Default output: "Found 3 skills": alpha "alpha in skills/eng", beta, flat. `--full-depth`: "Found 4 skills" adding deep. `find fakehome cwd -type f` afterwards: empty.
- hash.mjs result: `match=25 differ=9 missing=4 total=38`; DIFF: ask-matt, codebase-design, diagnosing-bugs, domain-modeling, improve-codebase-architecture, setup-matt-pocock-skills, tdd, triage, wait-what; MISSING: implement-spec, pr, resolving-merge-conflicts, retro (paths gone upstream).
- Telemetry (src/telemetry.ts) has no file writes; `DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1` disable it; GitHub identifiers are sent only for confirmed-public repos (README "Telemetry").
- Global lock v3 (`~/.agents/.skill-lock.json`) also stores `dismissed` prompts and `lastSelectedAgents` (src/skill-lock.ts L40-60); older versions are wiped on read (L92-96).

## Skeptic pass

Re-checked 2026-09-30 against the same clone (C:/Users/Justin/.claude/jobs/432033f7/tmp/skills-cli/upstream, HEAD 3694740; `git rev-parse v1.7.0^{commit}` = 7407f38) and the cached skills@1.7.0 package. `git diff --stat v1.7.0 HEAD -- src README.md` touches only README.md, add.ts, add.test.ts, agents.ts, remove.ts, update.ts, as the front matter says.

1. `--all` = `--skill '*' --agent '*' -y`; `update -p -y` never deletes. HOLDS. src/add.ts L1207-1212 sets skill/agent/yes; src/cli.ts L146 help text; src/update.ts `promptDeletions` returns after "Skipping deletion in non-interactive mode." when `options.yes || !process.stdin.isTTY`.
2. `computedHash` algorithm. HOLDS. src/local-lock.ts L140-184: recursive `collectFiles` skipping `.git`/`node_modules`, `\`->`/`, sort by `localeCompare`, one sha256 with `update(relativePath)` then `update(content)`.
3. Discovery depth 3 under `skills/`, `plugins/`/`upstream/` unscanned, first-seen-wins, `update` skips ambiguous names. HOLDS. src/constants.ts L6 `DEFAULT_SKILL_CONTAINER_DEPTH = 3`; src/skills.ts L262-267 (priority dirs), L296-318 (walk stops at a found skill, dup dropped in `tryAddSkillAt`), fallback only when empty or `--full-depth`; src/update.ts L870-874 (`fullDepth: true, includeDuplicateNames: true`), L306-316; src/skill-relocation.ts L57-60 (`candidates.length > 1` -> ambiguous). Fixture re-run with skills@1.7.0 `add ../fixture --list` again printed alpha, beta, flat only.
4. Where project `add` writes. HOLDS WITH TWO CORRECTIONS. (a) The "root dir must already exist" skip is bypassed for agents named explicitly with `-a <id>`: src/add.ts L1969/L1982 pass `createMissingAgentRoot: explicitlySelectedAgents.has(agent)`, and `'*'`/`--all` leaves that set empty (L1203-1205), so the skip applies to `--all` but not to `-a windsurf`. Fact 4 bullet 1 edited. (b) "`-a codex` alone makes no `.agents/skills` copy" was wrong: for a universal agent `getAgentBaseDir` IS the canonical dir (src/installer.ts L157-159), so copy mode writes `.agents/skills/<name>` anyway. Fact 4 bullet 4 edited.
5. `update` hash-skip exists only at HEAD; 1.7.0 reinstalls every project skill; the child `add` gets no `-a`/`-g`. HOLDS. `git diff v1.7.0 HEAD -- src/update.ts` adds `latestHashes`/`upToDateCount` and the `latestHash === skill.entry.computedHash` skip (all +lines); the `spawnSync` argv at HEAD is `[cliEntry, 'add', installUrl, '--skill', name, ...subagentArgs, ...fullDepthArgs, '-y']`.

Not re-checked: the hash.mjs 25/38 reproduction, the `-g` global-lock details, ref parsing in source-parser.ts.
