---
title: Integration probes, the library on feature/skills-sync-migration against @oneezy/skills-sync 0.3.0, Claude Code, npx skills and Codex (oneezy/skills#32)
date: 2026-10-01
sources:
  - https://github.com/oneezy/skills/issues/32 (the probes and the carry-over from tools PR #78), https://github.com/oneezy/skills/issues/27 (the spec and Justin's two corrections of 2026-10-01)
  - C:/Users/Justin/.claude/jobs/432033f7/tmp/32/clone (fresh clone of oneezy/skills `ticket/32-integration` at 79e7e103e56edee9e7bf2493d71fcaab03afa50d: `feature/skills-sync-migration` 8e4d8fe plus this ticket's workflow and checklist fixes; refreshed by probe a) and .../32/clone-unrefreshed (the same commit, never refreshed)
  - V:/dev/tools/packages/skills-sync/dist/src/cli.js (@oneezy/skills-sync 0.3.0 built from oneezy/tools dev 23667d577fb6e7a411c87530167c61287751ac0b, run by path; 0.3.0 is not on npm, `npm view @oneezy/skills-sync version` says 0.2.0)
  - C:/Users/Justin/AppData/Local/npm-cache/_npx/5606f1555d02ef53/node_modules/skills/bin/cli.mjs (skills 1.7.0), Claude Code 2.1.286, codex-cli 0.156.1, node 24, PowerShell 7.6.6, Git Bash on Windows 11
  - Verbatim logs under C:/Users/Justin/.claude/jobs/432033f7/tmp/32/logs/ (a-*.log, b-validate.log, c-session.jsonl, c2-session.jsonl, d*.log, e*.log, f*.log, g-claude-marketplace.log)
---

# Integration probes (#32)

## Summary

Every probe passed. On a fresh clone, `refresh --frozen`, `build --check` and `check` exit 0 and leave the tree clean, and `sync --plan` reports no conflict. `claude plugin validate` passes on the catalog and the four packages. A real `claude --plugin-dir plugins/oneezy -p "/oneezy:oneezy-status"` session loaded the package as `oneezy@inline`, resolved the namespaced skill to the package's copy and returned a status report. `npx skills` lists the eight own skills once each, installs them from the GitHub branch and updates all eight with no `Multiple current paths` warning. Codex accepts the clone as a marketplace and lists the four plugins. A ref-pinned Claude marketplace on the branch installs `oneezy` and is removed again. The wrapper maps its arguments as #29 left them. One run is pending: the wrapper against the real `npx @oneezy/skills-sync`, which waits for Justin to publish 0.3.0 with his one-time password.

One finding to keep: a headless `-p` session cannot read a `--plugin-dir` package's own reference files (`STATUS.md`) unless the folder is granted with `--add-dir`; the skill still runs and says what it could not read.

## Facts

Every tool run that is not `--plan` had `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` on a temp home under `.../tmp/32/` and passed `--no-global --no-projects --no-wsl`. No run pointed `--repo` at a worktree. `~/.skills-sync` is a junction to `V:\dev\skills` before and after.

### 0. The by-name package lookup at the new pin

`.github/scripts/find-package.mjs` against a fresh checkout of oneezy/tools at `23667d577fb6e7a411c87530167c61287751ac0b`:

```
$ GITHUB_OUTPUT=find-package.out node .github/scripts/find-package.mjs tools
C:\Users\Justin\.claude\jobs\432033f7\tmp\32\tools\packages\skills-sync
exit=0
dir=C:\Users\Justin\.claude\jobs\432033f7\tmp\32\tools\packages\skills-sync
cli=C:\Users\Justin\.claude\jobs\432033f7\tmp\32\tools\packages\skills-sync\dist\src\cli.js
```

`clis/skills-sync` at that commit holds only a `README.md`, so one package carries the name. verified

### a. The tool on a fresh clone

```
$ node cli.js refresh --frozen --repo <clone> --no-global --no-projects --no-wsl
fetching https://github.com/mattpocock/skills.git at d81f3a1
fetching https://github.com/mattpocock/skills.git at 3216582
fetching https://github.com/cursor/plugins.git at 2eb7ed4
matt-pocock: d81f3a1 (2026-09-29), moved
pstack: 2eb7ed4 (2026-09-30), moved
+ write        <clone>\upstream\matt-pocock\.snapshot.json  (37 skills at d81f3a1)
+ write        <clone>\upstream\pstack\.snapshot.json  (47 skills at 2eb7ed4)
176 changed, 0 already right, 0 left alone
exit=0

$ node cli.js build --check --repo <clone> --no-global --no-projects --no-wsl
. note         <clone>\plugins\oneezy  (no LICENSE in the library; the package carries none)
. note         <clone>\plugins\trident  (no LICENSE in the library; the package carries none)
build --check: clean, 271 files as built
exit=0

$ node cli.js check --repo <clone> --no-global --no-projects --no-wsl
check: clean, 8 own skills, 8 flows, 272 generated files as built
exit=0

$ node cli.js sync --plan --repo <clone> --no-global --no-projects --no-wsl -y
+ link         <temp home>\.skills-sync -> <clone>  (remembers where the library is)
+ link         <clone>\.agents\skills\oneezy-status -> <clone>\skills\oneezy\oneezy-status
+ write        <clone>\.agents\skills\.gitignore  (8 entries)
+ link         <clone>\.claude\skills\writing-shape -> <clone>\.agents\skills\writing-shape
plan: 102 would change, 0 already right, 0 left alone
exit=0
```

- The `refresh --frozen` lines shown are the first five and three of its 176 action lines (168 copies, 4 attribution files, 2 `.snapshot.json`, 2 renamed frontmatter names); the lock is not written. `git status --short` in the clone is empty after all four; `--ignored` shows only `.agents/skills/` and `upstream/`. verified
- The plan's 102 lines are the home link, 8 own-skill links, the generated `.gitignore` and 92 `.claude/skills` links: the layers a fresh clone has not built yet. No line is a conflict (`0 left alone`, the word `conflict` appears nowhere), and no committed file is in the plan. verified

### b. `claude plugin validate` (Claude Code 2.1.286, temp `CLAUDE_CONFIG_DIR`)

```
$ claude plugin validate .
Validating marketplace manifest: <clone>\.claude-plugin\marketplace.json
⚠ Found 4 warnings:
  ❯ plugins[0] plugin.json → version: No version specified. Consider adding a version following semver (e.g., "1.0.0")
  (the same for plugins[1], plugins[2], plugins[3])
✔ Validation passed with warnings
exit=0

$ claude plugin validate plugins/oneezy
Validating plugin manifest: <clone>\plugins\oneezy\.claude-plugin\plugin.json
⚠ Found 1 warning:
  ❯ version: No version specified. Consider adding a version following semver (e.g., "1.0.0")
✔ Validation passed with warnings
exit=0
```

`plugins/trident`, `plugins/matt-pocock` and `plugins/pstack`: the same one warning, `✔ Validation passed with warnings`, exit 0. The missing Claude version is ADR-0003's choice (Claude Code tracks the library's commits). verified

### c. A real session with the plugin

Run from a throwaway git repo (`.../tmp/32/throwaway`: branch `feature/probe-32` one commit ahead of `dev`, `answer.js` modified, `notes.txt` untracked, no remote), with Justin's real login:

```
$ MSYS_NO_PATHCONV=1 claude --plugin-dir <clone>/plugins/oneezy -p "/oneezy:oneezy-status" --output-format stream-json --verbose
exit=0
```

- The session's `init` event lists the package first: `{"name":"oneezy","path":"C:\\Users\\Justin\\.claude\\jobs\\432033f7\\tmp\\32\\clone\\plugins\\oneezy","source":"oneezy@inline"}`, and its `slash_commands` and `skills` hold both `oneezy-status` (the linked user skill) and `oneezy:oneezy-status` (the plugin's), likewise for the other five. verified
- The namespaced name resolved to the package's copy: the first tool call was `Read` of `<clone>\plugins\oneezy\skills\oneezy-status\STATUS.md`, the file the plugin copy's `SKILL.md` points at, not the one under `~/.claude/skills`. verified
- It ran and answered as the skill (session 190bc63d-0ff6-44b0-88d6-0f29c6b3c3ef, 8 turns, `result/success`). The report opens:

  ```
  Title: /oneezy-status feature/probe-32

  ## Status: `feature/probe-32` · state **branch**
  | Branch | `feature/probe-32` at `e8ec6f1` feat: add answer |
  | Base | `dev` at `be01c64` (local only), branch is 1 commit ahead |
  | Uncommitted | `answer.js` modified (1 insertion, 1 deletion); `notes.txt` untracked |
  ```

  and ends with Next Up and a next-session prompt. It also says what it could not do: `Reading the skill's STATUS.md was denied, so the layout and line cap are my best effort, not the fixed template.` The denial is the headless session's: `permission_denied`, `decision_reason: "Path is outside allowed working directories"`. A `-p` session cannot prompt, and a `--plugin-dir` folder is not a working directory. verified
