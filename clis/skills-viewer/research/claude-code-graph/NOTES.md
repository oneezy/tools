# claude-code-graph (bluera) trial — oneezy/tools#57

Trial date: 2026-09-27. Host: Windows 11, Git Bash + PowerShell, Node 24, Python 3.12.
Fixture (read-only): `clis/skills-viewer/fixtures/mattpocock-skills` (38 skill folders).
Scratch: `C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\claude-code-graph-trial\`.

## What the tool is

`claude-code-graph` is an instruction-only Claude Code SKILL (a `SKILL.md` + three
`references/*.md`, no scripts) from the bluera-base plugin. It tells the agent to
inventory a plugin (commands/skills/hooks/agents), extract descriptions from
frontmatter, infer four dependency kinds (command→skill, skill→tools, skill→skill,
hook→event) and print the result as a terminal box report, JSON, Mermaid, or Markdown.
The full v1.0.2 source is in `skill-source/`.

Source provenance (this matters, see Verdict):

- The issue names `github.com/blueraai/bluera-base`. That repo returns **404** (`gh api
  repos/blueraai/bluera-base` → `Not Found`; `git clone` → `Repository not found`). The
  `blueraai` org has one public repo (CyberMetric, last push 2024-09-11). So the upstream
  is private, renamed, or deleted; the lobehub page still links to it.
- Obtained v1.0.2 (with references) from the LobeHub market's unauthenticated download
  endpoint: `https://market.lobehub.com/api/v1/skills/blueraai-bluera-base-claude-code-graph/download`
  (zip: `SKILL.md`, `references/{discovery-parsing,dependency-graph,output-formats}.md`).
  SHA-256 of each reference matches the market's `resources` manifest (`skill-source/lobehub-api.json`).
- A second copy (older, single-file layout, Feb 2026) exists in the
  `majiayu000/claude-skill-registry` mirror; its metadata says
  `"license": "NOASSERTION"`, `"license_class": "restricted"` (`skill-source/registry-mirror-metadata.json`).
  Third-party listings (agentskill.sh, skills.lc) say the bluera-base plugin was MIT at v0.37.8,
  but none of that is verifiable now that the repo is gone.

## Fixture wrapping (documented step)

The skill requires `.claude-plugin/plugin.json` ("Fail fast if plugin.json missing").
The fixture is a bare skills folder, so it was wrapped in scratch, never modified in place:

```
<scratch>/plugin/.claude-plugin/plugin.json   -> {"name":"mattpocock-skills","version":"0.0.0"}
<scratch>/plugin/skills/<38 folders>          -> cp -r fixture/. plugin/skills/
```

The wrapper manifest is copied here as `wrapper/plugin.json`. No `commands/`, `hooks/`,
or `agents/` dirs were added, so those inventories are legitimately zero.

---

## Scorecard

### 1. Installed and ran cleanly?

**Partly.** Nothing to "install": the skill is prose. Steps and results:

1. `git clone https://github.com/blueraai/bluera-base.git` →
   `remote: Repository not found.` / `fatal: repository 'https://github.com/blueraai/bluera-base.git/' not found`
2. `npx -y @lobehub/market-cli skills install 'blueraai-bluera-base-claude-code-graph' --dir <scratch>`
   (the exact command from the lobehub page, with `--dir` so nothing lands in `~/.claude/skills`) →
   `No credentials found. Run \`lhm register\` first or set MARKET_CLIENT_ID and MARKET_CLIENT_SECRET.`
   `lhm register` would write user-level config, so not attempted.
3. `curl -sL .../api/v1/skills/blueraai-bluera-base-claude-code-graph/download -o claude-code-graph-1.0.2.zip` → 200, `application/zip`. Extracted with Python. **Worked.**
4. Ran the Phase 1–2 bash lines verbatim from `references/discovery-parsing.md` with `PLUGIN_PATH=plugin`:
   - Manifest: `cat "$PLUGIN_PATH/.claude-plugin/plugin.json" | jq '{name, version, description}'` →
     `/usr/bin/bash: line 1: jq: command not found` (Git Bash on this host has no jq). Substituted
     Python: `{"name": "mattpocock-skills", "version": "0.0.0", "description": null}`.
   - `ls -d "$PLUGIN_PATH/skills/"*/ | wc -l` → `38`. Commands `0`, agents `0`.
   - Hooks: `cat .../hooks/hooks.json | jq '.hooks | keys'` → `jq: command not found` (and no hooks.json anyway).
   - Skill descriptions loop (sed) → 38 rows, saved as `phase2-skills.txt`. Caveat: the sed
     does no YAML parsing, so quoted descriptions keep their quotes and escapes, e.g.
     `code-review  "Review the changes ... asks to \"review since X\"."`.
   - Command/agent loops on a plugin with no such dirs print a spurious row (`*` /
     `sed: can't read plugin/commands/*.md: No such file or directory`) because the glob
     is unquoted and nullglob is off. Harmless, but the skill did not anticipate it.
   - The `## Context` line `!\`ls .claude-plugin/plugin.json ...\`` printed `Plugin detected` when run from the wrapper dir.
