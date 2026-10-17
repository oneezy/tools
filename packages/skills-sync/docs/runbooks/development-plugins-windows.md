# Windows acceptance runbook: development Plugins

Ticket oneezy/tools#217 of spec #209. Justin runs this once on his Windows 11 PC, in PowerShell 7, with Claude Code (CLI and Claude Code Desktop) and Codex in the ChatGPT desktop app. It takes about three hours. It is the only evidence that closes #213, #214, #215 and #217: the cloud tests use fake Harnesses, and no claim rests on them alone (`../development-plugins-compatibility.md` lists what each side proves).

An agent in the thread reads the evidence and closes tickets. Nobody closes them from a cloud session.

## How to run it

- Run every command in PowerShell 7 (`pwsh`). Copy each fenced block whole. Text inside a `text` block goes into a chat or an editor.
- Each step has the commands, then **Expect** (what a pass looks like), then **Record** (the `Note` line that writes the result to `results.md`). A `Note` line is `Note "<step>" "PASS or FAIL, then what you saw"`.
- Use one main window for every step, and the terminal tabs a step names (W1 and the others). Variables such as `$f1`, `$out` and `$goodHash` live in that main window.
- Every command and its output lands in a transcript. Screenshots go in `$Evidence\shots`, named `<step>-<what>.png`.
- A different version, an extra line or a failed Expect is data. Write it in the `Note` and carry on, unless a **Stop** rule applies.
- A running chat is never restarted for you. At each reload, you choose when to type `/reload-plugins`, start a new chat, or restart the app.

**Stop rules.** Stop the affected part, `Note` it, and carry on with the rest. Never rename a Plugin, change account Plugin settings or edit a Harness cache to force a pass.

1. Codex lists an enabled `play` from the ChatGPT account (`created-by-me-remote`) or a workspace (`workspace-*`): skip the Codex parts. Setup refuses it by design (ADR-0007), and project-only suppression may be impossible with supported controls. This is the spec's return-to-Justin case.
2. After setup, reload and a new chat, P1 still loads the released `play` in Claude Code: stop the Claude parts and report.
3. P1 loads two `play:*` skill sets in either Harness: report and carry on.

## 0. Shell prelude

Paste this block into every PowerShell 7 window used in this run, watcher windows included. `$env:SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS` switches on the two adapters that are `verified: false` until this run passes (`src/develop-project.ts`, `testSwitch`). It is a comma-separated list of Harness ids with no spaces, and it lasts for this window only. Setup, status and remove need it in the window they run in: without it, setup prints `<harness>: not activated: its adapter is not verified`, and remove refuses a project that setup activated. Never put it in a profile.

```powershell
$Main       = "V:\dev\tools"                          # your normal tools checkout
$Tools      = "V:\dev\tools-issue-217-windows-proof"  # the worktree step 2 makes
$Lib        = "$Tools\packages\skills"
$Root       = "C:\dev\proof-217"
$P1 = "$Root\P1"; $P2 = "$Root\P2"; $N = "$Root\N"; $P3 = "$Root\P3"
$Evidence   = "$Root\evidence"
$ClaudeHome = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { "$HOME\.claude" }
$CodexHome  = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { "$HOME\.codex" }
$env:SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS = "claude-code,codex"
New-Item -ItemType Directory -Force "$Evidence\shots" | Out-Null
Start-Transcript -Path "$Evidence\transcript-$(Get-Date -Format yyyyMMdd-HHmmss).txt" | Out-Null

function Note($step, $text) { Add-Content "$Evidence\results.md" "- [$step] $(Get-Date -Format s) $text" }

# Snap writes the plugin lists of P1, P2 and N, both marketplace lists, and a hash of every file this run can change.
function Snap($name) {
  $d = "$Evidence\snap-$name"; New-Item -ItemType Directory -Force $d | Out-Null
  foreach ($p in @($P1, $P2, $N)) {
    if (Test-Path $p) { Push-Location $p; claude plugin list --json > "$d\claude-plugins-$(Split-Path $p -Leaf).json"; Pop-Location }
  }
  claude plugin marketplace list --json > "$d\claude-marketplaces.json"
  codex plugin list --json > "$d\codex-plugins.json"
  codex plugin marketplace list --json > "$d\codex-marketplaces.json"
  $files = @("$ClaudeHome\settings.json", "$ClaudeHome\plugins\installed_plugins.json", "$ClaudeHome\plugins\known_marketplaces.json", "$CodexHome\config.toml", "$CodexHome\hooks.json")
  foreach ($p in @($P1, $P2, $N)) { $files += "$p\.claude\settings.local.json", "$p\.codex\config.toml", "$p\.agents\skills-sync-project.json" }
  $files += Get-ChildItem "$Lib\dist\development" -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object FullName
  $files | Where-Object { Test-Path $_ } | Get-FileHash | Select-Object Hash, Path | Out-File "$d\hashes.txt" -Width 400
}

# SnapDiff prints every line that differs between two snaps. No lines under a heading means that file is identical.
function SnapDiff($a, $b) {
  Get-ChildItem "$Evidence\snap-$a" -File | ForEach-Object {
    "== $($_.Name)"
    Compare-Object (Get-Content $_.FullName) (Get-Content "$Evidence\snap-$b\$($_.Name)") | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" }
  }
}
```

`watcher.json` and `projects.json` legitimately differ between snaps taken with the watcher in different states.

## 1. Record the starting point

### 1.1 Versions

```powershell
$PSVersionTable.PSVersion.ToString()
[System.Environment]::OSVersion.VersionString
node --version; pnpm --version; git --version
claude --version
codex --version
npm ls --global --depth=0 @oneezy/skills-sync
```

Also read the versions from each app's About screen: the ChatGPT desktop app, and Claude Code Desktop.

**Expect:** research used Claude Code 2.1.302, codex-cli 0.163.0 and, in Desktop on 2026-10-15, bundled Codex 0.162.0-alpha.17.2. Other versions are fine.

**Record:** `Note "1.1" "claude <v>, codex <v>, ChatGPT app <v>, Claude Code Desktop <v>, Windows <build>, pwsh <v>, global skills-sync before: <none or path>"`

### 1.2 Account state, before

Take one screenshot of the page where Plugins are switched on for the Claude account (`https://claude.ai/customize/plugins`) and one of the ChatGPT account's Plugin settings. Save them as `$Evidence\shots\1.2-claude-account-before.png` and `$Evidence\shots\1.2-chatgpt-account-before.png`.

**Record:** `Note "1.2" "screenshots taken"`

## 2. Get the build and the launcher

The launcher is the global `skills-sync`, linked to the checkout this step builds. Use a worktree so your own checkout stays as it is.