- The same command with `--add-dir <clone>/plugins/oneezy` (session aaf6eb96-ca2f-4b08-b1d6-895af429db86, 7 turns, `result/success`) read `STATUS.md` and returned the fixed shape:

  ```
  # `feature/probe-32` status
  **feat:** add answer
  ### Quick Links
  ### Overview
  ### Git
  `feature/probe-32` off `dev`, 1 ahead, 2 files uncommitted; not pushed, no remote configured.
  ### Builds (0)
  ### Next Up (3)
  ```

  The throwaway repo is unchanged after both runs (`## feature/probe-32`, ` M answer.js`, `?? notes.txt`). verified

### d. `npx skills` 1.7.0 (temp `HOME`, `USERPROFILE` and cwd, `DISABLE_TELEMETRY=1`)

```
$ skills add <clone-unrefreshed> --list
◇  Found 8 skills
exit=0

$ skills add <clone-unrefreshed> --list --full-depth
◇  Found 8 skills
exit=0
```

- Both list `oneezy-brain`, `oneezy-estimate`, `oneezy-merge`, `oneezy-remote`, `oneezy-skills`, `oneezy-status`, `oneezy-app-route`, `oneezy-ui-component`, each once; no plugin copy appears (every one carries `metadata.internal: true`). This is the not-refreshed case. verified
- The refreshed case, on the clone probe a refreshed: `--list` says `Found 8 skills`, `--list --full-depth` says `Found 90 skills`: the eight plus 82 snapshots under `upstream/`, under their upstream names (`tdd` and `teach` once each, no `pstack-tdd`; 84 snapshot folders, two names shared by the two sources). The working-set copies in `.agents/skills` are not listed. verified