5. Phases 3–4 have no commands at all: "Look for `Task` tool usage with skill references, or
   `@skill-name` patterns", then "Render the graph in the requested format". I wrote
   `run_graph.py` (in this folder) to do exactly that and emit the four formats. So
   **output quality depends entirely on the agent**; a different agent would produce a
   different graph from the same instructions.
6. Mermaid → SVG: `npx -y @mermaid-js/mermaid-cli -i graph.mmd -o graph.svg` succeeded first try for both variants.

### 2. Found all skills?

**Yes, 38/38.** The `ls -d skills/*/` count and the description loop both hit every folder.
Nothing missed, nothing extra. Note it only looks one level deep and only at `SKILL.md`;
supporting files (`agents/openai.yaml`, `PHASE-BOUNDARIES.md`, `scripts/*.sh`) are invisible
to it, which is fine for inventory but is why Phase 3 misses edges that live there.

### 3. Shows invocation mode?

**No.** The skill extracts only `name` and `description` (via a `description:` sed) and
`allowed-tools`. It never reads `disable-model-invocation` or `user-invocable`, and its JSON
schema has no field for them. In the fixture 23 of 38 skills carry
`disable-model-invocation: true` (ask-matt, claude-handoff, grill-me, grill-with-docs,
handoff, implement, implement-spec, improve-codebase-architecture, loop-me, retro,
setup-matt-pocock-skills, setup-ts-deep-modules, teach, to-questionnaire, to-spec,
to-tickets, triage, wait-what, wayfinder, writing-beats, writing-fragments, writing-shape);
0 use `user-invocable`; 4 carry `argument-hint`. See `frontmatter.json`. I added a
`frontmatter` field to my JSON output so the data is there, but that is my addition, not the skill's.

### 4. Skill→skill edges

**Literal run: 0 edges. Ground truth: ~60.**

The skill's two stated rules were applied literally (`run_graph.py`, mode `literal`):

- `@skill-name` patterns: one match in the whole fixture, `@reporter` (triage/SKILL.md:102),
  and it is not a skill → 0 true edges, 1 false positive if taken at face value.
- `Task` tool usage with skill references: the word `Task` appears once (wayfinder/SKILL.md:80,
  describing a ticket *type*, not the Task tool) → 0 edges.
- `See skills/*/SKILL.md` (command→skill rule): 0 matches (no commands dir).

Ground truth was built by grepping the fixture for `/skill-name`, `$skill-name`,
"the X skill", `Skill tool with "X"` (and `Skill tool twice, for "X" and "Y"`), plus
backticked names. Result: **60 source→target pairs**, 138 evidence lines
(`edge-evidence.txt`, `interpreted/graph.json` → `_edgeKinds`). Highlights:

