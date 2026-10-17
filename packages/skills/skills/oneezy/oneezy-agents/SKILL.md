---
name: oneezy-agents
description: Load Justin's global rules for every harness (`AGENTS-GLOBAL.md`, packaged in this plugin) and follow them for the rest of the session. Use at the start of every session when custom instructions or the skills-sync global block say to, or when Justin asks how he works or what his rules are.
---

`AGENTS-GLOBAL.md` is Justin's one set of global rules for every harness: a short router to his Oneezy skills plus the few rules no skill owns. This skill reads the copy installed with this plugin and makes it this session's standing instructions. The installed copy is the only source (ADR-0018): read it from disk, never from GitHub or any other remote.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

## 1. Read the installed copy

Read `references/AGENTS-GLOBAL.md` beside this file. When the base directory the harness reported holds no such file, find the installed copy on disk: search this harness's plugin and skill folders for `oneezy-agents/references/AGENTS-GLOBAL.md` (Claude Code: under `~/.claude/plugins/`) and read that one.

Done when you hold the installed copy's full text. When no installed copy exists, tell Justin the installed plugin's `AGENTS-GLOBAL.md` could not be found, name the folders you searched, and stop.

## 2. Follow it

Treat the text as standing instructions for the rest of this session, with the same weight as the custom instructions or global block that sent you here. A repo's own `AGENTS.md` layers on top of it, as its first paragraph says. Load a skill it routes to when the work reaches that skill.

## 3. Name the copy

Open your reply with one line: `Loaded AGENTS-GLOBAL.md from the installed plugin`, followed by the plugin version when its `plugin.json` is readable (`Loaded AGENTS-GLOBAL.md from the installed plugin (oneezy 0.50.2)`). Then answer Justin's message.

## Changing a rule

`references/AGENTS-GLOBAL.md` is the one global rules file: `skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md` in oneezy/skills, edited in place (ADR-0019). The repo's root `AGENTS.md` guides only work on that repo. A session sees a change only after it ships in a plugin release and the harness syncs it. When Justin asks you to change a rule, give him the new wording. On his yes, land it with a `land/<topic>` branch cut from `dev` (`docs/agents/release.md`): edit `references/AGENTS-GLOBAL.md`, bump `library.version` one patch, run `npx @oneezy/skills-sync build` and `check`, and push. That branch lands in `dev`, promotes `main` and cuts the release; open sessions keep the rules they loaded until the next session.
