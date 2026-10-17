# Skills Sync desktop rollout

Use the canonical Oneezy Skills wrapper with the published `@oneezy/skills-sync` (every caller runs `@latest`, ADR-0008; the machine commands need 0.9.0 or later). A machine takes the library from its latest release on GitHub, with no clone, no answers file and no `~/.skills-sync`: Claude Code gets the claude.ai account plugins, Codex and Hermes get plugins from GitHub, each harness's global instructions file gets one skills block and its hooks file one session-start entry. `unlink` takes all of it away again. No command here uploads ChatGPT plugins or changes schedules.

Inspect the real host first: its user profile, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `HERMES_HOME`, the installed CLIs' help and the WSL distributions. Preserve dirty author work, pins, backup trees and foreign links; the tool leaves anything it did not put there alone and names it. A held source review may use `SKILLS_SYNC_CLI` pointing to its built CLI, but is not a published rollout.

Library work (a change to the library itself) starts in a fresh clone of the approved library: run the wrapper with `refresh --frozen --repo <clone>` before any build, then capability generation/tests, `build --check` and `check`. Do not hand-edit generated plugin packages, and never reset or clean a dirty checkout. A machine rollout needs no clone.

```powershell
$script = '<skill-folder>/scripts/sync.ps1'   # or sync.sh with bash
# SKILLS_SYNC_CLI, when present, selects an explicitly reviewed local build.
pwsh -File $script --help                      # prints the actual tool version; --version is not a supported command
pwsh -File $script sync --plan --json          # the plan: no write, no plugin command that writes
if ($LASTEXITCODE) { throw 'plan conflict; preserve affected destinations' }
# Execute only the inspected, already authorized hosts.
pwsh -File $script sync --json
if ($LASTEXITCODE) { throw 'apply conflict; preserve affected destinations' }
pwsh -File $script status --json               # done is ok true and manualSteps []
if ($LASTEXITCODE) { throw 'a red line; read it' }
pwsh -File $script sync --json                 # a second run changes nothing: its actions are all = (already right)
if ($LASTEXITCODE) { throw 'repeat verification failed' }
```

For Linux/WSL use `bash <skill-folder>/scripts/sync.sh` with the same arguments. On Windows a plain `sync` also runs inside every WSL distro (`wsl.exe -l -q`), which gets its own block and hook entry; `unlink` and the Codex hook trust are per distro. Inspect and verify each native home separately.

The tool compares each harness with the latest release before it changes anything, changes only what differs, and leaves the working setup as it was when a step fails. Instruction blocks keep every byte around them, reject a doubled or broken marker pair and read back. A harness the release's `skills-sync.json` does not serve, and one not on the machine, is a note. Record exact release tags and commits, plugin versions, the block and hook state `status --json` reports, and every conflict. Preserve historical pinned skills and foreign ownership rather than claiming a migration completed.

Completion requires separate evidence for Windows Codex, Windows Claude, each selected WSL host, Hermes where it runs, and cloud delivery: `status --json` with `ok: true` and `manualSteps: []` on each, then a new session that proves actual skill loading and the available Drive connector route. A prepared handoff, source tests, or file readback alone proves none of those runtime actions. Open manual steps (`claude-plugins`, `claude-account`, `codex-trust`, `codex-other-plugins`, `adopt-or-delete`, `cloud-setup`) are reported as the tool states them, step by step. Report an absent CLI, inaccessible host, unverified plugin, duplicate or foreign skill or missing connector as a specific blocker. Hermes is verified through the tool's own `hermes plugins list` output and the files in Hermes's home; an agent never launches Hermes to test it, and the steps to run inside Hermes are Justin's.
