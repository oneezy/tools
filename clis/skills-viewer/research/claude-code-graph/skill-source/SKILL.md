---
name: claude-code-graph
description: Generate dependency graph and structural analysis of Claude Code plugins
argument-hint: "[path] [--json|--mermaid] [--output FILE]"
allowed-tools: [Read, Glob, Grep, Write]
---

# Claude Code Graph

Generate a structural analysis and dependency graph of a Claude Code plugin. Outputs component inventory, dependency mappings, and Mermaid visualization.

## Context

!`ls .claude-plugin/plugin.json 2>/dev/null && echo "Plugin detected" || echo "No plugin.json - specify path"`

## Output Formats

| Flag | Format | Description |
|------|--------|-------------|
| (default) | Terminal | Unicode box drawing, aligned columns, visual grouping |
| `--json` | JSON | Machine-readable full structure |
| `--mermaid` | Mermaid | Flowchart diagram only |
| `--markdown` | Markdown | Tables + collapsible mermaid for docs/GitHub |

> Full format specs with examples: [references/output-formats.md](references/output-formats.md)

## Arguments

| Argument | Description |
|----------|-------------|
| `[path]` | Path to plugin directory (default: current directory) |
| `--json` | Output raw JSON only |
| `--mermaid` | Output Mermaid diagram only |
| `--markdown` | Output with markdown tables and collapsible mermaid |
| `--output FILE` | Write output to file |

## Workflow

### Phase 1-2: Discover and Parse

Scan plugin directory for components (commands, skills, hooks, agents) from manifest, filesystem, and hooks.json. Extract name and description from each component's frontmatter.

> Full discovery commands and parsing scripts: [references/discovery-parsing.md](references/discovery-parsing.md)

### Phase 3: Build Dependency Graph

Map relationships: command-to-skill (via `See skills/*/SKILL.md` patterns), skill-to-tools (from `allowed-tools` frontmatter), skill-to-skill (via `Task` tool or `@skill-name` references), hook-to-event (from hooks.json structure).

> Full dependency mapping and JSON schema: [references/dependency-graph.md](references/dependency-graph.md)

### Phase 4: Generate Output

Render the graph in the requested format (default: terminal-friendly).

## Constraints

- Read-only analysis (no modifications)
- Fail fast if plugin.json missing (required file)
- Support both current directory and explicit path
- Generate valid Mermaid syntax

---

## References

| Reference | Content |
|-----------|---------|
| [references/discovery-parsing.md](references/discovery-parsing.md) | Phase 1-2: component discovery commands and metadata parsing |
| [references/dependency-graph.md](references/dependency-graph.md) | Phase 3: dependency mapping rules and JSON structure |
| [references/output-formats.md](references/output-formats.md) | All 4 output format specifications with examples |
