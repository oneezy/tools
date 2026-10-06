# skills-viewer

Statically analyze an agent skills library or plugin, from a local folder or a GitHub repo, and map it: where to start, what each skill does, what it calls, and how (sequential, parallel, loop), plus a plugin's commands, agents, hooks, MCP servers, scripts and reference files. Output is one JSON graph (the engine for the web app) and a self-contained HTML viewer, no frontend framework.

```
npx skills-viewer [path...]            # writes ./skills-graph/{graph.json,graph.mmd,graph.html} and opens it
npx skills-viewer mattpocock/skills    # a GitHub repo, fetched without git (also full URLs, /tree/<ref>/<folder>)
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

- **Roots**: the paths you pass, or by default `.claude/skills`, `.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, and the `skills/` folder of a `.claude-plugin/plugin.json` manifest. Symlinked files are followed and de-duplicated by real path. A whole repo checkout works too: every `SKILL.md` under it is found.
- **GitHub**: `owner/repo`, `owner/repo@ref`, `https://github.com/o/r`, `git@github.com:o/r.git`, `.../tree/<ref>/<folder>` (maps only that folder) and `.../blob/<ref>/<path>/SKILL.md` (that skill's folder). A branch with slashes in its name is tried segment by segment. Two fetchers, each one GitHub API request (60 an hour without a token; `GITHUB_TOKEN` or `GH_TOKEN` raises it and opens private repos):
  - `tree` (browser-safe, what the web app uses): `git/trees/<ref>?recursive=1`, then `raw.githubusercontent.com` for only the files the parser reads (SKILL.md, manifests, commands, agents, hook and MCP config; never scripts). Both hosts allow any origin.
  - `tarball` (the CLI default): `repos/o/r/tarball/<ref>`, unpacked in memory. Its redirect target, `codeload.github.com`, does not allow browser origins, so use it from Node or a server function.
- **Plugins**: a folder with `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` (plus the neutral `plugin.json` beside them), or one listed by a `.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`. Each plugin's `commands/*.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`, `scripts/` and `bin/`, plus the `commands`, `agents`, `hooks` and `mcpServers` fields of its manifest (paths or inline). Outside plugins: `.claude/commands`, `.claude/agents`, hooks in `.claude/settings.json`, and `.mcp.json`. MCP `env` and `headers` keep their key names only, never values.
- **Skill files**: everything in a skill's folder besides `SKILL.md` and `agents/*.yaml` is a part of that skill: a **script** (`scripts/`, `bin/` or a script extension), a **reference** (`references/` or markdown/text, the context it loads) or an **asset**.
- **Duplicates**: a skill id found twice (a library that ships `skills/x` and a built `plugins/p/skills/x`) is one node. The copy outside any plugin wins, as the authored source, else the shortest path; the others are listed in `copies`. Built copies usually differ in content, so this goes by id, not by hash.
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

A menu entry with a bold title first (`- **Fix Root Causes** (**principle-fix-root-causes**). Debugging.`) is a suggestion too, and its words never start a parallel or loop flow; neither do cue words inside quotes (`"/loop until X"`).

Commands and agents are read with the same detectors, so `/deploy` in a command body links the command to the skill. A slash or bare name resolves to a skill first, then to a command or agent of that name. A skill also **runs** a script or **reads** a reference when its body names the file (`scripts/check.sh`, `PHASE-BOUNDARIES.md`), and a hook or MCP server **runs** a plugin script its command line names.

Layer 2 (an optional LLM pass that classifies sequential / parallel / loop relationships as dashed edges) is not built yet.

## Outputs

- `graph.json`: the single source of truth (`Graph` in [`src/types.ts`](src/types.ts)):
  - `meta`: counts, `version`, `warnings`, and `source`: `{ kind: "local", roots }` or `{ kind: "github", owner, repo, ref, sha?, subpath?, url, blobBase, via }`. Link a node's file as `blobBase + file`.
  - `nodes`: skills (`id`, `name`, `description`, `mode`, `entry`, `subSkill`, `file`, `plugin?`, `copies?`, frontmatter fields).
  - `edges`: skill → skill only (`calls`, `suggests`, `prerequisite`, `reference`), each with line evidence. Unchanged from 0.1.
  - `plugins`: `{ id: "plugin:<name>", name, description, version?, dir, manifests, skills, parts }`.
  - `marketplaces`: `{ name, description, file, plugins: [{ name, description, source, pluginId? }] }`.
  - `parts`: everything else, `{ id: "<kind>:<scope>/<name>", kind, name, description, plugin?, skill?, file, details }`, kind one of `command`, `agent`, `hook`, `mcp`, `script`, `reference`, `asset`. Scope is the plugin name, the skill id, or `project`.
  - `links`: every relation with a part at one end, same shape as `edges` plus the types `runs` and `reads`.
  - `flows`: sequential / parallel / loop, owned by a skill or a command; `unresolved`: names mentioned but not in the library.
  - Paths are as the source reports them: repo-relative for GitHub, absolute (posix slashes) for local folders.
- `graph.mmd`: Mermaid flowchart, portable (no HTML labels, no click handlers).
- `graph.html`: the viewer, with `graph.json` and the Mermaid generator embedded. Loads Mermaid 11 from jsDelivr.

## As a library

```ts
import { loadGitHub, parseRepoInput, analyze, memoryFileSet } from "skills-viewer"; // browser-safe
import { buildGraph } from "skills-viewer/node"; // local folders

const graph = await loadGitHub("https://github.com/mattpocock/skills", { via: "tree" });
```

`loadGitHub` throws `GitHubError` with `status`, and `rateLimitReset` (unix seconds) when the hourly limit is spent. `fetchGitHubFiles` returns the file set without analyzing it. `analyze(fileSet)` maps any in-memory files; `filesToRead(paths, read)` says which files it needs, for a source that loads lazily.

## Development

```
pnpm build      # tsc
pnpm test       # tsc, then vp test (Vitest) against fixtures/mattpocock-skills and fixtures/plugin-library
pnpm fixture    # regenerate examples/mattpocock
```

`fixtures/mattpocock-skills` is a pinned copy of the 38 Matt Pocock skills this repo installs; `fixtures/plugin-library` is a small hand-written marketplace with one plugin that has every part kind (see `fixtures/README.md`).

## Source

This package is the engine of branch `codex/tools-skills-viewer` at commit `f333cc6` ([#54](https://github.com/oneezy/tools/issues/54)), imported into the workspace by [#75](https://github.com/oneezy/tools/issues/75). The Phase 1 trials of the four existing tools and `research/RESULTS.md`, which compares them with this one, stay in `clis/skills-viewer/research/` on that branch.