```
$ skills add https://github.com/oneezy/skills#feature/skills-sync-migration -y
◇  Installed 8 skills
└  Done!  Review skills before use; they run with full agent permissions.
exit=0

$ skills update -p -y
Checking for skill updates…

Updating for: Universal
Refreshing 8 skill(s)…

Updating oneezy-app-route…
  ✓ Updated oneezy-app-route
Updating oneezy-brain…
  ✓ Updated oneezy-brain
Updating oneezy-estimate…
  ✓ Updated oneezy-estimate
Updating oneezy-merge…
  ✓ Updated oneezy-merge
Updating oneezy-remote…
  ✓ Updated oneezy-remote
Updating oneezy-skills…
  ✓ Updated oneezy-skills
Updating oneezy-status…
  ✓ Updated oneezy-status
Updating oneezy-ui-component…
  ✓ Updated oneezy-ui-component

✓ Updated 8 skill(s)
exit=0
```

- The install wrote `.agents/skills/<8>` and a `skills-lock.json` in the temp cwd with `source: oneezy/skills`, `ref: feature/skills-sync-migration`, `sourceType: github`, `skillPath: skills/oneezy/<name>/SKILL.md` (`skills/trident/…` for the two Trident skills). The update log holds no `Multiple current paths` line (`grep -c` gives 0): the defect the duplicate-listing probe found is closed by the `metadata.internal` mark. Third-party plugin copies are not served as skills of oneezy/skills. verified

### e. Codex 0.156.1 (temp `CODEX_HOME`)

```
$ codex plugin marketplace add <clone>
Added marketplace `oneezy-skills` from \\?\C:\Users\Justin\.claude\jobs\432033f7\tmp\32\clone.
Installed marketplace root: C:\Users\Justin\.claude\jobs\432033f7\tmp\32\clone
exit=0

$ codex plugin list --available --json
exit=0
```

The JSON's `available` holds, for marketplace `oneezy-skills`: `oneezy`, `trident`, `matt-pocock`, `pstack`, each `version: 0.23.0+69c043411fdf`, `installPolicy: AVAILABLE`, `authPolicy: ON_USE`, `installed: false`, `source: {"source": "local", "path": "<clone>\\plugins\\<id>"}`. Codex reads the committed `.agents/plugins/marketplace.json` with its `./plugins/<id>` sources as it is; no local-source copy of the catalog was needed. verified

### f. The wrapper with a fake `npx` on `PATH`

The #29 tests (`.../tmp/29/test.sh`, `test.ps1`, a fake `npx` that prints one argument per line) against the clone's `skills/oneezy/oneezy-skills/scripts/`:

