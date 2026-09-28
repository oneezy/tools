# skill-visualizer (mhylle) trial — issue oneezy/tools#56

Source: https://github.com/mhylle/claude-skills-collection, folder `skills/skill-visualizer/`
(`SKILL.md` + `scripts/visualize.py`, 628 lines, Python stdlib only). Listing: https://lobehub.com/skills/mhylle-claude-skills-collection-skill-visualizer
Trial date: 2026-09-27. Host: Windows 11 Pro, Python 3.12.8, Node 24.21.0 (Node unused), Git Bash.
Fixture: `clis/skills-viewer/fixtures/mattpocock-skills` (38 skill folders), read-only, untouched.
Scratch: `C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\skill-visualizer-trial\repo` (throwaway `git init`, fixture copied to `.claude/skills/`, skill installed at `.claude/skills/skill-visualizer/`). Nothing installed under `~/.claude`, `~/.codex`, `~/.agents`.

The skill is script-backed: its SKILL.md tells the agent to run `python <skill>/scripts/visualize.py [skills|codebase|deps]`. No LLM judgment is involved in detection, so the output is deterministic and does not depend on which agent runs it. I ran the script directly in all three modes.

Files in this folder:
- `skills-map-2026-09-27.html`, `deps-map-2026-09-27.html`, `codebase-map-2026-09-27.html` — the script's output, copied verbatim
- `skills-map-nodes.json`, `skills-map-links.json` — the `nodes` / `links` arrays regex-extracted from the HTML (the script emits no JSON of its own)
- `ground-truth-refs.json` — my grep of the fixture (all files per skill folder) for `/X`, `$X`, "the X skill", `Skill tool with "X"`, `skill="X"`, backticked `X`, bare `X`

---

## 1. Installed and ran cleanly?

**Partly. One Windows-only crash on first run; clean after setting `PYTHONUTF8=1`.**

Steps:

```
git clone --depth 1 https://github.com/mhylle/claude-skills-collection.git src-clone
git init repo && mkdir -p repo/.claude/skills
cp -r <fixture>/* repo/.claude/skills/
cp -r src-clone/skills/skill-visualizer repo/.claude/skills/skill-visualizer
cd repo
python .claude/skills/skill-visualizer/scripts/visualize.py skills      # attempt 1: crash
```

Attempt 1 error, verbatim:

```
Traceback (most recent call last):
  File "...\repo\.claude\skills\skill-visualizer\scripts\visualize.py", line 628, in <module>
    main()
  File "...\visualize.py", line 604, in main
    skills = find_skills(str(skills_dir))
  File "...\visualize.py", line 30, in find_skills
    content = f.read()
  File "C:\Users\Justin\AppData\Local\Programs\Python\Python312\Lib\encodings\cp1252.py", line 23, in decode
    return codecs.charmap_decode(input,self.errors,decoding_table)[0]
UnicodeDecodeError: 'charmap' codec can't decode byte 0x90 in position 2779: character maps to <undefined>
```

Cause: `open(skill_file, 'r')` with no `encoding=`; on Windows that is cp1252. The byte is a box-drawing character (U+2510, UTF-8 `e2 94 90`) in `codebase-design/SKILL.md`; 19 of the 38 fixture SKILL.md files contain non-ASCII bytes, so this fails on any Windows box with a default code page.

Attempt 2 (env fix, no code change) — all three modes exit 0:

```
export PYTHONUTF8=1
python .claude/skills/skill-visualizer/scripts/visualize.py skills
  -> Generated: ...\repo\.claude\docs\visualizations\skills-map-2026-09-27.html
  -> Found 39 skills with 45 dependencies
python .claude/skills/skill-visualizer/scripts/visualize.py deps
  -> Generated: ...\repo\.claude\docs\visualizations\deps-map-2026-09-27.html
python .claude/skills/skill-visualizer/scripts/visualize.py codebase
  -> Generated: ...\repo\.claude\docs\visualizations\codebase-map-2026-09-27.html
```

Other things to know:

- Output landed in `.claude/docs/visualizations/`, not `docs/visualizations/` as SKILL.md says. The script hard-codes the project root as four parents up from `visualize.py` and the skills dir as `<root>/skills`; installed under `.claude/skills/` the "root" is `.claude/`. There is no flag for the skills directory; argv[2] is only an output path.
- Every run calls `webbrowser.open(...)` unconditionally, so the three runs opened three browser tabs on this machine. There is no `--no-open` flag.
- `deps` and `skills` produce byte-identical HTML apart from link ordering (the code comment says "Same as skills but focused on deps"; it calls the same generator).
- The HTML loads D3 from `https://d3js.org/d3.v7.min.js`; SKILL.md's "Self-contained: No external dependencies (D3.js embedded)" is false. Offline, the graph is blank.
- `codebase` mode is a nested `<details>` tree with byte sizes, not the "treemap" SKILL.md promises. It scanned `.claude/` (root name `.claude`, children `docs`, `skills`, 39 skill folders, 321,440 bytes). Fine as a file browser, not a visualization.

