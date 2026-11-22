---
name: oneezy-debug
description: "Show what the agent did in a chat: harness, model, session, the instructions, context and skills it loaded, and a nested, timed table of every step. Use when Justin types /oneezy-debug, alone or with a target or request, or asks to debug or trace a chat."
argument-hint: "empty for this chat; 'this <target>'; or a skill or request to run under it"
---

`/oneezy-debug` is a wrapper: the words after it pick a **target**, and every target answers with the same **report**. Each value in the report carries its **evidence**, so Justin can tell what was read from what was assumed.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

## Targets

| Words after `/oneezy-debug` | Target | Read |
|---|---|---|
| nothing, or "this chat" | the whole chat so far | `references/chat.md` |
| a skill or request, such as `/oneezy-skills update my skills` | this turn: run it, then report on it | `references/chat.md` |
| "this <thing>" for anything else (code, a skill, a sync) | not built yet | say so in one line, then report on this chat |

A new target is a `references/<target>.md` file and a row in this table.

## Evidence

Tag each header value with one label:

- **[verified]**: read from the transcript, the harness or the environment during this run.
- **[selected]**: configured or chosen (a setting, an environment variable, a UI pick). A configured value is not proof of what ran.
- **[reported]**: the agent's own context says it (its system prompt names the model, the thread title it was given).
- **unknown**: the host does not expose it. Unknown stays unknown: a guessed model, id, link, time or location never appears.

The report carries observable actions and one-line decision summaries. Hidden reasoning, secrets, tokens, email addresses and private payloads stay out.

## Report

Three parts, in this order, even when another skill says its output is the whole message:

1. **Header**, before the answer: harness and version, surface (terminal, desktop, Projects thread, web), execution location (local computer, cloud container, remote workspace, never Justin's physical location), model ([verified] and [selected], provider), reasoning effort ([selected] and [verified]), session link and id, working folder, where the system prompt comes from, the instruction files loaded, memory and context sections, skills with plugin and version, the decision trail, and the timezone of every Start.
2. **Answer**: what the target produced.
3. **Table**, then outcomes.

The table has exactly four columns, `Status | Title | Start | Duration`:

- **Status** is one of four, legend in this order: ✅ success (the exact claimed outcome was verified), ❌ failure (an observed error), ⚠️ warning (a limitation, risk, blocker or missing result), ℹ️ information (ordinary state: ongoing, planned, skipped). Attempted is not completed, and unknown is not failure.
- **Title** is a few plain words starting with a verb, with no emoji.
- **Nesting**: a child row sits under its evidenced parent (the prompt it answered, the subagent that ran it), indented by one U+2003 blank per level in both Status and Title. Rows with no evidenced parent stay at the top level.
- **Start** is the time only (`3:30:05 p.m.`), its timezone named in the header; `—` when unknown.
- **Duration** is a step's elapsed time; a parent's is its whole span, never the sum of its children. `ongoing`, `no result` and `—` say why a time is missing.

Under the table, one legend line, then **Outcomes**: every thread, chat, issue, PR, commit, push, merge, release or file the target created or changed, with its title or link and what verified it. Each is its own outcome: a merge does not prove an install, a release does not prove cloud availability, and an upload does not prove a fresh session loaded it.

Done when the header has a value or `unknown` on every line, each tagged; every row has one of the four statuses; and every outcome names its evidence.
