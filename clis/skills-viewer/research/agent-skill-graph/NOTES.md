# Agent Skill Graph + skill-graph-builder trial (issue #58)

Trial date: 2026-09-27. Host: Windows 11 Pro, Python 3.12.8, Node v24.21.0, npm 12.1.0, Git Bash.
Fixture: `clis/skills-viewer/fixtures/mattpocock-skills` (38 skill folders, each with `SKILL.md`), read-only; verified unchanged afterwards with `diff -rq` against the scratch copy.
Scratch: `C:\Users\Justin\.claude\jobs\9f3eb07d\tmp\agent-skill-graph-trial\`. No user skill directory (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`) was read or written; every path was overridden to scratch.

Companion files in this folder:

- `vault/` — the generated Obsidian vault (see "Readability" for what was changed in the copy).
- `discover.json` — the scanner's discover-phase output.
- `ground-truth-edges.json` — skill→skill references grepped from the fixture (52 edges).
- `edges-flat.json`, `edges-classic.json`, `simulate-edges.cjs` — the Obsidian plugin's real reference parser run over the vault (flat) and over the fixture opened directly as a vault (classic).
- `scanner-pytest.log` — the scanner's own test-suite run on Windows.

## Step 0: fact-finding (which repos are real)

| URL | HTTP | Note |
|---|---|---|
| https://github.com/sabahmax-dev/obsidian-skill-graph | 404 | The brief's source URL; wrong owner. |
| https://community.obsidian.md/plugins/agent-skill-graph | 200 | Listing page; links `github.com/hanamizuki/obsidian-skill-graph` and `github.com/hanamizuki/skill-graph-builder`. |
| https://obsidian.md/plugins?id=agent-skill-graph | 200 | Redirects to the listing above. |
| https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json | 200 | 8,131 plugins. Entry: `{"id":"agent-skill-graph","name":"Agent Skill Graph","author":"hanamizuki","repo":"hanamizuki/obsidian-skill-graph"}`; description ends "This plugin has not been manually reviewed by Obsidian staff." |
| https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json | 200 | `agent-skill-graph`: 638 downloads (0.1.0: 134, 0.1.1: 504). |
| https://github.com/hanamizuki/obsidian-skill-graph | 200 | Plugin. TypeScript, MIT, 51 stars, 7 forks, 1 open issue, created 2026-04-01, last push 2026-05-19, 44 commits, releases 0.1.0 (2026-04-01) and 0.1.1 (2026-05-17). |
| https://github.com/hanamizuki/skill-graph-builder | 200 | Scanner. Python, MIT, 0 stars, 0 forks, created and last pushed 2026-05-19, **2 commits total** ("Initial public release", "Skip PyYAML-dependent tests when PyYAML is absent"). |
| https://raw.githubusercontent.com/hanamizuki/skill-graph-builder/main/README.md | 200 | Install is `git clone` + `pip install -e .` or copy the folder into a skills dir; no package name. |
| https://raw.githubusercontent.com/hanamizuki/obsidian-skill-graph/main/README.md | 200 | |
| https://pypi.org/pypi/skill-graph-builder/json | 404 | Not on PyPI. |
| https://registry.npmjs.org/skill-graph-builder | 404 | Not on npm. |
| https://api.github.com/repos/hanamizuki/{skill-graph-builder,obsidian-skill-graph} | 200 | Source of the metadata above. |

The scanner is `hanamizuki/skill-graph-builder`, a Python 3.11+ package (`pyproject.toml` name `skill-graph-builder` 0.1.0, zero hard deps, optional `PyYAML` for OpenClaw/Hermes). It is distributed only as a git checkout meant to be dropped into `~/.claude/skills/` and driven by its own `SKILL.md` (`/skill-graph-builder`), or run headless via `python -m scripts.discover` / `python -m scripts.generate`. The plugin README's "Companion Tool" section links it; the two share no code.

## Scorecard

### Installed and ran cleanly?

**Yes for the scanner's runtime path and the plugin build; the scanner's own test suite fails on Windows.**

Scanner:

```
git clone https://github.com/hanamizuki/skill-graph-builder.git   # into scratch
git clone https://github.com/hanamizuki/obsidian-skill-graph.git   # into scratch
python -m venv venv
venv/Scripts/python -m pip install -e "./skill-graph-builder[dev]"
# -> skill-graph-builder 0.1.0 (editable), PyYAML 6.0.3, pytest 9.1.1
```

Scratch layout (copies of the fixture, never the real dirs):