| Source | Targets | How the fixture says it |
|---|---|---|
| ask-matt | 24 skills (code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-with-docs, grilling, handoff, implement, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, setup-matt-pocock-skills, tdd, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wayfinder, wizard, writing-for-agents) | `/name` in prose (router) |
| wayfinder | grilling, domain-modeling, research, prototype, setup-matt-pocock-skills | `Skill tool with "research"`, `Skill tool twice, for "grilling" and "domain-modeling"`, `/setup-matt-pocock-skills` |
| grill-with-docs | grilling, domain-modeling | `Call the Skill tool twice, for "grilling" and "domain-modeling".` |
| grill-me | grilling | `Skill tool with "grilling"` |
| triage | grilling, domain-modeling, setup-matt-pocock-skills | Skill tool / slash |
| improve-codebase-architecture | codebase-design, domain-modeling, grilling | Skill tool |
| tdd | codebase-design, code-review | Skill tool / "the code-review skill" |
| implement | tdd, code-review | `/tdd`, `/code-review` |
| setup-ts-deep-modules | codebase-design | Skill tool |
| retro | writing-for-agents | Skill tool with `writing-for-agents` |
| code-review, to-spec, to-tickets, triage, wayfinder | setup-matt-pocock-skills | "tell the user to run `/setup-matt-pocock-skills`" |

All of the "known" edges in the issue (ask-matt→many; wayfinder→grilling, domain-modeling,
research, prototype; grill-with-docs→grilling) are present in ground truth and **absent from
the literal run**. Edges missed by the literal rules: all 60. False edges from the literal
rules: `@reporter` (if the agent were naive). The skill's detection vocabulary (`Task` tool,
`@name`) simply does not match how these skills reference each other (the `Skill` tool and
`/name` mentions).

Caveats on the ground truth itself: backtick-only matches in wayfinder (`research`,
`prototype`, `grilling`) are label names that coincide with skill names, and
`setup-matt-pocock-skills → pr` is a backtick mention in a list of skills to configure, not
a call. Roughly 8 of the 60 are mention-only rather than call edges; the interpreted output
does not distinguish them (the skill has no edge-type vocabulary).

**Skill→tools via `allowed-tools`:** 0 of 38 fixture skills declare `allowed-tools`, so this
edge kind is empty for this library regardless of tool.

**Interpreted run** (`interpreted/`): same script with the agent choosing patterns that fit
the fixture → the 60 edges above. This is what a capable agent following the prose "with
judgement" might produce, but nothing in the skill instructs it.

### 5. Identifies entry points?

**No.** No notion of entry point, root, in-degree, or "user-invocable only" exists in the
skill. In the literal output every skill is an isolated node. In the interpreted graph a human
can *see* ask-matt as the big fan-out node and setup-matt-pocock-skills as the big fan-in
node, and wayfinder has in-degree 2 (ask-matt, setup-matt-pocock-skills) and out-degree 5, but
the tool does not compute or label any of that.

### 6. Shows sequential / parallel / loop structure?

**No.** Edges are untyped `-->` only. The main flow in ask-matt (grill-with-docs → to-spec →
to-tickets → implement → tdd → code-review), wayfinder's parallel research subagents
("Fire the research subagents ... in parallel"), and the loop-me / wayfinder
one-ticket-per-session loops are all invisible. There is no edge label, no ordering, no
subgraph per flow.

### 7. Readability at a glance

Mermaid output is `graph TD` with fixed subgraphs `Commands`, `Skills`, `Hooks`, `Events`
(empty ones still emitted per the template) and one node per skill.

- **Literal** (`literal/graph.svg`, viewBox 7870×175): one flat row of 38 boxes, three empty
  subgraph frames, zero edges. Says nothing beyond "38 skills exist".
