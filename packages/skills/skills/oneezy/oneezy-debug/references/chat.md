# Target: this chat

The default target. With nothing after `/oneezy-debug` (or "this chat") the report covers the whole chat so far; with a skill or request after it, the report covers the turn that runs it.

1. **Run the request**, when there is one, exactly as you would without this skill. Done when its own work is finished and the answer is not yet written.
2. **Trace.** With a shell, run from this skill's folder:

   ```
   node scripts/trace.mjs --scope <chat | turn> --tz <zone>
   ```

   `--scope chat` with no request, `turn` with one. `--tz` takes Justin's timezone when your context names it (an IANA name such as `America/Chicago`); leave it out otherwise, and the machine's zone is used and named. The script prints the header, a `<<ANSWER>>` line, then the table and its legend. Done when it printed a header.

   When it prints `Transcript not available`, or there is no shell, read `references/harnesses.md` and build the same report by hand.
3. **Complete the header.** Keep every script line as printed. Add the values your own context carries that the transcript lacks (the project and thread title, the chat link Justin sees), each tagged [reported]. Done when no value you know is missing.
4. **Write the answer** in place of `<<ANSWER>>`. With no request, the answer is one or two sentences on what the chat has done and where it stands.
5. **Write Outcomes** under the legend, one line per thing created or changed, from the tool results in the table: its title or link, then the evidence (a URL fetched, a CI run, a command's output). An action whose result you did not check is listed as attempted, with ⚠️.

Done when the report prints header, answer, table, legend and Outcomes, in that order.

## What the script reads

Claude Code: `~/.claude/projects/<cwd>/<session>.jsonl`. A prompt and everything with its `promptId` is one turn; each tool call is a row timed from its call to its result; a subagent's calls come from `<session>/subagents/agent-<id>.jsonl` and nest under its row. Instruction files, memory and context sections come from the transcript's attachments; a skill's plugin and version from the `plugin.json` above the folder it loaded from.

Codex: `~/.codex/sessions/**/rollout-*-<CODEX_THREAD_ID>.jsonl`. A `user_message` event opens a turn; `function_call` and `custom_tool_call` lines pair with their outputs by `call_id`; the model and effort come from `turn_context` ([selected]: what Codex sent), the CLI version and originator from `session_meta`, loaded `AGENTS.md` files from their injected headings.

Both: `decisions.tsv` or `.audit/*.tsv` in the working folder is the `/show-me-your-work` decision trail; the header links it and the report never copies or rewrites it.