```
<scratch>/home/.claude/settings.json          ({} , the Claude Code config marker)
<scratch>/home/.claude/skills/<38 folders>/   (cp -r of the fixture)
<scratch>/home/.codex/config.toml             (model = "gpt-5", the Codex config marker)
<scratch>/home/.agents/skills/<38 folders>/   (cp -r of the fixture; Codex "user scope")
<scratch>/vault/.skill-graph-builder.manifest.toml
```

Discover (env vars redirect every standard location into scratch; Python on Windows expands `~` via `USERPROFILE`):

```
cd <scratch>/skill-graph-builder
USERPROFILE=<scratch>\home HOME=<scratch>/home CLAUDE_CONFIG_DIR=<scratch>\home\.claude CODEX_HOME=<scratch>\home\.codex \
  venv/Scripts/python -m scripts.discover      # exit 0, JSON on stdout (saved as discover.json)
```

Result: `claude_code` detected, one agent `claude-.claude`, `user_scope_skill_count: 38`; `codex` detected, one agent `codex-.codex`, 38; `openclaw` and `hermes` not detected (no `openclaw.json` / `profiles/*/config.yaml`), reasons printed.

Manifest (hand-written, `--path`-style: the tool has no path flag, it takes explicit config dirs in the manifest):

```toml
vault = "C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/agent-skill-graph-trial/vault"
scope = "user"
[platforms.claude_code]
configs = ["C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/agent-skill-graph-trial/home/.claude"]
[platforms.codex]
configs = ["C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/agent-skill-graph-trial/home/.codex"]
user_scope_path = "C:/Users/Justin/.claude/jobs/9f3eb07d/tmp/agent-skill-graph-trial/home/.agents/skills"
```

Generate:

```
venv/Scripts/python -m scripts.generate --vault <scratch>/vault --dry-run   # exit 0, prints "(dry run — no changes made)"
venv/Scripts/python -m scripts.generate --vault <scratch>/vault             # exit 0, silent
```

Output: `vault/skills/` with 38 file symlinks `<id>.md -> .../home/.agents/skills/<id>/SKILL.md`, `vault/agents/claude-.claude.md` and `vault/agents/codex-.codex.md`, and `vault/.skill-graph-builder.log`. Symlink creation worked because this account can create symlinks; on a Windows account without Developer Mode or `SeCreateSymbolicLinkPrivilege` `Path.symlink_to` raises `OSError: [WinError 1314]` and the run would exit 2 (not tested, inferred from `vault_writer.py`, which has no fallback to copies or junctions).

Scanner test suite (`python -m pytest`): **54 failed, 184 passed** on Windows. Every failure is a Windows-portability bug in the tests, not the runtime path we used:
- 11 `test_generate.py` + 32 `test_openclaw.py`: tests interpolate `tmp_path` (backslashes) unescaped into TOML/JSON: `manifest TOML parse failed (...): Invalid hex value (at line 1, column 14)`, `json.decoder.JSONDecodeError: Invalid \escape: line 4 column 24 (char 53)`, `scripts.json5_lite.Json5LiteError: Failed to parse OpenClaw config`.
- 3 `test_skill_md.py`: `UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d in position 413` (reads `SKILL.md`, which contains CJK, without `encoding=`).
- 2 `test_codex.py` (blacklist path comparison), 4 `test_discover.py`, 1 `test_env_expand.py` (`~` expansion), 1 `test_scan.py` (symlink escaping): path-separator / tilde assumptions.
Full log: `scanner-pytest.log`.

Plugin (build only; cannot run Obsidian here):

```
cd <scratch>/obsidian-skill-graph
npm ci --no-audit --no-fund     # OK
npm run build                   # tsc -noEmit + esbuild -> main.js (14,248 bytes)
npm test                        # vitest: 3 files, 28 tests passed
```

### Found all skills?

**38 / 38.** Nothing missed. The two physical copies of each skill (Claude layout and Codex layout, 76 `SKILL.md` files) collapse to one node each because dedup is by `(sanitised dirname, sha256 of line-ending-normalised SKILL.md text)`; the run log's "Skill provenance" section lists both source paths and both agents for every id. The representative symlink target is the lexicographically first path (here the `.agents` copy). Node id = sanitised folder name; label = frontmatter `name` (regex `^name:`), falling back to the folder name. The fixture's `name` fields all equal the folder names, so ids and labels coincide.

### Shows invocation mode?