- **Interpreted** (`interpreted/graph.svg`/`.png`, viewBox 4540×1216): all 38 nodes inside a
  single `Skills` subgraph; ask-matt sits at the top with 24 fan-out arrows, a tangle of
  criss-crossing edges runs through the middle, and setup-matt-pocock-skills / grilling /
  domain-modeling collect the fan-in at the bottom. At full width it is legible but wide
  (~4.5k px); at fit-to-screen it is a hairball. You can identify the hub nodes by arrow
  density; you cannot read flows, edge kinds, or invocation mode. Nine isolated nodes (e.g.
  claude-handoff, git-guardrails, scaffold-exercises, writing-*) float top-right.

My impression: usable as a "who talks to whom" overview once edges exist; poor for anything
structural. Number left to the human.

### 8. Export formats

Per the skill: terminal box report (`inventory.txt`), `--json` (`graph.json`), `--mermaid`
(`graph.mmd`), `--markdown` (`graph.md`, tables + `<details>` Mermaid). **No DOT.** No
SVG/PNG (rendered here separately with mermaid-cli). The JSON schema
(`references/dependency-graph.md`) is plugin-shaped: `commandToSkill` is a single string per
command (cannot express one command → many skills), `skillToSkill` is `{name: [names]}` with
no edge type or evidence, no per-edge file/line. `--output FILE` is described but, being
prose, is whatever the agent decides to do.

### 9. Works for Codex / other harnesses?

**No, twice over.** (a) It is a Claude Code SKILL with `!\`...\`` shell-in-context syntax and
an `allowed-tools: [Read, Glob, Grep, Write]` frontmatter, so it only runs inside Claude Code.
(b) Its subject is a Claude Code *plugin* layout (`.claude-plugin/plugin.json`, `commands/`,
`hooks/hooks.json`, `agents/`); it does not know about `agents/openai.yaml`, `.agents/skills`,
`~/.codex/skills`, or a bare skills directory (hence the wrapper). The bash it embeds needs
`jq`, absent on this Windows host's Git Bash.

### 10. Verdict

**Skip (borrow at most one idea).** The skill is ~10 KB of prose with no code; everything
that would make it useful on our fixture (recognising `Skill tool with "X"` and `/name`
references, reading `disable-model-invocation`, typing edges, finding entry points) is
absent, and its two stated detection rules produced zero true edges against 38 real skills.
The only reusable idea is the four-format shape (terminal inventory / JSON / Mermaid /
Markdown-with-collapsible-diagram) and the "empty subgraphs still drawn" Mermaid template,
neither of which needs this skill to copy. Detection is by agent eyeballing (`Task`/`@name`
prose rules; `sed` for descriptions; `jq` for hooks). License is unverifiable: the upstream
repo `blueraai/bluera-base` is gone (404), third-party listings say MIT, the registry
mirror says NOASSERTION/restricted; the org's only public repo was last pushed 2024-09.
Lobehub shows 26 installs, 0 ratings, versions 1.0.1 and 1.0.2 both dated 2026-03-05.

---

## Files in this folder

- `NOTES.md` — this scorecard.
- `literal/` — output following the skill's rules exactly: `inventory.txt`, `graph.json`, `graph.mmd`, `graph.md`, `graph.svg`.
- `interpreted/` — same script with agent-chosen reference patterns: same files plus `graph.png`.
- `edge-evidence.txt` — every match: `source | target | kind | file | line | text`.
- `frontmatter.json` — every fixture SKILL.md's frontmatter keys (for the invocation-mode row).
- `phase2-skills.txt` — verbatim output of the skill's Phase 2 skill-description loop.
- `run_graph.py` — the agent-written Phase 3–4 runner (the skill ships no script).
- `skill-source/` — v1.0.2 `SKILL.md` + `references/`, lobehub API record, registry-mirror metadata.
- `wrapper/plugin.json` — the manifest used to wrap the fixture as a plugin.