## 2. Found all skills?

**Yes: 38/38 fixture skills, plus itself (39 nodes)**, because it scans its own parent directory and does not exclude itself. Discovery is `glob("<skills_dir>/*/SKILL.md")`: one level deep only, nested or plugin-namespaced skills would be missed, and it never looks at `agents/openai.yaml` or sibling reference files.

## 3. Shows invocation mode?

**No.** The fixture's actual invocation-mode signal is `disable-model-invocation: true` on 24 of 38 skills (manual-only); the other 14 are auto (default). No fixture skill uses `context`, `allowed-tools`, or `user-invocable`.

How the tool's three colours map:

| tool colour | rule in `find_skills()` | relation to invocation mode |
|---|---|---|
| green "Orchestrator" | literal substring `context: fork` anywhere in the file (body included, not just frontmatter) | none; `context: fork` is Claude Code 2.1's "run in a forked subagent" flag |
| blue "Read-only" | literal substring `allowed-tools:` anywhere in the file | none; it is a tool allowlist, and any allowlist (even `Bash(python *), Write`) is called "read-only" |
| orange "Hybrid" | everything else | none |

Result on the fixture: 38 orange, 0 blue, 1 green. The one green node is `skill-visualizer` itself, classified as an orchestrator because its own SKILL.md body contains the legend text "Orchestrators (context: fork)". `disable-model-invocation` and `user-invocable` are never read. The script does compute `hasArgs` (`argument-hint` present: 5 nodes) but the HTML never renders it.

## 4. Skill-to-skill edges

Detection (`detect_dependencies()`): for each pair, lowercase the SKILL.md and test four substrings: `skill="X"`, `skill='X'`, `/X`, backticked `X`. No word boundary, no frontmatter/body distinction, untyped edges, only SKILL.md is read.

Reported: **45 edges**. Against ground truth (`ground-truth-refs.json`):

**42 correspond to a real textual reference**, of which

- 36 are real routing/invocation references: `ask-matt` -> 24 skills (every `/X` in its routing prose); `implement` -> `tdd`, `code-review`; `implement-spec` -> `code-review`; `improve-codebase-architecture` -> `codebase-design`; `loop-me` -> `grilling`; `retro` -> `writing-for-agents`; `tdd` -> `code-review`; `wayfinder` -> `grilling`, `prototype`, `research`; `setup-matt-pocock-skills` -> `to-spec`, `to-tickets`, `triage` (backtick mentions: "skills like `to-tickets`, `triage`, `to-spec` read from ...").
- 6 are "if the tracker doc is missing, tell the user to run `/setup-matt-pocock-skills`" pointers (`code-review`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, and `ask-matt` -> `setup-matt-pocock-skills`). Textually real, but they are "requires setup" prerequisites drawn as if the skill calls the installer; the arrow direction is misleading.

**3 false edges**, all from the `pr` skill name being a substring of `/pr...`:

- `ask-matt -> pr` (matched `/prototype`)
- `scaffold-exercises -> pr` (matched the path `.../problem/readme.md`)
- `setup-pre-commit -> pr` (matched `/pre-commit` / `/prettier` style tokens)

**Missed edges (real invocations the tool cannot see):**

- The whole `Call the Skill tool with "X"` / `Call the Skill tool twice, for "X" and "Y"` phrasing, which is how the fixture's modern skills call each other: `grill-me -> grilling`; `grill-with-docs -> grilling`, `domain-modeling` (this is the known "grill-with-docs uses grilling" edge, missed); `improve-codebase-architecture -> grilling`, `domain-modeling`; `setup-ts-deep-modules -> codebase-design`; `tdd -> codebase-design`; `wayfinder -> domain-modeling`, `pr`. Ten real edges missed.
- References that live in sibling files, not SKILL.md: `setup-matt-pocock-skills` -> `domain-modeling`, `grill-with-docs`, `improve-codebase-architecture`, `wayfinder`, `grilling`, `pr`, `prototype`, `research` (in `domain.md`, `issue-tracker-*.md`, `triage-labels.md`). Eight more.
- "the X skill" phrasing is not a pattern either (it happened not to lose anything here because those skills also used backticks).

Known-edge check: ask-matt fan-out found; `wayfinder` -> grilling/prototype/research found, -> domain-modeling missed; `grill-with-docs` -> grilling missed; `setup-matt-pocock-skills` appears as a 6-in-edge sink rather than as the installer that seeds the others.