**No.** The scanner's frontmatter parser reads only `name` and `description` (`skill_index.parse_frontmatter_fields`), and the agent note emits only `- [name](../skills/id.md)`. The plugin reads only the configured name field (default `name`) and `type: agent`. Neither mentions `disable-model-invocation` or `user-invocable` anywhere in code, README or tests. In the fixture, 22 of 38 skills carry `disable-model-invocation: true` (ask-matt, claude-handoff, grill-me, grill-with-docs, handoff, implement, implement-spec, improve-codebase-architecture, loop-me, retro, setup-matt-pocock-skills, setup-ts-deep-modules, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wayfinder, writing-beats, writing-fragments, writing-shape); none uses `user-invocable`; 4 have `argument-hint`, 1 has `metadata`. Because each vault node is the real `SKILL.md`, Obsidian's Properties panel will show these fields when a node is opened, and Obsidian's native graph "Groups" accept search queries (property search `[disable-model-invocation:true]`), so a human could colour manual-only skills without the plugin. Not verified here; that is a #59 check.

### Skill→skill edges

**What the scanner emits as links:** only agent→skill Markdown links. Two agent notes × 38 links = 76 edges, all `[name](../skills/<id>.md)`. Zero skill→skill edges; zero wikilinks. The skill nodes are the fixture's own `SKILL.md` text, which contains no `[[wikilinks]]` and whose Markdown links point outside the vault, so Obsidian's native resolver adds nothing either.

**What the plugin adds:** SKILL.md → *referenced file* edges only, from backtick paths, `[text](path)` targets and `python|bash|node|sh <path>` arguments that contain a `/` and end in an extension. It never looks for `/skill-name`, `$skill-name`, "the X skill" or `Skill tool with "X"`. I ran the plugin's real `parseReferences` (bundled from `src/parse-references.ts` with esbuild) plus a port of `SkillParser.resolveRefPath`'s three strategies over the vault file set (`simulate-edges.cjs`):