```
ok   no arguments -> --yes|@oneezy/skills-sync|--quiet|
ok   add owner/repo -> --yes|@oneezy/skills-sync|add|owner/repo|--quiet|
ok   update -> --yes|@oneezy/skills-sync|refresh|--quiet|
ok   status -> --yes|@oneezy/skills-sync|status|
ok   --plan -> --yes|@oneezy/skills-sync|--plan|
ok   unlink -> --yes|@oneezy/skills-sync|unlink|
ok   add with --plan -> --yes|@oneezy/skills-sync|add|owner/repo|--plan|--quiet|
ok   add with --as -> --yes|@oneezy/skills-sync|add|cursor/plugins#main|--root|pstack/skills|--as|tdd=pstack-tdd|--quiet|
ok   update --retry -> --yes|@oneezy/skills-sync|refresh|--retry|--quiet|
ok   status --json -> --yes|@oneezy/skills-sync|status|--json|
bash: 10 passed, 0 failed
exit=0
powershell 7.6.6: 20 passed, 0 failed
exit=0
```

The PowerShell 20 are the same ten cases twice: `npx` as an in-process function, and `sync.ps1` run with `-File` against a fake `npx.cmd`. verified

**PENDING: the wrapper against the real `npx @oneezy/skills-sync`.** npm holds 0.2.0; 0.3.0 waits for Justin's one-time password. The run was not attempted: the published 0.2.0 reads a `skills-sync.json` as its answers file and overwrites the committed config, which is also why this branch lands in `dev` only after the publish.

### g. A ref-pinned Claude marketplace on the branch (temp `HOME` and `CLAUDE_CONFIG_DIR`)

```
$ claude plugin marketplace add oneezy/skills#feature/skills-sync-migration
Cloning repository (timeout: 120s): https://github.com/oneezy/skills.git (ref: feature/skills-sync-migration)
Clone complete, validating marketplace…
✔ Successfully added marketplace: oneezy-skills (declared in user settings)
exit=0

$ claude plugin install oneezy@oneezy-skills
Installing plugin "oneezy@oneezy-skills"...✔ Successfully installed plugin: oneezy@oneezy-skills (scope: user)
exit=0

$ claude plugin list
  ❯ oneezy@oneezy-skills
    Version: 8e4d8fedc265
    Scope: user
    Status: ✔ enabled
exit=0

$ claude plugin uninstall oneezy@oneezy-skills
✔ Successfully uninstalled plugin: oneezy (scope: user)
exit=0

$ claude plugin marketplace remove oneezy-skills
✔ Successfully removed marketplace: oneezy-skills
exit=0

$ claude plugin marketplace list
No marketplaces configured
exit=0
```

"User settings" here is the temp config dir's `settings.json`; `~/.claude/plugins/known_marketplaces.json` holds no `oneezy-skills` entry. The version Claude Code reports is the branch's commit, as ADR-0003 intends. verified

## Superseded parts of the ticket

- **The `plugins` branch.** Justin's second correction on #27 (2026-10-01) removed it: the built packages are committed under `plugins/<id>/` and the catalogs point at `./plugins/<id>`. Nothing was bootstrapped and no publish job exists; probes e and g show both hosts resolving the committed packages.
- **`npx --yes <tarball url> --help`.** The same correction dropped the tarball fallback; the wrapper runs `npx --yes @oneezy/skills-sync` only. Its real-`npx` run is the pending item above.

## Open questions

- Does an installed plugin (not `--plugin-dir`) let a headless session read the package's reference files without `--add-dir`? An interactive session prompts once; `-p` cannot. Untested: it needs an install into the real config.
- Codex loading a skill whose frontmatter carries `metadata.internal: true` in a session (the duplicate-listing probe's open question) is still untested; `marketplace add` and `list` only read manifests.

## Blockers

None for this ticket. The landing into `dev` waits for `@oneezy/skills-sync` 0.3.0 on npm.

## Raw notes

- `npx skills` prints `claude-code_2-1-286_agent  Agent detected — installing non-interactively` under this harness; it only forces `-y`.
- `add -y` from GitHub also printed `skipped: Hermes Agent (project directory not found)` per skill: the temp cwd has no agent folder besides the `.agents/skills` it wrote.
- Codex wrote only `config.toml` (`[marketplaces.oneezy-skills]`, `source_type = "local"`) and `tmp/` into the temp `CODEX_HOME`.
- In the first session the model's first compound `git` command and `git status --porcelain=v1 -b` were refused by the headless permission mode; single read-only `git` commands ran. That is the session's permission setup, not the plugin.
