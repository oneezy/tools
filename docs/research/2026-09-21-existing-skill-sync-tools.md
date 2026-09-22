# Existing skill sync tools for Claude Code and Codex

Ticket: [#3](https://github.com/oneezy/tools/issues/3) (part of map [#1](https://github.com/oneezy/tools/issues/1)). Date: 2026-09-21.

## Question

Does an existing, maintained tool already take one canonical bare-spec skills folder and deliver it into the Claude Code and Codex layouts on every host, so that skills-sync need not be built? Specifically: which CLI wrote this repo's `skills-lock.json`, what does it cover, what do other multi-harness installers cover, is Tailscale (or Syncthing, or git) the right transport to remote hosts, and what gap would a homegrown tool still fill?

## Summary

1. `skills-lock.json` is written by `npx skills` (npm package `skills`, repo `vercel-labs/skills`, v1.7.0, MIT, 32k stars, last push 2026-09-18). Its project layout is exactly this repo's: canonical copies in `.agents/skills/`, symlinks (Windows: junctions) from `.claude/skills/`, `.goose/skills/`, `.hermes/skills/`; Codex reads `.agents/skills` directly. The lock is the project lock (`version: 1`, `computedHash` = SHA-256 of folder contents); the user-scope lock is a different file (`~/.agents/.skill-lock.json`, v3).
2. It covers Claude Code and Codex natively at both project and user scope, has `update`, and reads Claude plugin manifests as a skill source; but its lockfile restore (`experimental_install`) only rebuilds `.agents/skills/`, never `.claude/skills/`, and its Codex user-scope target (`~/.codex/skills`) is a location Codex now marks deprecated.
3. `gh skill` (GitHub CLI 2.101, preview) is the only other first-party candidate: Claude Code and Codex both covered, project and user scope, copies only, provenance in SKILL.md frontmatter, `--pin`, no lockfile, no symlinks. Community tools (agent-skills-cli, skills-manager, tech-leads-club, dhruvwill) are copy-based, registry-bound, or GUI-first.
4. Tailscale is connectivity, not sync: Taildrop moves single files, Taildrive (alpha) shares folders over WebDAV, Tailscale SSH gives identity-based SSH/SFTP. Syncthing is real continuous sync but needs a daemon per host, does not sync symlinks on Windows, and cannot reach a cloud sandbox. Git is the only transport every host in scope already has, and it is what both Claude Code cloud and Codex load repo-scoped skills from.
5. Nothing off the shelf does "one folder in, both harness layouts out, on every host" as one step. The remaining gap is small and specific: a restore step that also rebuilds the `.claude/skills` layer on a fresh host, a symlink-vs-copy policy that survives a git commit from Windows, and a user-scope story (`~/.claude/skills` + `~/.agents/skills`) that `npx skills` half covers.

## Candidates

| Tool | Harnesses covered | Scope | Symlink / copy | Lockfile | Plugins | Maintained? |
|---|---|---|---|---|---|---|
| `npx skills` (vercel-labs/skills, npm `skills` 1.7.0) | Claude Code (`.claude/skills`, `~/.claude/skills`), Codex (`.agents/skills`, `~/.codex/skills`), Goose, Hermes, "75 more" incl. a `universal` target | Project (default) or `-g` user | Default: copy to canonical `.agents/skills/<name>` then symlink per agent; Windows uses junctions; `--copy` for independent copies; falls back to copy if the link fails | Project `skills-lock.json` v1 (`source`, `sourceType`, `skillPath`, `computedHash`); user `~/.agents/.skill-lock.json` v3 (GitHub tree SHA, timestamps) | Reads `.claude-plugin/marketplace.json` / `plugin.json` as skill sources; does not install Claude plugins | Yes: pushed 2026-09-18, MIT, 32k stars |
| `gh skill` (cli/cli 2.101.0, preview) | Copilot, Claude Code (`.claude/skills` both scopes), Codex (`.agents/skills` both scopes), Cursor, Gemini, Antigravity, Amp, Cline, and more | `--scope project` (default) or `user`; `--dir` override | Copy only (files fetched from the GitHub tree; no symlink code path) | None; provenance (repo, tree SHA) injected into SKILL.md frontmatter; `--pin` to tag/SHA; `gh skill update --all` | None | Yes: shipped 2026-04-16, in GitHub CLI releases |
| agent-skills-cli (Karanjot786, npm `agent-skills-cli`) | Claude Code, Codex (`.codex/skills`, `~/.codex/skills`), Cursor, Copilot, Antigravity, "+32" | Project or `-g` | Copy | `~/.skills/skills.lock` (user-global only) | None | Weak: 181 stars, last push 2026-05-17; Codex path is the deprecated one |
| skills-manager (xingkongliang) | 54 tools incl. Claude Code, Codex, Goose, Hermes | Global per agent and project workspaces | Symlink or copy per operation | None documented | None | Yes: 4.9k stars, pushed 2026-09-17; desktop app first, CLI (`--json`) secondary, library root `~/.skills-manager` |
| @tech-leads-club/agent-skills | Claude Code, Codex, 17 more | Project or `-g` | Copy default, `--symlink` opt-in | "atomic lockfile" | MCP catalog server | Yes: 6.6k stars, pushed 2026-09-20; installs only from its own CDN registry |
| @dhruvwill/skills-cli | Claude Code, Cursor, Gemini, Copilot, OpenCode, Windsurf, Antigravity (no Codex) | User only (`~/.skills/store` to `~/<agent>/skills`) | Copy | None | None | No: 14 stars, 10 commits, last push 2026-01-16, requires Bun |

### How `npx skills` produced this repo's layout

- `local-lock.ts`: `LOCAL_LOCK_FILE = 'skills-lock.json'`, `CURRENT_VERSION = 1`, entries `{source, sourceType, skillPath?, computedHash, ...}`; "This file is meant to be checked into version control"; `computedHash` is "SHA-256 hash computed from all files in the skill folder". Matches the 38 entries here (`source: "mattpocock/skills"`, `sourceType: "github"`). The two entries present in `.agents/skills` but absent from the lock (`oneezy-merge`, `oneezy-status`) were not installed by the CLI.
- `installer.ts`: "Canonical location: `.agents/skills/<skill-name>`"; symlink mode is "copy to canonical location and symlink to agent location"; `symlinkType = platform() === 'win32' ? 'junction' : undefined`; universal agents (any whose `skillsDir === '.agents/skills'`, Codex included) "always use the canonical directory, which prevents redundant symlinks".
- `agents.ts`: `claude-code` -> `.claude/skills` / `~/.claude/skills`; `codex` -> `.agents/skills` / `$CODEX_HOME/skills` (default `~/.codex/skills`); `goose` -> `.goose/skills`; `hermes-agent` -> `.hermes/skills`.
- `update.ts`: for project skills, re-clones the source and compares `computeSkillFolderHash` of the fresh clone with the lock's `computedHash`; user-scope updates compare GitHub tree SHAs.
- `install.ts` (`experimental_install`): "Only installs to `.agents/skills/` (universal agents) -- the canonical project-level location. Does not install to agent-specific directories." So a restore on a fresh host does not recreate `.claude/skills`.
- Observed state in this repo: 40 folders under `.agents/skills`, 27 under `.claude/skills`, 13 skills (`claude-handoff`, `git-guardrails-claude-code`, `implement-spec`, `loop-me`, `migrate-to-shoehorn`, `pr`, `retro`, `scaffold-exercises`, `setup-pre-commit`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`) have no Claude Code entry at all. In the git index the `.claude/.goose/.hermes` entries are ordinary files (mode `100644`), not symlinks (`120000`): git on Windows sees a junction as a directory and commits its contents as copies. Any Linux/WSL clone therefore gets duplicated files, not links, and `npx skills` there will treat them as independent copies.
- The upstream README's own install path is `npx skills@latest add mattpocock/skills`, updated with `npx skills update`; for Claude Code alone it offers `claude plugins install mattpocock-skills` (a plugin, namespaced `/mattpocock-skills:<name>`).

### Where each harness actually reads skills (for the target layout)

- Claude Code: enterprise > personal `~/.claude/skills` > project `.claude/skills` > nested > `--add-dir` > plugins (namespaced). "A `<skill-name>` entry can be a symlink to a directory elsewhere on disk. Claude Code reads `SKILL.md` from the target and loads the skill once even if several locations point at the same target." `synced` is reserved for claude.ai account skills. Cloud and Cowork sessions "don't read `~/.claude/skills/` on your machine"; a repo's `.claude/skills/` is "Part of the clone".
- Codex (`codex-rs/ext/skills/src/host_roots.rs`): repo scope walks `.agents/skills` from the project root down to cwd, plus the project config folder's `skills` (`.codex/skills`); user scope is `~/.agents/skills` plus `$CODEX_HOME/skills`, the latter commented "Deprecated user skills location (`$CODEX_HOME/skills`), kept for backward compatibility"; admin is `/etc/codex/skills`; plugin skill roots are separate. Docs: "Symlinks: Supported; Codex follows the symlink target when scanning." Plugins are "grouped by marketplace" in `/plugins`; the plugin doc gives no on-disk path.
- Both harnesses agree on the Agent Skills `SKILL.md` frontmatter (`name`, `description`); Codex additionally reads optional `agents/openai.yaml`, which this repo's skills already carry.

## Remote transport

| Option | What it actually provides (per its own docs) | Fit for a skills checkout on remote/SSH/cloud hosts |
|---|---|---|
| Tailscale | "a peer-to-peer mesh network (known as a tailnet)" on WireGuard; file sync is not a listed feature. Taildrop "lets you send files between your personal devices" one file at a time, "does not support folder synchronization", not to tagged nodes. Taildrive "is currently in alpha", a WebDAV share at `100.100.100.100:8080`, "folder sharing only, not synchronization", server on Linux/macOS/Windows only. Tailscale SSH: server "only available on Linux, macOS open source tailscale + tailscaled", SFTP/SCP supported. | Reach, not sync. Good for getting a shell or an `scp` to a machine Justin owns; useless for a cloud sandbox (Claude Code cloud, Codex cloud) that is not on the tailnet. A Taildrive mount would make skills live over the network, which breaks the moment the laptop sleeps. |
| Syncthing | "synchronise files" continuously between devices, daemon on each; discovery via `discovery.syncthing.net` and relays; folder types Send Only / Receive Only / Send & Receive; "Symbolic links (synced, except on Windows, but never followed)". | Real bidirectional sync for owned hosts (PC, WSL, a VPS), but a second daemon to install and pair per host, no symlink sync on Windows (so the `.claude/skills` junction layer would not travel), and no way into a cloud sandbox. Overkill for a folder that changes a few times a week. |
| git | Already on every host in scope (it is how the repo gets there). Claude Code cloud: "Cloud sessions start from a fresh clone of your repository. Anything you commit to the repo is available." Codex: repo-scoped `.agents/skills` is scanned from the clone. | The only transport that reaches all four host kinds (PC, WSL, SSH, cloud) with zero extra install. Weaknesses: it carries files, not junctions (Windows) and not user-scope folders; a fresh clone still needs one command to lay out `.claude/skills` and, if wanted, `~/.claude/skills` / `~/.agents/skills`. |

Net: git is the transport; Tailscale is the way to run that command on a remote host you own (SSH), not a sync mechanism. Syncthing only earns its keep if user-scope skills must change live without a commit, which is not the stated goal.

## Gap analysis

What `npx skills` already gives for free: canonical `.agents/skills` (which Codex reads natively), per-agent symlink layer for Claude Code/Goose/Hermes, a committed lock with content hashes, `update` against the upstream repo, and Claude plugin manifests as sources. What is still missing for "one bare-spec folder -> both harnesses on every host":

1. Restore parity. `experimental_install` rebuilds only `.agents/skills`. A fresh clone (or the 13 skills here) needs `npx skills add ... -a claude-code` re-run, or a script that walks `.agents/skills` and links/copies into `.claude/skills`. This is the actual bug behind the 13 missing Claude Code entries.
2. Symlink policy across OSes. Junctions committed from Windows become plain copies for everyone; symlinks committed from Linux are checked out on Windows as text files unless `core.symlinks=true`. Either commit only `.agents/skills` + lock and regenerate `.claude/skills` on each host (and gitignore it), or commit `--copy` output and accept duplication. `npx skills` has no opinion here; a homegrown tool must pick one.
3. User scope. `npx skills -g` writes Codex user skills to `~/.codex/skills`, which Codex now calls deprecated (it also reads `~/.agents/skills`, and `gh skill` targets that). Claude Code user scope is `~/.claude/skills`. If Justin wants the same set in every repo without committing it to each repo, something must populate both user folders on each host from one checkout (a clone of this repo plus two symlinks/junctions is enough).
4. Cloud surfaces. Nothing on a host's home directory reaches a cloud sandbox; only the repo does. For Claude Code cloud the alternative is skills "enabled for your claude.ai account" (loaded as `/anthropic-skills:<name>` into `~/.claude/skills/synced`); for Codex cloud, only repo `.agents/skills` or a plugin marketplace. A homegrown tool cannot fix this; it can only make sure the repo-committed layout is complete (gap 1).
5. Local-authored skills. `oneezy-merge` and `oneezy-status` are not in the lock; `npx skills add ./path` would record them as `sourceType: local` with a relative `source`, which the lock reader resolves against the repo, so this is a usage gap, not a tool gap.
6. Hermes and Goose come free from `npx skills` (both are in `agents.ts`) and from skills-manager; no reason to write anything for them.

## Recommendation

Do not build a skills installer. Keep `npx skills` as the source-of-truth manager for `.agents/skills` + `skills-lock.json`, and let git be the only transport. The homegrown part of skills-sync shrinks to one idempotent script (the future `clis/skills-sync-cli` job) that runs on any host after a clone or pull:

1. `npx skills experimental_install` (or `npx skills add mattpocock/skills --all -y` when `.agents/skills` is empty) to restore the canonical layer from the lock.
2. Walk `.agents/skills/*` and ensure `.claude/skills/<name>` exists as a symlink/junction (or copy when links are impossible), removing stale entries; this is the restore parity `npx skills` lacks and fixes the 13 broken entries.
3. Optionally, at user scope, link `~/.agents/skills` and `~/.claude/skills` entries to the same checkout so every repo on that host sees the set without committing it.
4. Decide and record (ADR) whether `.claude/skills` is committed or regenerated; regenerated is cleaner given the Windows junction-to-copy behaviour observed in the index.

Use Tailscale only for SSH reach to owned remote hosts; do not adopt Syncthing or Taildrive. Watch `gh skill` as a possible replacement for `npx skills` once it leaves preview, since it is copy-only, needs no npm, and already knows both harness layouts at both scopes; but it has no lockfile, so it cannot replace step 1 today.

## Sources

- vercel-labs/skills README: https://github.com/vercel-labs/skills (supported agents, `--copy`, `-g`, `update`, plugin manifest discovery)
- vercel-labs/skills source, main branch as of 2026-09-18: `src/local-lock.ts`, `src/skill-lock.ts`, `src/installer.ts`, `src/agents.ts`, `src/install.ts`, `src/update.ts`, `src/sync.ts`, `src/plugin-manifest.ts`, `src/cli.ts`, `package.json` (https://github.com/vercel-labs/skills/tree/main/src)
- vercel-labs/skills repo metadata via `gh api repos/vercel-labs/skills` (stars 32197, pushed 2026-09-18, MIT)
- mattpocock/skills README: https://github.com/mattpocock/skills (install via `npx skills@latest add mattpocock/skills`, `claude plugins install mattpocock-skills`, `npx skills update`)
- Claude Code skills docs: https://code.claude.com/docs/en/skills (locations, precedence, symlinked folders, `synced`, claude.ai account skills)
- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference (skills-directory plugins, plugin cache, scopes)
- Claude Code cloud environments: https://code.claude.com/docs/en/cloud-environments ("What carries over from your setup")
- Codex skills docs: https://developers.openai.com/codex/skills (redirects to https://learn.chatgpt.com/docs/build-skills; directories, `$skill-installer`, symlinks supported)
- Codex plugins docs: https://developers.openai.com/codex/plugins (redirects to https://learn.chatgpt.com/docs/plugins)
- Codex source: https://github.com/openai/codex/blob/main/codex-rs/ext/skills/src/host_roots.rs (skill roots, deprecated `$CODEX_HOME/skills`)
- GitHub CLI changelog, `gh skill`: https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- GitHub CLI manual: https://cli.github.com/manual/gh_skill_install; source `internal/skills/registry/registry.go`, `pkg/cmd/skills/install/install.go` (https://github.com/cli/cli/tree/trunk); `gh skill --help` on gh 2.101.0
- Karanjot786/agent-skills-cli: https://github.com/Karanjot786/agent-skills-cli (stars 181, pushed 2026-05-17)
- xingkongliang/skills-manager: https://github.com/xingkongliang/skills-manager (stars 4894, pushed 2026-09-17)
- tech-leads-club/agent-skills: https://github.com/tech-leads-club/agent-skills (stars 6606, pushed 2026-09-20)
- dhruvwill/skills-cli: https://github.com/dhruvwill/skills-cli (stars 14, pushed 2026-01-16)
- Tailscale: https://tailscale.com/kb/1151/what-is-tailscale, https://tailscale.com/kb/1106/taildrop, https://tailscale.com/kb/1369/taildrive, https://tailscale.com/kb/1193/tailscale-ssh
- Syncthing: https://docs.syncthing.net/intro/getting-started.html, https://docs.syncthing.net/users/faq.html, https://docs.syncthing.net/users/foldertypes.html
- Local repo state: `skills-lock.json` (38 entries), `git ls-files -s .claude/skills` (mode 100644), folder listings of `.agents/skills` and `.claude/skills` on branch `main` at `e98650c`