- Flat generated vault (`edges-flat.json`): **0 resolved in-vault edges**; 33 unresolved refs across 11 skills become *virtual* (grey, unopenable) nodes: `docs/agents/issue-tracker.md` (from code-review and setup-matt-pocock-skills, so one accidental shared hub), `scripts/hitl-loop.template.sh`, `./CONTEXT-FORMAT.md`, `./ADR-FORMAT.md`, `.claude/settings.json`, `~/.claude/settings.json`, `.claude/hooks/block-dangerous-git.sh`, `~/.claude/hooks/block-dangerous-git.sh`, `scripts/block-dangerous-git.sh`, `<tmpdir>/architecture-review-<timestamp>.html`, `workflows/*.md`, `docs/agents/domain.md`, `docs/agents/triage-labels.md`, `docs/agents/*.md`, `./issue-tracker-github.md`, `./issue-tracker-gitlab.md`, `./issue-tracker-local.md`, `./triage-labels.md`, `./domain.md`, `lib/impl.ts`, `tests/example.test.ts`, `<packages-root>/README.md`, `./dependency-cruiser.config.cjs`, `./src/packages/README.md`, `./reference/*.html`, `./learning-records/*.md`, `./lessons/*.html`, `./MISSION-FORMAT.md`, `./RESOURCES-FORMAT.md`, `./LEARNING-RECORD-FORMAT.md`, `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, `.out-of-scope/*.md`. Placeholder filter only drops `[ ] { }` and `YYYY`, so `<tmpdir>` and `*.md` globs survive as nodes. For `~/.claude/settings.json` the plugin will `readFileSync` the real user file (outside the vault) to look for a `name:` frontmatter field; read-only, but worth knowing.
- Classic layout (fixture folder opened directly as the vault, the plugin README's primary mode; `edges-classic.json`): 103 files, 38 skill nodes, **2 resolved edges**, both skill→own-script: diagnosing-bugs → `diagnosing-bugs/scripts/hitl-loop.template.sh`, git-guardrails-claude-code → `git-guardrails-claude-code/scripts/block-dangerous-git.sh`. Still 0 skill→SKILL.md edges. Refs written as `./X.md` (domain-modeling, setup-matt-pocock-skills, teach, setup-ts-deep-modules) are concatenated to `dir/./X.md` without normalisation; my simulation treats that as unresolved, and whether Obsidian's `getAbstractFileByPath` tolerates `./` is unverified. Even if it does, those become skill→companion-doc edges, not skill→skill.

**Ground truth (grep of the fixture, `ground-truth-edges.json`): 52 skill→skill edges from 16 sources.** Patterns: `/skill-name` (slash), `` `skill-name` `` (backtick), "the X skill", and any quoted name on a line containing "Skill tool".

- ask-matt → code-review, codebase-design, diagnosing-bugs, domain-modeling, grill-me, grill-with-docs, grilling, handoff, implement, improve-codebase-architecture, prototype, research, resolving-merge-conflicts, setup-matt-pocock-skills, tdd, teach, to-questionnaire, to-spec, to-tickets, triage, wait-what, wayfinder, wizard, writing-for-agents (24, all `/slash`)
- wayfinder → grilling, domain-modeling, research, prototype (Skill tool), setup-matt-pocock-skills (advisory)
- grill-with-docs → grilling, domain-modeling (Skill tool)
- grill-me → grilling; loop-me → grilling; triage → grilling, domain-modeling, setup-matt-pocock-skills
- improve-codebase-architecture → codebase-design, domain-modeling, grilling
- implement → code-review, tdd; implement-spec → code-review; tdd → code-review, codebase-design; setup-ts-deep-modules → codebase-design
- retro → writing-for-agents; setup-matt-pocock-skills → to-spec, to-tickets, triage
- code-review, to-spec, to-tickets → setup-matt-pocock-skills (advisory "tell the user to run /setup-matt-pocock-skills")

7 of the 52 are the advisory "run /setup-matt-pocock-skills first" kind; the other 45 are real routing or Skill-tool calls.

**Edges missed: 52 / 52.** **False skill→skill edges: 0** (it draws none). Noise: 33 virtual nodes in the flat vault that are not skills.

### Identifies entry points?

**No.** Every skill has exactly the same degree (two agent edges, one per agent note), so ask-matt, setup-matt-pocock-skills and wayfinder are indistinguishable from wizard or pr. There is no in/out-degree, no "root" concept, no ordering in the agent note beyond alphabetical within a source section.

### Shows sequential / parallel / loop structure?

**No.** The data model is `AgentRecord.accessible_skills: tuple[SkillRecord]` — a flat set per agent. Nothing reads skill bodies for control flow; the plugin's edges are undirected (Obsidian graph links have no arrows, stated in its README's Known Limitations).

### Readability

I could not open Obsidian; a human must (issue #59). What the vault looks like on disk:

```
vault/
  .skill-graph-builder.manifest.toml   # the input manifest (absolute scratch paths)
  .skill-graph-builder.log             # "Skill provenance" section: per id, both source paths + both agent ids
  .obsidian/community-plugins.json     # ["agent-skill-graph"]  (added by me, not by the scanner)
  .obsidian/plugins/agent-skill-graph/ # main.js, manifest.json, styles.css from the build above (added by me)
  agents/claude-.claude.md             # frontmatter: name, type: agent, platform, profile, source; 38 md links
  agents/codex-.codex.md               # same, 38 md links
  skills/<id>.md  x38                  # in scratch: file symlink to the real SKILL.md; here: a real copy (cp -rL)
```

Expected graph: 40 nodes, 76 edges, a bipartite shape: two agent hubs (green in the plugin) each connected to all 38 skills (orange), and, once the plugin is on, 33 grey virtual nodes hanging off 11 skills. Note counts: 2 agent notes, 38 skill notes. Frontmatter: agent notes carry the five fields above; skill notes carry the fixture's own (`name`, `description`, `disable-model-invocation` on 22, `argument-hint` on 4, `metadata` on 1). Links per note: 38 Markdown links per agent note, 0 vault links per skill note. Wikilinks: none anywhere. Agent ids come from the config dir basename, so they are `claude-.claude` / `codex-.codex`; with a real `~/.claude` they read the same.

Changes in the copy under `vault/`: symlinks were dereferenced (they pointed at scratch and would be dead), the `.obsidian/` folder with the built plugin was added so #59 can open the folder as a vault and enable the plugin straight away (total `.obsidian` size 20 KB, far under the 1 MB skip threshold; there was no cache to skip). Vault size 257 KB.

### Export formats

None. The scanner's only outputs are the Markdown vault, the plain-text provenance log, and `discover`'s JSON agent list (schema_version 2, agents and skill counts only, no edges). No JSON/DOT/Mermaid/GraphML/SVG of the graph. The plugin is read-only, in-memory (patches PixiJS node labels/colours and injects into `metadataCache.resolvedLinks`/`unresolvedLinks`), and Obsidian's graph view has no export beyond a screenshot.

### Works for Codex / other harnesses?

**Yes for Claude Code and Codex at user scope; OpenClaw and Hermes not exercised (no configs, PyYAML needed).** It is the only tool in this batch that models "which agent can see which skill" rather than skills alone. Layouts, from `scripts/platforms/*.py` and `scripts/scan.py`:

- **Claude Code**: an agent is any directory directly containing `settings.json` (`CLAUDE.md` alone is deliberately not enough). Skills = `<config>/skills/**/SKILL.md` (recursive, follows symlinks) + enabled plugins from `<config>/plugins/installed_plugins.json` (v1 and v2 schemas, filtered by `settings.json` `enabledPlugins`; scans each plugin's `skills/`, `commands/`, `workflow-skills/`).
- **Codex**: an agent is any directory directly containing `config.toml`. Skills = `user_scope_path` (default `~/.agents/skills`, shared) + `<config>/skills/.system` + `/etc/codex/skills`, minus `[[skills.config]] enabled = false` paths.
- **OpenClaw**: agents from `agents.list[]` in `openclaw.json` (JSON5-lite parser); six source tiers (`extraDirs`, bundled, `~/.openclaw`, `~/.agents`, `<workspace>/.agents`, `<workspace>/skills`) with allowlist/blacklist semantics; requires PyYAML.
- **Hermes**: an agent per `<profiles_dir>/<name>/config.yaml`; skills from `$HERMES_HOME/skills`, `skills.external_dirs[]` (env-expanded) and `plugins/*/skills`; requires PyYAML.
- **Not covered (v1 "user scope only")**: project/repo-level skills such as `<repo>/.claude/skills`, `<repo>/.agents/skills` or a fixture folder like ours. There is no `--path` flag; to scan an arbitrary folder you must stage it as `<something>/.claude/skills/` next to a `settings.json` (or as `~/.agents/skills` for Codex), which is exactly what I did. `discover` also walks the current working directory for config markers (`settings.json`, `config.toml`, `openclaw.json`, `profiles/*/config.yaml`), pruning `node_modules`, `.git` and known non-Claude `settings.json` owners.

In this run both agents saw all 38 and the log correctly attributed each node to both.

### Verdict: **borrow one idea, otherwise skip.**

Neither piece answers the questions this trial is about: zero skill→skill edges (52 exist), no invocation mode, no entry points, no flow structure, no export. What the pair does uniquely is the *agent → visible skill* access graph across four harnesses with content-hash dedup and a provenance log, and that per-harness config-marker logic in `scripts/platforms/` plus `scan.py` is worth borrowing as a reference for how Claude Code, Codex, OpenClaw and Hermes lay out user-scope skills and plugins. Both are MIT, plugin in TypeScript (44 commits, 51 stars, v0.1.1, relies on undocumented Obsidian internals like `renderer.nodes` and `node.text._text`), scanner in Python 3.11+ stdlib (2 commits, 0 stars, one-day-old public history, test suite broken on Windows). Detection is filesystem-only: config marker files for agents, recursive `SKILL.md` walk for skills, `name:` regex for labels; the plugin's edges come from path-shaped strings in the body. Forking would mean adding a skill-reference extractor and a frontmatter-to-colour mapping to a plugin that only works inside Obsidian's graph view, which is more than it gives back.

## Summary

1. Real repos: `hanamizuki/obsidian-skill-graph` (plugin, TS, MIT, 51 stars, v0.1.1) and `hanamizuki/skill-graph-builder` (scanner, Python, MIT, 2 commits); brief's `sabahmax-dev` URL is a 404; neither is on npm or PyPI.
2. Scanner installed in a venv from a git clone, ran `discover` and `generate` cleanly (exit 0) against scratch copies of the fixture in Claude Code (`home/.claude/skills`) and Codex (`home/.agents/skills`) layouts; its own pytest suite fails 54/238 on Windows from unescaped paths and encoding.
3. Plugin builds (`npm ci && npm run build`, 28 unit tests pass) and is pre-installed in the copied vault's `.obsidian/`.
4. Found 38/38 skills, deduped 76 physical copies to 38 nodes with a provenance log.
5. No invocation mode: parser reads only `name`/`description`; 22 fixture skills have `disable-model-invocation: true` that nothing surfaces.
6. Skill→skill edges: 0 of 52 found; scanner emits only 76 agent→skill Markdown links; plugin would add 0 in-vault edges and 33 grey virtual nodes (globs, placeholders, out-of-repo paths) in the flat vault, 2 script edges in the classic layout.
7. No entry points, no sequence/parallel/loop, no export format.
8. Multi-harness is real for Claude Code + Codex (verified) and claimed for OpenClaw + Hermes (PyYAML, not exercised); user scope only, no `--path`, no repo-level skills.
9. Vault (40 notes, dereferenced) is at `research/agent-skill-graph/vault/`; a human must open it in Obsidian (#59).
10. Verdict: skip as a tool; borrow the per-harness config-marker and skill-directory logic from `scripts/platforms/` as reference.