```powershell
$Branch = "feat/209-shared-dev-plugins"   # before the orchestrator merged #215 into it, use feat/215-keep-dev-selection-during-sync
git -C $Main fetch origin
git -C $Main worktree add --detach $Tools "origin/$Branch"
git -C $Tools rev-parse HEAD
Set-Location $Tools
pnpm install --frozen-lockfile
pnpm skills:dev:launcher
Get-Command skills-sync | Format-List Source
npm ls --global --depth=0 @oneezy/skills-sync
(Get-Content "$Tools\packages\skills-sync\package.json" | ConvertFrom-Json).version
pnpm skills:dev:build play
Select-String -Path "$Lib\dist\development\plugins\play\NOTICE.md" -Pattern "development build"
```

**Expect:**

- `rev-parse` prints the commit under test.
- `npm ls` shows `@oneezy/skills-sync@0.17.0` linked to `$Tools\packages\skills-sync`.
- The build prints `built play dist/development/plugins/play` and `develop build: 1 built, 0 unchanged, 0 stale, 0 failed`.
- NOTICE.md says `a development build, not a release`.

**Record:** `Note "2" "commit <sha>, skills-sync <v>, build <result>"`

## 3. Make the projects

P1 and P2 take part. N is the ordinary project. All three are git repositories.

```powershell
foreach ($p in $P1, $P2, $N) {
  New-Item -ItemType Directory -Force $p | Out-Null
  git -C $p init -q
  Set-Content "$p\README.md" "# $(Split-Path $p -Leaf)"
  git -C $p add README.md
  git -C $p commit -q -m init
}
```

**Codex trust.** In the ChatGPT desktop app, open P1, P2 and N as projects, and accept the trust question for each. Then:

```powershell
Select-String -Path "$CodexHome\config.toml" -Pattern "proof-217" -Context 0,1
```

**Expect:** three entries with `trust_level = "trusted"`. An untrusted project makes Codex ignore its `.codex\config.toml`, so trust all three.

**Claude trust.** Open N once, accept the workspace trust question, and leave. Do not open P1 or P2 in Claude Code yet: step 6 records whether a newly set-up project asks.

```powershell
Set-Location $N; claude
```

**Record:** `Note "3" "Codex trusts: <3 or fewer>; Claude N trust prompt wording: <text>"`

## 4. Where the released Play comes from, and the baseline

```powershell
Set-Location $N
claude plugin list --json | ConvertFrom-Json | Where-Object { $_.id -like "play@*" } | Format-List id, scope, enabled, projectPath
claude plugin details play
codex plugin list --json | ConvertFrom-Json | ForEach-Object installed | Where-Object { $_.pluginId -like "play@*" } | Format-List pluginId, marketplaceName, installed, enabled, version
codex plugin marketplace list --json
```

**Expect:**

- Claude: `play@synced` (scope `synced`, the claude.ai account) or `play@oneezy-skills` (scope `user`, a CLI install), or both. Both are supported (ADR-0006).
- Codex: `play@oneezy-skills`, from a Git marketplace. A `marketplaceName` of `created-by-me-remote` or `workspace-*` that is `enabled` triggers Stop rule 1. No `play` row at all is fine.

**Record:** `Note "4.1" "Claude origin: <ids and scopes>; Codex origin: <marketplaceName, enabled>"`

