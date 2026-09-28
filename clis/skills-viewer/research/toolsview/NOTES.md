# toolsview trial (oneezy/tools#55)

Tool: `toolsview` 1.9.0, https://github.com/tupe12334/tools-view (npm `toolsview`).
Fixture: `clis/skills-viewer/fixtures/mattpocock-skills` (38 skill folders), copied read-only into a scratch repo at `C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\toolsview-trial\.claude\skills\`.
Date: 2026-09-27. Host: Windows 11, Node v24.21.0, npm 11.19.0, pnpm 12.5.1.

Output files copied next to this note: `graph.json` (175 KB) and `graph.html` (843 KB). Both were produced by the run below, unmodified.

## Installed and ran cleanly?

Yes. No install step; the README says `npx toolsview` / `pnpm dlx toolsview`, Node >= 18.

```
cd C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/toolsview-trial
git init
cp -r <fixture>/. .claude/skills/
npx --yes toolsview@latest
```

Output (stderr), exit code 0:

```
Skills: 38  Agents: 0  Edges: 34
Written → C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\toolsview-trial\.claude\graph\graph.json
Opening → file:///C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/toolsview-trial/.claude/graph/graph.html
```

Wall time was a few seconds including the npx fetch. It wrote `.claude/graph/graph.json`, `.claude/graph/graph.html` and a `.claude/graph/.gitignore` containing both filenames. No errors, no warnings apart from an unrelated npm "new major version" notice.

Side effect worth knowing: it always tries to open the HTML in the default browser via `start "" "<file url>"` on Windows (`open` on macOS, `xdg-open` elsewhere). The only opt-out is the env var `TOOLSVIEW_NO_OPEN=1`; I set `BROWSER=none`, which it ignores, so a browser tab most likely opened on the host during the run. The output directory is fixed (`<dir containing skills>/graph/`); there are no CLI flags at all (`main.ts` reads none).

## Found all skills?

38 of 38. Node ids are the folder names; frontmatter `name` is used for the display label only. Discovery (`find-skill-ids.ts`) recurses into subfolders and dedupes by folder name, so nested layouts work. It only reads `SKILL.md`; the sibling files the fixture ships (`agents/openai.yaml`, `references`-style `*.md`, `scripts/*`) are ignored, which matters for edges (below).

Skills-dir discovery (`find-skills-dir.ts`) walks up from cwd and accepts, in order: `<dir>/.claude/skills`, `<dir>/skills` containing a SKILL.md anywhere, or `<dir>` itself if it has >= 2 immediate child folders with SKILL.md. Agents come only from `.claude/agents/*.md`.

## Shows invocation mode?

No. The node record is `{id, name, description, allowedTools, filePath, type, body}` (see graph.json). `parse-skill.ts` reads only `name`, `description` and `allowed-tools` from frontmatter; `disable-model-invocation` (set on 22 of the 38 fixture skills) and `user-invocable` are dropped. The hover tooltip shows name, type (skill/agent), truncated description and the allowed-tools list. Nothing distinguishes auto / manual-only / model-only skills.

## Skill -> skill edges

### How detection works (from `src/extract-edges.ts`, `src/classify-ref.ts`, `src/skill-call/extract-skill-call-edges.ts`)

1. For every ordered pair (source, target) it runs the regex `` new RegExp(`/${targetId}(?=[^a-z0-9-]|$)`, 'gi') `` over the source's SKILL.md body (frontmatter stripped by gray-matter). So an edge needs a literal `/target-name` slash mention.
2. For each match it takes `body.slice(m.index - 120, m.index)`, the 120 characters before the slash, lowercases it, and `classifyRef` picks a type by substring tests in priority order: `prerequisite` if it contains "prerequisite", "run"+"before", "require", "must have", "ensure" or "active session"; `calls` if "full logic in", "apply those instructions", "calls", "using", "invokes" or "step"+"run"; `suggests` if "suggest", "next step", "next:", "then run" or "guide"+"run"; else `references`.
3. A second scanner, `extractSkillCallEdges`, matches `` /\bskill\s*=\s*['"]([^'"]+)['"]/gi `` (i.e. `skill="name"`) and emits `calls`.
4. Multiple mentions of the same target collapse to one edge with the highest-priority type (`TYPE_PRIORITY`: prerequisite 3 > calls 2 > suggests 1 > references 0). Direction, count and position are not recorded; the edge is just `{from, to, type}`.

Not matched: `$skill-name`, `` `skill-name` `` in backticks alone, "the X skill", `Skill tool with "X"`, `Skill(...)`, wikilinks, or any mention in a sibling reference file.

### Edges found (34; all 34 are real, 0 false)

```
ask-matt -> code-review                    references
ask-matt -> codebase-design                references
ask-matt -> diagnosing-bugs                references
ask-matt -> domain-modeling                references
ask-matt -> grill-me                       references
ask-matt -> grill-with-docs                calls          (misclassified, see below)
ask-matt -> grilling                       references
ask-matt -> handoff                        references
ask-matt -> implement                      references
ask-matt -> improve-codebase-architecture  references
ask-matt -> prototype                      references
ask-matt -> research                       references
ask-matt -> resolving-merge-conflicts      references
ask-matt -> setup-matt-pocock-skills       references
ask-matt -> tdd                            prerequisite   (misclassified, see below)
ask-matt -> teach                          references
ask-matt -> to-questionnaire               references
ask-matt -> to-spec                        references
ask-matt -> to-tickets                     references
ask-matt -> triage                         references
ask-matt -> wait-what                      references
ask-matt -> wayfinder                      references
ask-matt -> wizard                         references
ask-matt -> writing-for-agents             calls          (misclassified, see below)
code-review -> setup-matt-pocock-skills    references
implement -> code-review                   references
implement -> tdd                           references
implement-spec -> code-review              references
improve-codebase-architecture -> codebase-design  references
loop-me -> grilling                        references
to-spec -> setup-matt-pocock-skills        references
to-tickets -> setup-matt-pocock-skills     references
triage -> setup-matt-pocock-skills         references
wayfinder -> setup-matt-pocock-skills      references
```

Type breakdown: 31 references, 2 calls, 1 prerequisite. The three non-`references` types are keyword accidents, not real semantics:

- `ask-matt -> tdd` is `prerequisite` because one of the 120-char windows before a `/tdd` mention reads "...by running **`/code-review`**, a two-axis review ... before committing. Reach for **`" (contains "run" and "before").
- `ask-matt -> grill-with-docs` is `calls` because a window contains "using the `CONTEXT.md` vocabulary".
- `ask-matt -> writing-for-agents` is `calls` because the preceding bullet says "using the current directory as a stateful workspace".

### Ground truth and misses

I grepped the fixture myself for `/name`, `$name`, "the X skill", `Skill tool with "X"` / `Skill tool twice, for "X" and "Y"`, and `skill="X"`, restricted to names that exist in the set. Result: 50 real source->target pairs in SKILL.md bodies (54 counting sibling reference files). toolsview found 34. Recall 68 % on SKILL.md bodies (63 % counting sibling files), precision 100 %. The `$name` form does not occur in this fixture.

Missed, present in the SKILL.md body (16), all because the phrasing is `call the Skill tool with "X"` / `the X skill` rather than `/X`:

```
grill-me -> grilling
grill-with-docs -> grilling
grill-with-docs -> domain-modeling
improve-codebase-architecture -> grilling
improve-codebase-architecture -> domain-modeling
retro -> writing-for-agents
setup-matt-pocock-skills -> triage          ("the triage skill")
setup-ts-deep-modules -> codebase-design
tdd -> code-review                          ("the `code-review` skill")
tdd -> codebase-design
triage -> grilling
triage -> domain-modeling
wayfinder -> research
wayfinder -> prototype
wayfinder -> grilling
wayfinder -> domain-modeling
```

Missed because the mention lives in a sibling file that toolsview never opens (4):

```
setup-matt-pocock-skills -> domain-modeling               (domain.md)
setup-matt-pocock-skills -> grill-with-docs               (domain.md)
setup-matt-pocock-skills -> improve-codebase-architecture (domain.md)
setup-matt-pocock-skills -> wayfinder                     (issue-tracker-*.md)
```

Against the ground truth the caller gave:

- ask-matt routes to many skills: found (24 out-edges), but typed as flat `references`.
- wayfinder calls grilling, domain-modeling, research, prototype: all four missed. The only wayfinder edge found is `wayfinder -> setup-matt-pocock-skills`.
- grill-with-docs uses grilling: missed.
- tdd / implement reference each other: `implement -> tdd` found. The reverse does not exist in the fixture text (tdd's SKILL.md names code-review and codebase-design, not implement), so nothing to find there.
- setup-matt-pocock-skills is the installer: shows up as the biggest *sink* (6 in-edges, 0 out-edges), because every skill that says "run /setup-matt-pocock-skills first" points at it and its own outbound mentions are in sibling files. Its actual role is inverted in the picture.

False edges: none. The slash regex with a word-boundary lookahead was precise on this corpus.

## Identifies entry points?

No. There is no notion of root, entry, in/out degree, ranking or grouping. Visually ask-matt becomes the obvious hub (24 of 34 edges leave it) so a human will spot it; setup-matt-pocock-skills reads as a dependency everyone needs rather than a starting point; wayfinder has one out-edge and one in-edge and looks like a leaf. 11 of 38 nodes have no edges at all and float loose: claude-handoff, git-guardrails-claude-code, migrate-to-shoehorn, pr, retro, scaffold-exercises, setup-pre-commit, setup-ts-deep-modules, writing-beats, writing-fragments, writing-shape.

## Shows sequential / parallel / loop structure?

No. Edges are an unordered set of `{from, to, type}` with four types (prerequisite / calls / suggests / references); no step numbers, no ordering within a source, no fan-out/parallel marker, no cycle detection. The only structural aid is Alt-click on a node, which extracts ```` ```mermaid ```` blocks from that skill's body and opens each on mermaid.live (with matching skill ids restyled green). Exactly one fixture file (`pr/SKILL.md`) contains a mermaid block, so that feature is almost moot here.

## Readability at a glance (impression; number left to the human)

I could not capture a screenshot: the Claude-in-Chrome extension rejects `file://` URLs and, on a second try over `http://127.0.0.1:8765`, reported "Browser extension is not connected" (and port 8765 was already in use on this host). The description below comes from the viewer source (`src/viewer/main.ts`, `renderer/cytoscape-renderer.ts`, `template.html`) and the data.

- Full-window dark canvas (#0f1117), a top bar with the title "Skills Graph", a node-type legend, an edge-type legend (red prerequisite, blue calls, green suggests, grey references) and a "Spacing" slider.
- Layout is cytoscape `fcose` (force-directed, randomised) only. `dagre` is bundled and the renderer has a `hierarchical` branch, but the viewer never exposes it, so there is no top-down or left-right view.
- Nodes are rounded rectangles auto-sized to their label. Hover shows the tooltip; Shift-click fades everything except the node's neighbourhood; plain click opens the file on github.dev if a GitHub/GitLab remote was parsed (here `git` is null, so it just `alert()`s the path); Alt-click is the mermaid feature.
- Given this data the picture is: one star (ask-matt) with 24 grey dashed spokes, a smaller star converging on setup-matt-pocock-skills, five two-node stubs (implement -> tdd / code-review, implement-spec -> code-review, improve-codebase-architecture -> codebase-design, loop-me -> grilling), and 11 orphans pushed to the rim. 31 of 34 edges share the same grey dashed style, so the type colouring adds nothing here. No search box, no filter, no clustering. My impression: fine for "which skills mention which", not a workflow map.

## Export formats

- `graph.json`: `{generated, skillsDir, agentsDir, git, nodes[], edges[]}`; nodes include the full markdown `body`, which is why it is 175 KB for 38 skills.
- `graph.html`: single self-contained file (cytoscape + fcose + dagre + viewer bundled, data inlined as `window.__GRAPH_DATA__`). No external scripts or fonts, so it opens straight from disk: double-click it or `start graph.html`. No server needed.
- Nothing else: no PNG/SVG, no Mermaid, no DOT, no Markdown. `window.__toolsview.renderer` is exposed, so `cy.png()` is reachable from devtools by hand, but that is not a feature.

## Works for Codex / other harnesses?

Partly, by accident. Paths checked are `.claude/skills`, a `skills/` folder, or any folder with >= 2 skill subfolders, so running it from inside `.agents/skills` or `.codex/skills` works (output then lands in `.agents/graph/` or `.codex/graph/`). It does not look for those folders by name, ignores each skill's `agents/openai.yaml`, and only understands `.claude/agents/*.md` for agents. Edge detection is tuned to Claude's `/slash` style; Codex-style prose references are not matched. No plugin/marketplace awareness, no multi-root merge.

## Verdict: borrow ideas (do not adopt as-is; fork is possible but low value)

Reasoning: it runs cleanly and finds every skill folder, but the edge layer is a single slash-mention regex, so on this library it recovers 68 % of the real references, none of the "call the Skill tool with X" edges that carry the actual workflow (wayfinder's four calls, grill-with-docs -> grilling), and its four-type classifier fires on incidental words like "using" and "before". It records nothing about invocation mode, entry points or ordering, and the only layout is force-directed, so the result is a mention graph rather than a map. The code is small and clean (TypeScript, ~30 tiny modules, vitest + Playwright coverage, MIT), so the reusable ideas are cheap to lift: the recursive skill-dir walk with dedupe, the fixed-window-before-mention classifier pattern (with better keywords), the highest-priority-wins edge merge, and the "inline data into one HTML file" packaging. A fork would need new scanners (Skill-tool phrasing, backticked names, sibling files), frontmatter fields for invocation mode, degree-based entry-point marking and a dagre view; that is most of the tool.

Facts: license MIT; language TypeScript (ESM, bundled with Vite/esbuild into one 680 KB `dist/index.js`); runtime deps `cytoscape`, `cytoscape-dagre`, `cytoscape-fcose`, `gray-matter`; engines node >= 18. Repo created 2026-04-26, 1 star, 0 forks, single contributor (tupe12334, 81 commits), last commit 2026-07-27 ("chore(lint) ..."), latest tag v1.9.0, 2 open issues (changesets tooling; replace hand-rolled openBrowser with `open`). Edge detection internals: regex in `src/extract-edges.ts` line 13 (`/${targetId}(?=[^a-z0-9-]|$)`), the 120-char context is `body.slice(Math.max(0, m.index - 120), m.index)` on line 16, keyword tables in `src/classify-ref.ts`, priorities in `src/type-priority.ts`, and the `skill="name"` scanner in `src/skill-call/extract-skill-call-edges.ts`.

## How to view graph.html

Open `graph.html` in this folder directly in a browser (double-click, or `start graph.html` from PowerShell). It is self-contained; no server, no network. Controls: hover for tooltip, drag to pan, wheel to zoom, Shift-click a node to isolate its neighbourhood, click background to clear, slider to change spacing. Plain click on a node only alerts the file path because the scratch repo had no git remote.