## 5. Identifies entry points?

**No concept of entry points.** Nothing computes in/out degree or roots. In the force layout `ask-matt` (25 out, 0 in) is visually the hub by sheer edge count, so a human would guess it; `setup-matt-pocock-skills` looks like a hub too, but as a target (6 in-edges from the "run setup first" pointers), which inverts its actual role; `wayfinder` (1 in from ask-matt, 4 out) does not stand out. Eight nodes are isolated (`claude-handoff`, `git-guardrails-claude-code`, `migrate-to-shoehorn`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`, `skill-visualizer`) and drift to the edges.

## 6. Sequential / parallel / loop structure?

**No.** Edges are untyped, unlabeled, and unordered. ask-matt's "`/to-spec`, then `/to-tickets`, then `/implement` per ticket, `/clear` between each" and wayfinder's "fire research subagents in parallel" both flatten into plain arrows from the hub. There is no phase, order, loop, or fork/subagent marker anywhere in the data model (`{source, target}` only).

## 7. Readability at a glance

I could not screenshot it: the Claude-in-Chrome extension refused `file://`, then timed out, then reported "Browser extension is not connected" (three attempts; a throwaway `http.server` on 127.0.0.1:8765 was started for the second and third and then killed). The script itself did open the pages in the default browser, so they may still be in a tab. The description below is from the generated markup and D3 config.

Layout: dark theme (`#1a1a2e`), 300px left sidebar (title, three-colour legend, stats: Total 39 / Orchestrators 1 / Read-only 0 / Dependencies 45, then an alphabetical clickable skill list that pans/centres the node), and a full-height SVG. Force simulation: `forceManyBody(-300)`, link distance 120, collide radius 40, node circles r=18 with white stroke, labels 11px under each node, straight grey lines with an arrowhead, zoom 0.3-3x, drag nodes, hover tooltip (name, TYPE, 150-char description). No search, no filter, no edge labels, no click-to-open-file, no pinning, no legend for edges.

My impression: with 25 of 45 edges leaving one node, the picture is a star around `ask-matt` with a second small cluster on `setup-matt-pocock-skills`, eight loose satellites, and the rest hanging one hop off the hub. Because every node but one is the same orange, the colouring carries no information; you can tell "ask-matt fans out to most things" in a second and nothing else without hovering each node. 11px labels under 36px circles at 120px link distance will overlap around the hub until you drag or zoom. Plausible as a first look; not a map you would navigate by. (1-5 number left to the human.)

## 8. Export formats

HTML only. No JSON, SVG, PNG, Mermaid, DOT, or Markdown output. The `nodes`/`links` arrays are inlined in a `<script>` tag (I extracted them with a regex to produce the JSON files here). Screenshots are the only path to a static image; SKILL.md calls that "Export-ready".

## 9. Works for Codex / other harnesses?

The script is harness-agnostic Python (stdlib only); it will run anywhere and could be pointed at `.codex/skills/` or `.agents/skills/` simply by installing it there, because it scans `<own dir>/../../skills` (the "root" is derived from its own location, not the cwd, and there is no CLI flag). The SKILL.md wrapper is Claude Code specific (`allowed-tools`, `argument-hint`, `$0` argument syntax), and the type detection keys on Claude Code-only frontmatter (`context: fork`, `allowed-tools`). It ignores `agents/openai.yaml`, which every fixture skill has. Windows needs `PYTHONUTF8=1` or the `-X utf8` flag.

## 10. Verdict

**Skip** (borrow one layout idea at most). License MIT (Martin Hylleberg, 2025-2026). Detection is pure substring matching in a 628-line script, no LLM judgment, so it is deterministic, fast, and easy to read, but the heuristics are too coarse for this library: 3 false edges from the `/pr` prefix, 18 real references missed because it does not know the `Skill tool with "X"` idiom and reads only SKILL.md, zero signal on invocation mode because it looks at `context: fork`/`allowed-tools` (which the fixture never uses) instead of `disable-model-invocation` (which 24 skills use), and it classifies itself as an orchestrator by matching its own legend. The `deps` mode is a copy of `skills`, `codebase` is a file tree, D3 comes from a CDN, and every run opens a browser. Repo activity: 97 commits since 2025-12-07, last push 2026-09-02, 19 stars, 1 fork, 2 open issues; the visualizer folder has had exactly one commit (2026-01-29, "align skills with Claude Code 2.1.x features") and is not maintained on its own. The one thing worth keeping is the shape of the page: sidebar with legend + stats + clickable node list that pans the graph, which is about 80 lines of D3 and cheaper to rewrite than to fork.