Back up the user files, which you restore from only if something goes wrong (never put `backup\` in the evidence zip), and take the baseline.

```powershell
New-Item -ItemType Directory -Force "$Evidence\backup" | Out-Null
foreach ($f in "$CodexHome\config.toml", "$CodexHome\hooks.json", "$ClaudeHome\settings.json", "$ClaudeHome\plugins\installed_plugins.json", "$ClaudeHome\plugins\known_marketplaces.json") {
  if (Test-Path $f) { Copy-Item $f "$Evidence\backup\$(Split-Path $f -Leaf)" }
}
Snap "00-baseline"
```

**Record:** `Note "4.2" "baseline snap taken"`

## 5. Switch on in P1 and P2 (criteria 1, 2)

### 5.1 Preview

```powershell
Set-Location $P1
skills-sync develop setup play --repo $Lib --plan
"exit $LASTEXITCODE"
Test-Path "$P1\.agents"
```

**Expect:** exit 0. The plan shows a link for `.agents\skills-library`, the exclude block, and preview lines starting `claude-code:` and `codex:`. It does not print `not activated: its adapter is not verified`. `Test-Path` prints `False`: a plan writes nothing.

### 5.2 Set up

```powershell
Set-Location $P1; skills-sync develop setup play --repo $Lib; "exit $LASTEXITCODE"
Set-Location $P2; skills-sync develop setup play --repo $Lib; "exit $LASTEXITCODE"
```

**Expect:** both exit 0. P1 prints:

- a `claude-code:` line ending `play@oneezy-skills-development on in this project, <released ids> off here only; installed is not loaded: ...`;
- a `codex:` line `codex plugin add play@oneezy-skills-dev; on for every project for <N> ms, until switched off again in ...config.toml`, then `codex: play@oneezy-skills-dev on in this project, play@oneezy-skills off; restart the ChatGPT desktop app ...`;
- a final line `Development project of ... with play; ... Activated in claude-code, codex`.

P2 may print `already active here` for Codex because the cached copy matches the build.

**Record:** `Note "5.2" "exits <0 0>; re-enable window <N> ms; restart note: <text>"` The window is the open decision in ADR-0007: the development copy is on for every project for that long.

### 5.3 What changed on disk

```powershell
Get-Content "$P1\.claude\settings.local.json"
Get-Content "$P1\.codex\config.toml"
Get-Content "$P1\.agents\skills-sync-project.json"
(Get-Item "$P1\.agents\skills-library").LinkType
Get-Content "$P1\.git\info\exclude"
git -C $P1 status --porcelain --untracked-files=all
Select-String -Path "$CodexHome\config.toml" -Pattern "oneezy-skills-dev" -Context 0,2
```

**Expect:**

- `settings.local.json`: `enabledPlugins` holds `"play@oneezy-skills-development": true` and each released id from step 4 as `false`; `extraKnownMarketplaces."oneezy-skills-development"` is a `directory` source at `$Lib\dist\development`.
- `.codex\config.toml`: a block between `# skills-sync:development-plugins:start` and `:end` with `[plugins."play@oneezy-skills-dev"] enabled = true` and `[plugins."play@oneezy-skills"] enabled = false`.
- The user `config.toml` holds `[marketplaces.oneezy-skills-dev]` and `[plugins."play@oneezy-skills-dev"]` with `enabled = false`.
- `LinkType` is `Junction` or `SymbolicLink`.
- The exclude block lists `/.agents/skills-library`, `/.agents/skills-sync-project.json`, `/.claude/settings.local.json` and `/.codex/config.toml`.
- `git status` prints nothing.

**Record:** `Note "5.3" "LinkType <kind>; files as expected: <yes or what differs>; git status clean: <yes/no>"`

### 5.4 Status

```powershell
Set-Location $P1
skills-sync develop status; "exit $LASTEXITCODE"
skills-sync develop status --json > "$Evidence\status-P1-after-setup.json"
Set-Location $N
skills-sync develop status; "exit $LASTEXITCODE"
```

**Expect:** in P1, exit 0, the `source alias ... ok`, `plugin play: development build ok`, `claude-code: installed (...)`, `codex: active (...)` (`stale` or `released copy loaded` are findings), the watcher `stopped (never started ...)`, and P1 and P2 under `Projects connected`. In N: `not a Development project: released Plugins only`, exit 0.

**Record:** `Note "5.4" "P1 states: claude-code <state>, codex <state>"`

### 5.5 What setup left alone

```powershell
Snap "10-after-setup"
SnapDiff "00-baseline" "10-after-setup"
```

**Expect:**

- Changed: `claude-plugins-P1.json` and `claude-plugins-P2.json` (a local dev row, released rows `enabled: false`), `claude-marketplaces.json`, `codex-plugins.json`, `codex-marketplaces.json`, the user `config.toml`, Claude's `installed_plugins.json` and `known_marketplaces.json`, and the new P1 and P2 project files.
- `claude-plugins-N.json` gains at most the dev row with `enabled: false` (the research saw it listed so), and the released rows stay `enabled: true`.
- Unchanged: `$ClaudeHome\settings.json`, `hooks.json`, and every `synced` and `created-by-me-remote` row.

**Record:** `Note "5.5" "unexpected differences: <none or list>"`

## 6. Which copy loads (criteria 1, 2)

Write one `Note` per Harness and project. Which copy loaded is proven by `Source:`, by the file path of the skill, and, after step 7, by the markers that only the development build has.

### 6.1 Claude Code CLI

Open P1, then P2, then N in a new window each. Watch for the workspace trust question in P1 and P2 and screenshot its exact wording as `shots\6.1-claude-trust-P1.png`.

```powershell
Set-Location $P1; claude    # run one line per window, and leave the P1 chat open
Set-Location $P2; claude
Set-Location $N; claude
```

In the chat:

```text
/plugin
/play:hi
```

In the main window:

```powershell
foreach ($p in $P1, $P2, $N) {
  Set-Location $p; "== $p"
  claude plugin details play
  claude plugin list --json | ConvertFrom-Json | Where-Object { $_.id -like "play@*" } | Format-List id, scope, enabled, projectPath
}
```

**Expect:**

- P1 and P2: `Source: play@oneezy-skills-development`. The dev row is `scope: local` with that project's `projectPath` and `enabled: true`. The released rows are still listed (still installed) with `enabled: false`.
- In `/plugin`, Play from `oneezy-skills-development` is enabled, the released Play is disabled or not loaded (if its origin is `synced`, the chat reports it not loaded), and the Errors tab has no same-name or hooks note. Only one `play:*` skill set is offered.
- `/play:hi` answers with a first line `# What up chinchilla ?!`.
- N: `Source:` is the released copy (`play@synced` or `play@oneezy-skills`), and the dev row is `enabled: false`. `/play:hi` is the released text, or `hi` does not exist there. Record which.
- An unrelated Plugin (such as `oneezy`) is listed `enabled: true` in P1, P2 and N, and its skills complete after typing `/oneezy:`.

**Record:** `Note "6.1" "trust prompt: <wording or none>; P1 <source>; P2 <source>; N <source>; unrelated plugin ok: <yes/no>"`

Keep the P1 chat open for step 7.

### 6.2 Claude Code Desktop

Open P1 in Claude Code Desktop and repeat `/plugin` and `/play:hi`. Then open P1 again with Desktop's worktree option and repeat them. Open N and repeat them.

**Expect:** the same as 6.1 in P1 and N. Record which copy loads in the Desktop worktree (the docs say it reads the main checkout's project settings; this is unproven).

**Record:** `Note "6.2" "Desktop P1 <source>; Desktop worktree <source>; Desktop N <source>"`

### 6.3 Codex in the ChatGPT desktop app

Quit the ChatGPT desktop app completely (tray icon included) and start it. Open a new chat in P1, then P2, then N. In each, type:

```text
List every skill you can see whose name starts with play:, with the file path of each SKILL.md.
```

Then in the P1 and P2 chats:

```text
$play:hi
```

Cross-check with the CLI. It reads the same config, but the app may not agree (step 13, question 9):

```powershell
foreach ($p in $P1, $P2, $N) { "== $p"; codex -C $p debug prompt-input | Select-String "play:" }
foreach ($p in $P1, $P2, $N) { "== $p"; codex -C $p debug prompt-input | Select-String -Pattern "^\s*- [a-z0-9-]+:[a-z0-9-]+:" | Where-Object { $_.Line -notmatch "^\s*- play:" } | Measure-Object | ForEach-Object Count }
codex plugin list --json | ConvertFrom-Json | ForEach-Object installed | Where-Object { $_.name -eq "play" } | Format-List pluginId, installed, enabled
Set-Location $P1; skills-sync develop status
```

**Expect:**

- P1 and P2: one `play:*` set, from `...\cache\oneezy-skills-dev\play\...`, and `$play:hi` answers with the first line `# What up chinchilla ?!`.
- N: only the released set (path under `...\cache\oneezy-skills\play\...`), or none.
- The second `foreach` prints the same count for P1, P2 and N (unrelated Plugins unchanged).
- The Plugin list still has `play@oneezy-skills` `installed: true`, and `play@oneezy-skills-dev` `enabled: false` (the user switch).
- `develop status` shows `codex: active`.

**Record:** `Note "6.3" "app P1 <sets and path>; app P2 <...>; app N <...>; CLI agrees with app: <yes/no>; status <state>"`

### 6.4 Inactive entries that stay visible

In the ChatGPT desktop app, open the Plugins Directory. In Claude Code, open `/plugin` and its marketplaces list. Screenshot both as `shots\6.4-codex-directory.png` and `shots\6.4-claude-plugin.png`.

```powershell
claude plugin marketplace list --json
```

**Expect:** the spec allows inactive entries but no competing active one. Record exactly which of these appear: `play@oneezy-skills-dev` in Codex's directory in N and elsewhere, the released `play` in P1, `oneezy-skills-development` in Claude's marketplace list in N.

**Record:** `Note "6.4" "visible but inactive: <list>; anything active that competes: <none or what>"`

## 7. Edit, build, reload with one watcher (criteria 1, 3)

### 7.1 Start the watcher in its own terminal

Open a new Windows Terminal tab, call it W1, paste the prelude, and run:

```powershell
Set-Location $P1
skills-sync develop watch
```

**Expect:** `Watching <lib> for 2 connected projects. This terminal owns the watcher (pid <N>); Ctrl+C or closing the terminal stops it.`, then `<time> build 1: play unchanged`. It stays running.

In your main window:

```powershell
Get-Content "$Lib\dist\development\watcher.json"
```

**Expect:** `state` is `running`, `terminal` is `Windows Terminal`, `project` is P1.

**Record:** `Note "7.1" "watcher pid <N>, first line: <text>"`

### 7.2 A second launch reuses it

```powershell
Set-Location $P2
skills-sync develop watch; "exit $LASTEXITCODE"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "develop\s+watch" } | Select-Object ProcessId, ParentProcessId, CommandLine
```

**Expect:** it returns at once with `The watcher for <lib> already runs: pid <N>, started <time> from <P1> (Windows Terminal). ...`, exit 0. Exactly one `node` process runs `develop watch`, and its id is the pid in W1.

**Record:** `Note "7.2" "second launch printed owner pid <N>, exit 0, node watchers: <count>"`

### 7.3 One source, edited through either project

Edit through P1's alias, then through P2's. Both edit `$Lib\skills\play\hi\SKILL.md`.

```powershell
$f1 = "$P1\.agents\skills-library\skills\play\hi\SKILL.md"
(Get-Content $f1 -Raw) -replace '# What up chinchilla \?!', '# What up chinchilla ?! edit-1-via-P1' | Set-Content $f1 -NoNewline
Start-Sleep 3
git -C $Tools diff --stat
Select-String "edit-1-via-P1" "$Lib\skills\play\hi\SKILL.md", "$P2\.agents\skills-library\skills\play\hi\SKILL.md", "$Lib\dist\development\plugins\play\skills\hi\SKILL.md"

$f2 = "$P2\.agents\skills-library\skills\play\hi\SKILL.md"
(Get-Content $f2 -Raw) -replace 'edit-1-via-P1', 'edit-1-via-P1 edit-2-via-P2' | Set-Content $f2 -NoNewline
Start-Sleep 3
Select-String "edit-2-via-P2" "$Lib\skills\play\hi\SKILL.md", "$P1\.agents\skills-library\skills\play\hi\SKILL.md", "$Lib\dist\development\plugins\play\skills\hi\SKILL.md"
$out = "$Lib\dist\development\plugins\play\skills\hi\SKILL.md"
$goodHash = (Get-FileHash $out).Hash; $goodHash
```

**Expect:**

- W1 prints exactly one new line per edit: `build 2: play built`, then `build 3: play built`.
- `git diff --stat` shows one file, `packages/skills/skills/play/hi/SKILL.md`.
- Every `Select-String` finds the marker in the source, in the other project's alias and in the build output.

**Record:** `Note "7.3" "builds printed: <lines>; diff files: <n>; markers in source, both aliases and output: <yes/no>"`

### 7.4 Unchanged saves do nothing

```powershell
Set-Content $f1 (Get-Content $f1 -Raw) -NoNewline
(Get-Item $f1).LastWriteTime = Get-Date
Start-Sleep 5
```

Then open the file in each editor, save with Ctrl+S without changing it, and wait five seconds:

```powershell
code "$P2\.agents\skills-library\skills\play\hi\SKILL.md"
notepad "$P1\.agents\skills-library\skills\play\hi\SKILL.md"
```

Then in each editor, add this text at the end of the file and save. Remove it and save again after the check:

```text
editor-edit
```

**Expect:** W1 prints no line for the identical saves or the touched timestamp. Each real edit prints exactly one `build n: play built` line, whichever editor saved it (this includes any temp-file-then-rename save).

**Record:** `Note "7.4" "identical saves printed <0 lines>; VS Code edit <n lines>; Notepad edit <n lines>"`

### 7.5 Structural edits

```powershell
$d = "$P1\.agents\skills-library\skills\play"
New-Item -ItemType Directory "$d\play-hi-two" | Out-Null
Set-Content "$d\play-hi-two\SKILL.md" "---`nname: play-hi-two`ndescription: Proof skill for the Windows runbook.`n---`n`nBegin the response with: # hi two`n"
Start-Sleep 3
Test-Path "$Lib\dist\development\plugins\play\skills\play-hi-two\SKILL.md"
Set-Content "$d\play-hi-two\notes.txt" "supporting file"
Start-Sleep 3
Test-Path "$Lib\dist\development\plugins\play\skills\play-hi-two\notes.txt"
Rename-Item "$d\play-hi-two\notes.txt" "notes2.txt"
Start-Sleep 3
Get-ChildItem "$Lib\dist\development\plugins\play\skills\play-hi-two" | Select-Object Name
Remove-Item "$d\play-hi-two" -Recurse
Start-Sleep 3
Test-Path "$Lib\dist\development\plugins\play\skills\play-hi-two"
```

**Expect:** `True`, `True`, a listing with `SKILL.md` and `notes2.txt` only, then `False`. W1 prints one `built` line after each step.

**Record:** `Note "7.5" "add, supporting file, rename, remove reflected: <yes/no each>"`

### 7.6 Reload (criterion 1: invocation changes in both Harnesses)

Source edited, output built, Plugin installed and chat loaded are four states. Check each.

**Claude Code.** Use the P1 chat left open in step 6.1.

```text
/play:hi
```

**Expect (before reload):** the old first line `# What up chinchilla ?!`, with no markers. The build is done, but the chat has not loaded it.

```text
/reload-plugins
/play:hi
```

**Expect (after):** `/reload-plugins` prints a `Reloaded: ...` line, and `/play:hi` starts with `# What up chinchilla ?! edit-1-via-P1 edit-2-via-P2`. Then start a new chat in P2: the same marker. Start a new chat in N: no marker. Repeat in Claude Code Desktop.

**Codex.** The watcher builds; it does not touch Codex's cache copy.

```powershell
Set-Location $P1
skills-sync develop status
skills-sync develop setup
```

**Expect:** the first `develop status` says `codex: stale` (the cached copy is not the latest build). `develop setup` adds the rebuilt copy again, prints a new `on for every project for <N> ms` window, and says to restart the app. If it prints `build refused: another development build is writing`, run it again.

Without restarting the app, open a new chat in P1:

```text
$play:hi
```

Record whether the markers show. Then quit and restart the app, open new chats in P1, P2 and N, and run it again.

```powershell
Get-ChildItem "$CodexHome\plugins\cache\oneezy-skills-dev\play" | Select-Object Name
Set-Location $P1; skills-sync develop status
```

**Expect:** after the restart, P1 and P2 answer with both markers and N has none. `develop status` shows `codex: active`. The cache folder is named after the Plugin's version (the CLI) or `local` (the docs say so). Record which.

**Record:** `Note "7.6" "Claude CLI before <...> after /reload-plugins <...> new chat <...>; Desktop <...>; Codex status <stale?>, new chat without restart <markers?>, after restart <markers?>; window <N> ms; cache folder <name>"`

### 7.7 A later build failure keeps the last good build, and fixing it recovers

```powershell
$f = "$P1\.agents\skills-library\skills\play\hi\SKILL.md"
Copy-Item $f "$Evidence\hi-good.md"
$goodHash = (Get-FileHash $out).Hash
(Get-Content $f -Raw) -replace '(?m)^name:.*$', 'name: wrong-name' | Set-Content $f -NoNewline
Start-Sleep 4
(Get-FileHash $out).Hash -eq $goodHash
Set-Location $P1; skills-sync develop status; "exit $LASTEXITCODE"
```

Start a new Claude Code chat in P1 and type `/play:hi`. Then fix it:

```powershell
Copy-Item "$Evidence\hi-good.md" $f -Force
Start-Sleep 4
(Get-FileHash $out).Hash -eq $goodHash
```

**Expect:**

- W1 prints `build n: play stale` and `  ! play: skills/play/hi/SKILL.md: name: wrong-name is not the folder's name, hi`.
- The hash comparison prints `True`: the last good output is untouched.
- `develop status` shows `plugin play: development build stale`.
- The new chat still answers with the markers. It does not fall back to the released copy.
- After the fix, W1 prints `build n: play built` and the hash comparison prints `True`.

**Record:** `Note "7.7" "stale line: <text>; output kept: <yes/no>; chat still dev: <yes/no>; recovery line: <text>"`

### 7.8 A held file during the swap

```powershell
$held = [System.IO.File]::Open($out, "Open", "Read", "Read")
(Get-Content $f -Raw) -replace 'edit-2-via-P2', 'edit-3-held' | Set-Content $f -NoNewline
Start-Sleep 6
Set-Location $P1; skills-sync develop status
$held.Dispose()
Start-Sleep 6
Select-String "edit-3-held" $out
Copy-Item "$Evidence\hi-good.md" $f -Force
Start-Sleep 4
```

**Expect:** with the handle held, W1 prints `play stale` and `! play: writing the output failed ...` and retries each heartbeat. Status shows `stale`. After `Dispose`, a `built` line follows within a few seconds and the marker is found. If the swap succeeds despite the handle, that is the finding. The last copy puts the source back to both markers.

**Record:** `Note "7.8" "held-file result: <stale with the error | swap succeeded>; landed after release: <yes/no>"`

## 8. Watcher lifecycle (criterion 3)

### 8.1 Ctrl+C, then stopped status

In W1 press Ctrl+C, then in W1 run `"exit $LASTEXITCODE"`. In the main window:

```powershell
Get-Content "$Lib\dist\development\watcher.json" | ConvertFrom-Json | Select-Object state, stopReason, stoppedAt
Set-Location $P1; skills-sync develop status
(Get-FileHash $out).Hash -eq $goodHash
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "develop\s+watch" } | Measure-Object | ForEach-Object Count
```

**Expect:** W1 prints `Watcher stopped: SIGINT (Ctrl+C or a stop request). The last successful builds stay in place; ...` and returns to the prompt, and the exit code is 0. `state` is `stopped`. `develop status` prints `Development watcher: stopped (stopped <time> (SIGINT ...)); edits are not built until develop watch runs again`. The hash comparison prints `True`, and the process count is `0`. A new Claude chat in P1 still loads the development copy.

**Record:** `Note "8.1" "stop line: <text>; status: <text>; processes left: <n>"`

### 8.2 Restart catches up on edits made while stopped

```powershell
$f1 = "$P1\.agents\skills-library\skills\play\hi\SKILL.md"
(Get-Content $f1 -Raw) -replace 'edit-2-via-P2', 'edit-2-via-P2 edit-4-while-stopped' | Set-Content $f1 -NoNewline
Start-Sleep 3
Select-String "edit-4-while-stopped" $out
Set-Location $P1; skills-sync develop status
```

**Expect:** `Select-String` finds nothing. Status says `not built yet: play; develop watch builds them as it starts`. Now in W1:

```powershell
Set-Location $P1; skills-sync develop watch
```

**Expect:** the first line after `Watching ...` is `build 1: play built`, and the marker is in the output.

**Record:** `Note "8.2" "behind line: <text>; catch-up line: <text>"`

### 8.3 Ctrl+Break

In W1 press Ctrl+C, run the watcher again, then press Ctrl+Break:

```powershell
Set-Location $P1; skills-sync develop watch
```

**Expect:** `Watcher stopped: SIGBREAK (Ctrl+C or a stop request)...`, exit 0.

**Record:** `Note "8.3" "<line>"`

### 8.4 Closing the terminal: three windows, then a killed parent

For each variant, start the watcher, close the window with its X button, wait, and run the check from a surviving window. Start them with these commands:

```powershell
# Variant A: a Windows Terminal tab. Open a new tab, paste the prelude, then run:
Set-Location $P1; skills-sync develop watch
```

```powershell
# Variant B: the same tab, through pnpm (pnpm, then a cmd shim, then node). Wait for "Watching ...", which follows a frozen refresh.
Set-Location $Tools; pnpm skills:dev:watch
```

```powershell
# Variant C: a plain console window, outside Windows Terminal. Run this, then in the new window run: skills-sync develop watch
Start-Process conhost.exe -ArgumentList "pwsh.exe", "-NoExit", "-WorkingDirectory", $P1
```

Check after closing each window (wait 8 seconds first):

```powershell
Start-Sleep 8
Get-Content "$Lib\dist\development\watcher.json" | ConvertFrom-Json | Select-Object state, pid, stopReason
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "develop\s+watch" } | Select-Object ProcessId, CommandLine
Set-Location $P1; skills-sync develop status
```

**Expect (any of two outcomes per variant, both pass, record which):**

- `state` is `stopped` with `stopReason` `its terminal closed`.
- `state` is still `running` for a dead pid, and `develop status` prints `stopped (its owner (pid <N>) ended without stopping)`. This is expected for variant B, where pnpm's job ends the watcher first (ADR-0005).

In both, no `develop watch` node process survives, and the build output is untouched. The next launch owns the watcher afresh.

Variant D, a killed parent. Start a child window, run the watcher in it, then from the main window:

```powershell
Start-Process pwsh -ArgumentList "-NoExit", "-WorkingDirectory", $P1
# in the new window: skills-sync develop watch
$w = Get-Content "$Lib\dist\development\watcher.json" | ConvertFrom-Json
Stop-Process -Id $w.ppid -Force
Start-Sleep 6
Get-Content "$Lib\dist\development\watcher.json" | ConvertFrom-Json | Select-Object state, stopReason
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "develop\s+watch" } | Measure-Object | ForEach-Object Count
```

**Expect:** the watcher is gone within one 2-second heartbeat of its parent dying, with `stopReason` `its terminal closed`, or the console's closing took it first. The process count is `0`.

**Record:** `Note "8.4" "A <stopped/running+dead>, B <...>, C <...>, D <...>; stray node processes: <n>"`

### 8.5 Sleep (optional)

Start the watcher in W1, sleep the PC for one minute, wake it, then in another window run:

```powershell
Set-Location $P2; skills-sync develop watch; "exit $LASTEXITCODE"
```

**Expect:** it names the existing owner and exits 0, unless the owner missed more than five heartbeats. Then W1 ends with `another watcher started while this one was not beating`.

**Record:** `Note "8.5" "<which>"`

Stop the watcher with Ctrl+C before step 9.

## 9. First-build failure leaves the project alone (criterion 3)

`trident` has no build yet, so a broken skill there has no earlier output. Run this with the watcher stopped.

```powershell
$tdir = Get-ChildItem "$Lib\skills\trident" -Directory | Select-Object -First 1
$tf = Join-Path $tdir.FullName "SKILL.md"
Copy-Item $tf "$Evidence\trident-skill-good.md"
(Get-Content $tf -Raw) -replace '(?m)^name:.*$', 'name: wrong-name' | Set-Content $tf -NoNewline
Set-Location $Lib
skills-sync develop build trident --repo $Lib; "exit $LASTEXITCODE"
Test-Path "$Lib\dist\development\plugins\trident"

Snap "20-before-first-failure"
Set-Location $P1
skills-sync develop setup play trident --repo $Lib; "exit $LASTEXITCODE"
Snap "21-after-first-failure"
SnapDiff "20-before-first-failure" "21-after-first-failure"
skills-sync develop status
```

**Expect:**

- `develop build` prints `failed trident ... (nothing written)` and `! skills/trident/<skill>/SKILL.md: name: wrong-name is not the folder's name, <skill>`, ends `0 built, 0 unchanged, 0 stale, 1 failed`, exit 1. `Test-Path` prints `False`.
- `develop setup` exits 1 with a conflict `trident: development build failed: ...; nothing activated`.
- `SnapDiff` prints no differing line for P1's files, the user files or the plugin lists: P1's selection is still `play` and its configuration is exactly as before. A differing `status.json` or `watcher.json` hash is expected and fine.
- `develop status` still shows `claude-code: installed`, `codex: active`.

Recover:

```powershell
Copy-Item "$Evidence\trident-skill-good.md" $tf -Force
skills-sync develop build trident --repo $Lib; "exit $LASTEXITCODE"
git -C $Tools status --short
```

**Expect:** `built trident ...`, exit 0, and `git status` prints nothing.

**Record:** `Note "9" "failed build exit <1>; setup exit <1>; snapdiff empty: <yes/no>; recovery <built>"`

## 10. Ordinary sync and release packaging (criterion 4)

Use the checkout's CLI. `npx @oneezy/skills-sync@latest` may not have these changes yet. Sync is the machine sync you run every day, so its first run may update released Plugins. The check is that the Development projects and the development output stay as they were.

### 10.1 Sync from three places, twice

```powershell
Snap "30-before-sync"
foreach ($where in $HOME, $P1, $N) {
  Set-Location $where; "== $where"
  skills-sync --plan | Select-Object -Last 8
  skills-sync; "exit $LASTEXITCODE"
  skills-sync; "exit $LASTEXITCODE"
}
Snap "31-after-sync"
SnapDiff "30-before-sync" "31-after-sync" | Select-String "proof-217|dist.development|oneezy-skills-dev"
codex plugin list --json | ConvertFrom-Json | ForEach-Object installed | Where-Object { $_.pluginId -like "*oneezy-skills-dev" } | Format-List pluginId, enabled
```

**Expect:**

- Every run exits 0, and the second run of each prints `0 changed`.
- No line names `oneezy-skills-dev` or `oneezy-skills-development` with remove or uninstall. The Codex line is a note that the development copy stays.
- The `Select-String` prints nothing: P1, P2 and `dist\development` are byte-identical.
- `play@oneezy-skills-dev` is still installed with `enabled: False`.

**Record:** `Note "10.1" "exits <...>; second runs 0 changed: <yes/no>; dev lines in diff: <none or list>"`

### 10.2 The session hook

The real hook runs `npx --yes @oneezy/skills-sync@latest hook`, the published version, not this checkout.

```powershell
npm view @oneezy/skills-sync version
```

Start a new Claude Code session in P1 (the hook runs its sync), then in it:

```text
/play:hi
```

and in a second window `Set-Location $P1; claude plugin details play`. Do the same in N. Restart the ChatGPT desktop app and open new chats in P1 and N, each running `$play:hi`.

**Expect:** P1 shows `Source: play@oneezy-skills-development` and the marker; N shows the released copy and no marker, in both Harnesses. If the published version is older than `0.17.0`, the hook is not running the code under test: a pass says the old hook did no harm, and a failure is expected to be fixed by publishing.

**Record:** `Note "10.2" "published <v>; P1 claude <...>; N claude <...>; P1 codex <...>; N codex <...>"`

### 10.3 The released copy installed after setup (Codex)

Skip this when step 4 showed no `play@oneezy-skills` in Codex.

```powershell
Set-Location $P1
Snap "32-before-reinstall"
codex plugin remove play@oneezy-skills --json
skills-sync; "exit $LASTEXITCODE"
codex -C $P1 debug prompt-input | Select-String "play:"
skills-sync develop status
Snap "33-after-reinstall"
SnapDiff "32-before-reinstall" "33-after-reinstall" | Select-String "proof-217"
```

**Expect:** sync adds the released copy back (and switches it on for the user). `debug prompt-input` in P1 still lists only the development `play:*` set, `develop status` says `codex: active` (not `duplicate`), and the `Select-String` prints nothing (P1's `.codex\config.toml` is untouched). Restart the app and check a new chat in P1 lists one set.

**Record:** `Note "10.3" "P1 sets after reinstall: <n>; status <state>; app new chat <n sets>"`

### 10.4 A development copy switched on for every project

```powershell
Set-Location $P1
codex plugin add play@oneezy-skills-dev --json
skills-sync; "exit $LASTEXITCODE"
skills-sync status; "exit $LASTEXITCODE"
skills-sync develop status
skills-sync develop setup play --repo $Lib
skills-sync; "exit $LASTEXITCODE"
```

**Expect:**

- The first `skills-sync` exits 1 with a red line naming a development copy `on for every project` and `skills-sync develop setup`, and it changes nothing.
- `skills-sync status` lists the manual step `Switch the Codex development copies off outside Development projects`, and never proposes `codex plugin remove play@oneezy-skills-dev`.
- `develop status` says `codex: on everywhere`.
- After `develop setup`, the next `skills-sync` exits 0.

**Record:** `Note "10.4" "sync exit <1>; status step: <text>; develop status: <state>; after setup sync exit <0>"`

### 10.5 Release packaging

```powershell
Set-Location $Lib
Snap "40-before-release"
skills-sync build --repo . --plugins --catalogs; "exit $LASTEXITCODE"
skills-sync build --repo . --artifacts; "exit $LASTEXITCODE"
$ToolVersion = (Get-Content "$Tools\packages\skills-sync\package.json" | ConvertFrom-Json).version
node .github\scripts\release.mjs . --tool-version $ToolVersion --repo oneezy/skills; "exit $LASTEXITCODE"
Snap "41-after-release"
SnapDiff "40-before-release" "41-after-release"
git -C $Tools status --short
Select-String -Path "$Lib\artifacts\release.json" -Pattern "development"
```

None of these upload or tag anything. They write only `plugins\`, `dist\hermes\`, the two root catalogs and `artifacts\`, which git ignores.

**Expect:** three exits 0 (`release.mjs` prints `release-<n>: ...` or `no release: ...`). `SnapDiff` prints no differing line. `git status` prints nothing. `Select-String` finds nothing. Then open new chats in P1 (Claude Code and Codex): both still load the development copy.

**Record:** `Note "10.5" "exits <...>; snapdiff empty: <yes/no>; release.json mentions development: <no>; P1 still dev in both: <yes/no>"`

## 11. Switch off (criterion 5)

### 11.1 Make edits setup must keep

```powershell
$s = "$P1\.claude\settings.local.json"
$j = Get-Content $s -Raw | ConvertFrom-Json -AsHashtable
$j["model"] = "opus"
$j | ConvertTo-Json -Depth 20 | Set-Content $s
Add-Content "$P1\.codex\config.toml" "`n# runbook-217 manual line"
Set-Content "$P1\unrelated.txt" "keep me"
Add-Content "$P1\README.md" "an uncommitted edit"
git -C $Tools diff --stat
Snap "50-before-remove"
```

### 11.2 Remove from P1

```powershell
Set-Location $P1
skills-sync develop remove --plan; "exit $LASTEXITCODE"
Test-Path "$P1\.agents\skills-sync-project.json"
skills-sync develop remove; "exit $LASTEXITCODE"
skills-sync develop remove; "exit $LASTEXITCODE"
Get-Content "$P1\.claude\settings.local.json"
Get-Content "$P1\.codex\config.toml"
Test-Path "$P1\.agents"
Get-Content "$P1\.git\info\exclude"
Get-Content "$P1\unrelated.txt"
git -C $P1 status --short
git -C $Tools diff --stat
Test-Path "$Lib\dist\development\plugins\play"
```

**Expect:**

- The plan writes nothing (`Test-Path` prints `True` after it). The first remove exits 0 and prints `claude-code: released copies back in this project; ...` and `codex: back to the released copies here; restart ...`. The second prints `Not a Development project; nothing to remove`, exit 0.
- `settings.local.json` holds your `"model": "opus"` and no development or released-copy key. `.codex\config.toml` holds only your `# runbook-217 manual line`.
- `Test-Path "$P1\.agents"` prints `False`, the exclude file has no skills-sync block, `unrelated.txt` and the README edit are intact, and `git diff --stat` in `$Tools` still shows the source file you edited (the source is untouched).
- `dist\development\plugins\play` is still there: switch-off keeps the output (ADR-0008).

### 11.3 P1 is released again, P2 is not

```powershell
Set-Location $P1
claude plugin list --json | ConvertFrom-Json | Where-Object { $_.id -like "play@*" } | Format-List id, scope, enabled, projectPath
claude plugin details play
claude plugin marketplace list --json
codex -C $P1 debug prompt-input | Select-String "play:"
codex -C $P2 debug prompt-input | Select-String "play:"
```

Start a new Claude Code chat in P1 and type `/reload-plugins` in the old one, then run `/play:hi` in each. Restart the ChatGPT desktop app, then run `$play:hi` in new chats in P1 and P2.

**Expect:** P1 has no `scope: local` dev row and the released `play` is `enabled: true`; the chat answers with the released text. Codex in P1 lists the released set only (after the restart). P2 still loads the development copy in both Harnesses. `oneezy-skills-development` is still in Claude's marketplace list (the per-user, inactive entry), and the marketplace Plugins are all still installed.

**Record:** `Note "11.3" "P1 claude <source>; P1 codex <set>; P2 still dev: <yes/no>; inactive entries seen: <list>"`

### 11.4 Remove from P2: the last project leaves

```powershell
Set-Location $P2
skills-sync develop remove; "exit $LASTEXITCODE"
codex plugin list --json | ConvertFrom-Json | ForEach-Object installed | Where-Object { $_.pluginId -like "*oneezy-skills-dev" } | Measure-Object | ForEach-Object Count
codex plugin marketplace list --json | Select-String "oneezy-skills-dev"
Select-String "oneezy-skills-dev" "$CodexHome\config.toml"
Snap "60-after-remove"
SnapDiff "00-baseline" "60-after-remove"
```

**Expect:** exit 0. The Codex development rows count is `0`, the marketplace and `config.toml` no longer mention `oneezy-skills-dev`. `SnapDiff` shows only changes you can name: Claude's `known_marketplaces.json` still holds `oneezy-skills-development`, and sync may have changed the released Plugins in step 10. Everything else, the `synced` and `created-by-me-remote` rows included, matches the baseline. Restart the app: every project loads the released `play`.

**Record:** `Note "11.4" "codex dev rows <0>; remaining differences from baseline: <list>"`

### 11.5 Is a missing development output a broken marketplace? (ADR-0008 open question)

No project is set up now.

```powershell
claude plugin marketplace list --json | Select-String "oneezy-skills-development"
Rename-Item "$Lib\dist\development" "development.aside"
Set-Location $N
claude plugin list
claude plugin marketplace list --json
Rename-Item "$Lib\dist\development.aside" "development"
```

**Expect:** record whether Claude Code reports `oneezy-skills-development` as broken or missing while its folder is gone. The folder is back afterwards.

**Record:** `Note "11.5" "known after last remove: <yes/no>; broken report with the folder gone: <text or none>"`

## 12. Account and cloud preservation, final state (criterion 6)

```powershell
SnapDiff "00-baseline" "60-after-remove" | Select-String "synced|created-by-me-remote|workspace-"
git -C $Tools checkout -- packages/skills/skills/play/hi/SKILL.md
git -C $Tools status --short
git -C $Tools grep -n "proof-217" -- ":!packages/skills-sync/docs"
git -C $P1 status --short; git -C $P2 status --short
```

Then take the same two account screenshots as step 1.2: `shots\12-claude-account-after.png` and `shots\12-chatgpt-account-after.png`. Open claude.ai and ChatGPT.com in the browser and note that the Plugins you had are still switched on.

**Expect:** the first command prints nothing (no account row changed); the `git status` and `grep` print nothing (no machine path reached a tracked file); the screenshots match the earlier ones.

**Record:** `Note "12" "account rows unchanged: <yes/no>; screenshots match: <yes/no>; tracked files clean: <yes/no>"`

## 13. Open questions the research left

Answer each from the step named. Question 7 and 8 have their own procedure.

| # | Question | Where it is answered |
| --- | --- | --- |
| 1 | Where did each Harness's released `play` come from (`@synced`, a CLI install, an account or workspace copy)? | 4.1 |
| 2 | What do the workspace trust prompts say in Claude Code for a newly set-up project, and does Codex ask? | 3, 6.1 |
| 3 | Which copy loads in a Claude Code Desktop worktree? | 6.2 |
| 4 | What stays visible but inactive in each Harness's management UI? | 6.4, 11.3 |
| 5 | How long is the Codex re-enable window, and is the guarded add-then-switch-off sequence acceptable to Justin? | 5.2, 7.6 |
| 6 | Does the ChatGPT desktop app honour project `.codex\config.toml` plugin switches? | 6.3 |
| 7 | Does an add made from the app flip the user switch too? | below |
| 8 | Does the app read a repo marketplace at `<project>\.agents\plugins\marketplace.json`? | below |
| 9 | Does `codex -C <project> debug prompt-input` agree with what the app loads? | 6.3 |
| 10 | Is the Codex cache folder named after the version or `local`? | 7.6 |
| 11 | What is the minimum Codex refresh: a new chat, or an app restart? | 7.6 |
| 12 | Does a link made as a junction (or symlink) carry edits and events from VS Code and Notepad? | 5.3, 7.3, 7.4 |
| 13 | Does Claude Code report a missing `dist\development` as a broken marketplace? | 11.5 |
| 14 | Does `/reload-plugins` pick up a rebuild in a running chat? | 7.6 |

**Question 7.** Run it with at least one project set up (redo 5.2 in P1), then restore.

```powershell
Set-Location $P1
skills-sync develop setup play --repo $Lib
Select-String -Path "$CodexHome\config.toml" -Pattern 'play@oneezy-skills-dev' -Context 0,1
```

In the ChatGPT desktop app, open the Plugins Directory and install or enable `play` from the `oneezy-skills-dev` marketplace, if it offers it. Then:

```powershell
Select-String -Path "$CodexHome\config.toml" -Pattern 'play@oneezy-skills-dev' -Context 0,1
codex -C $N debug prompt-input | Select-String "play:"
skills-sync develop status
skills-sync develop setup
```

**Expect:** record whether the user switch changed from `false` to `true`, and whether N now lists the development copy (`codex: on everywhere`). The last command switches it off again.

**Question 8.**

```powershell
New-Item -ItemType Directory -Force $P3 | Out-Null
git -C $P3 init -q
New-Item -ItemType Directory -Force "$P3\.agents\plugins" | Out-Null
$c = Get-Content "$Lib\dist\development\.agents\plugins\marketplace.json" -Raw | ConvertFrom-Json
$c | Add-Member -NotePropertyName name -NotePropertyValue "proof-217-repo" -Force
$c | ConvertTo-Json -Depth 20 | Set-Content "$P3\.agents\plugins\marketplace.json"
Copy-Item "$Lib\dist\development\plugins" "$P3\plugins" -Recurse
```

Run this only while `dist\development` exists (rebuild with `pnpm skills:dev:build play` after 11.5 if it does not). In the ChatGPT desktop app open P3, trust it, restart the app, and open the Plugins Directory.

**Expect:** record whether a marketplace named `proof-217-repo` appears. If it does, that is a candidate route without the re-enable window (ADR-0007). Remove the copy afterwards: `Remove-Item $P3 -Recurse -Force`.

**Record:** `Note "13" "Q7 <...>; Q8 <...>; answers for the other questions are in their steps"`

## 14. Evidence checklist and hand-back

### 14.1 Result sheet

Everything below is already in `results.md` if each step's `Note` ran. This sheet lists what must be there, per acceptance criterion of #217.

| Criterion of #217 | Steps | Evidence files |
| --- | --- | --- |
| 1. An alias edit in either project changes the same source, the build, and invocation in both Harnesses | 5.2, 6.1 to 6.3, 7.3, 7.6 | `results.md`, transcripts, `shots\6.*`, `status-P1-after-setup.json` |
| 2. Marketplace copies stay installed but do not compete; ordinary project and unrelated Plugins normal | 5.3, 5.5, 6.1 to 6.4 | `snap-00-baseline`, `snap-10-after-setup`, `shots\6.*` |
| 3. One watcher, terminal closure, stopped and stale status, restart catch-up, unchanged save, first-build failure, later-failure recovery | 7.1, 7.2, 7.4, 7.7, 7.8, 8.1 to 8.5, 9 | transcripts, `snap-20-*`, `snap-21-*`, `hi-good.md`, `trident-skill-good.md` |
| 4. Ordinary sync and release packaging leave development selection alone | 10.1 to 10.5 | `snap-30` to `snap-41` |
| 5. Switch-off restores and preserves source, unrelated files, manual edits | 11.1 to 11.4 | `snap-50-before-remove`, `snap-60-after-remove` |
| 6. Versions, commands, observations, cloud and account preservation, inactive entries | 1.1, 1.2, 4.1, 6.4, 11.3, 12 | `results.md`, `shots\1.2-*`, `shots\12-*` |
| 7. Incomplete or unsupported cases stay open; matrix and docs | 13 and the `FAIL` and `unproven` notes | `../development-plugins-compatibility.md` filled from `results.md` |

### 14.2 Write the evidence zip and hand it back

Close every watcher window first, so no transcript stays open.

```powershell
Stop-Transcript
Get-ChildItem $Evidence -Exclude backup | Compress-Archive -DestinationPath "$Root\evidence-217.zip" -Force
Get-Item "$Root\evidence-217.zip" | Select-Object FullName, Length
Get-Content "$Evidence\results.md"
```

Look through the transcripts for anything private before you send them. Attach `evidence-217.zip` to the #217 thread in the chat, and paste `results.md` into the same message. State the commit from step 2 and every `FAIL` or `unproven` item in your own words.

On a full pass, the agent sets `verified: true` for the passing Harness in `ADAPTERS` (`src/develop-project.ts`), fills the matrix, closes #213, #214, #215 and #217, and leaves the rest open. A Stop rule stays open and goes back to Justin as the spec's decision.

### 14.3 Clean up (after the agent confirms it has the evidence)

Skip any line whose result you want to keep for a re-run.

```powershell
Remove-Item Env:\SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS
claude plugin marketplace remove oneezy-skills-development     # only now: no project is set up (ADR-0008)
Remove-Item "$Lib\dist\development" -Recurse -Force
npm uninstall --global @oneezy/skills-sync                     # only if step 1.1 showed none before
git -C $Main worktree remove $Tools --force
Remove-Item $Root -Recurse -Force
```
