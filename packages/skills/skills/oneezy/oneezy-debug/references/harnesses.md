# Building the report by hand

Read this when `scripts/trace.mjs` prints `Transcript not available`, or there is no shell. Find the row for the harness you are in and fill the header from its columns; anything a row does not give is `unknown`.

| Harness | Recognise it by | Session | Times |
|---|---|---|---|
| Claude Code (terminal, desktop, cloud) | `CLAUDECODE=1`; `CLAUDE_CODE_ENTRYPOINT` names the surface | Cloud: `CLAUDE_CODE_REMOTE_SESSION_ID` is `cse_<x>`, the link `https://claude.ai/code/session_<x>`. Local: `claude --resume <CLAUDE_CODE_SESSION_ID>` | The script covers it; by hand, clock reads |
| Codex (CLI, app, IDE) | `CODEX_THREAD_ID` in the shell | `codex resume <CODEX_THREAD_ID>` | The script covers it; by hand, clock reads |
| Cowork (Claude desktop) | your system prompt names Cowork | with `CLAUDECODE=1` in its shell, the Claude Code row; otherwise unknown | clock reads in the shell |
| Hermes | your system prompt names Hermes | unknown | clock reads in the terminal tool |
| ChatGPT (web, desktop, mobile) | your system prompt names ChatGPT | unknown; Justin sees it in the address bar | clock reads in the Python tool when it is on; otherwise unknown |
| Claude.ai chat (web, desktop, mobile) | your system prompt names Claude.ai, and you have no shell of your own | unknown | clock reads in the code execution tool when it is on; otherwise unknown |

## Header by hand

- **Harness and surface**: [verified] from an environment variable, [reported] from your system prompt.
- **Model and effort**: [reported] from your system prompt; [verified] unknown.
- **System prompt, instructions, memory**: the locations your own context names (a global instructions file, project instructions, custom instructions, a memory folder), each [reported]. Name a location, never its contents.
- **Skills**: the skills you loaded or read a `SKILL.md` for, [reported], with plugin and version when the skill's folder shows them.

## Rows by hand

Keep a step list while the target runs: one row per action (a tool call, a skill load, a search), in order, nested under the step that started it.

A clock read is one command run just before a step; its time is that step's Start, and the next read ends it. The read itself is not a row.

- bash: `date -u +%H:%M:%S`
- PowerShell 7: `Get-Date -AsUTC -Format HH:mm:ss`
- Python: `datetime.now(timezone.utc).strftime('%H:%M:%S')`

With no clock, Start and Duration are `—`. Status comes from the command's exit code or the tool's error; a step with neither is ℹ️, with its state in the title.
