# skills-viewer

Statically analyze a folder of agent skills (`SKILL.md` files) and generate a clean visual map: where to start, what each skill does, what it calls, and how (sequential, parallel, loop). One self-contained HTML file, no frontend framework.

```
npx skills-viewer [path...]            # writes ./skills-graph/{graph.json,graph.mmd,graph.html} and opens it
npx skills-viewer --watch --host       # serves the page, re-analyzes on change, auto-refreshes; prints network URLs
```

Until it is published to npm, run it from this package (`pnpm install` once at the workspace root):

```
cd packages/skills-viewer
pnpm build
node dist/src/cli.js fixtures/mattpocock-skills --out examples/mattpocock
node dist/src/cli.js --watch --host             # scans the default roots below
```

## What it reads

- **Roots**: the paths you pass, or by default `.claude/skills`, `.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, and the `skills/` folder of a `.claude-plugin/plugin.json` manifest. Symlinked skills are followed and de-duplicated by real path.
- **Frontmatter**: `name`, `description`, `user-invocable`, `disable-model-invocation`, `allowed-tools`, `context`, `model`, `argument-hint`. Codex's `agents/openai.yaml` (`allow_implicit_invocation: false`) is read as manual-only for Codex.
- **Body**: every line, with the line number kept for evidence.

## What it shows

**Node color = how the skill can be triggered**

| mode | frontmatter | meaning |
|---|---|---|
| auto (green) | default | the agent picks it from its description, and you can `/slash` it |
| manual-only (orange) | `disable-model-invocation: true` | you must `/slash` (Claude) or `$mention` (Codex) it; usually an entry point |
| model-only (purple) | `user-invocable: false` | hidden from the slash menu; only the agent loads it |

Badges: **▶ entry point** = manual-only and nothing calls or suggests it. **↳ sub-skill** = not manual-only and something calls it.

**Edges = relationships found in skill bodies** (calls, suggests, needs first, reference). Every edge carries the SKILL.md line and snippet that produced it; the detail panel shows them. An edge is flagged ⚠ when a skill *calls* a manual-only skill, because the model may not be able to invoke it (see anthropics/claude-code#92769).

**Flows** are boxes: `step 1 → 2 → 3 → result` for ordered lists that call skills, a fan-out with a join for "in parallel", and a box with a back-arrow labelled with the exit condition for "loop until …".

**Viewer**: search → click a skill → its neighborhood (what it calls, two hops down, one hop up) plus a detail panel. "Whole library" shows everything. Toggles for flows, suggests, references and files. Fit and zoom. Copy Mermaid, download `.mmd` and `graph.json`.

## How edges are detected (layer 1, regex)

In priority order, each consuming its span so a mention counts once: `Call the Skill tool with "x"` (also `twice, for "x" and "y"`), markdown links to another `…/x/SKILL.md`, `skill://x`, prose `the x skill`, `/x`, `$x`, `@x`, `` `x` `` (known skills only) and bare hyphenated names (known skills only). Names that resolve to nothing in the library are listed under "mentioned names not in this library" rather than dropped.

The relationship type comes from the words around the mention: "if not, tell the user to run", "before you", "should have been" → **needs first**; "→ /x", "/x is for…", "tell the user to…" → **suggests**; "call / run / use / invoke /x" or an imperative at the start of a line → **calls**; anything else → **reference**. One edge per (source, target): its type is the strongest type backed by at least two mentions, otherwise the strongest single mention. A skill that points at eight or more others is treated as a router (an index for the human), so its slash mentions are suggestions, not calls.

Layer 2 (an optional LLM pass that classifies sequential / parallel / loop relationships as dashed edges) is not built yet.

## Outputs

- `graph.json`: nodes, edges, flows, unresolved mentions, meta. The single source of truth.
- `graph.mmd`: Mermaid flowchart, portable (no HTML labels, no click handlers).
- `graph.html`: the viewer, with `graph.json` and the Mermaid generator embedded. Loads Mermaid 11 from jsDelivr.

## Development

```
pnpm build      # tsc
pnpm test       # node:test against fixtures/mattpocock-skills
pnpm fixture    # regenerate examples/mattpocock
```

`fixtures/mattpocock-skills` is a pinned copy of the 38 Matt Pocock skills this repo installs (see `fixtures/README.md`).

## Source

This package is the engine of branch `codex/tools-skills-viewer` at commit `f333cc6` ([#54](https://github.com/oneezy/tools/issues/54)), imported into the workspace by [#75](https://github.com/oneezy/tools/issues/75). The Phase 1 trials of the four existing tools and `research/RESULTS.md`, which compares them with this one, stay in `clis/skills-viewer/research/` on that branch.
