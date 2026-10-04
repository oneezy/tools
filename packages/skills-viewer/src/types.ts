/** The single source of truth written to graph.json. Paths are as the source reports them:
 * repo-relative for GitHub, absolute for local folders. */

export type Mode = "auto" | "manual" | "background";
export type EdgeType = "calls" | "suggests" | "prerequisite" | "reference";
export type FlowKind = "sequential" | "parallel" | "loop";
/** relations that touch a plugin part: skill edge types, plus a hook or MCP server running a script and a skill reading a file */
export type LinkType = EdgeType | "runs" | "reads";
export type PartKind = "command" | "agent" | "hook" | "mcp" | "script" | "reference" | "asset";

export interface Evidence {
  /** 1-based line in SKILL.md */
  line: number;
  /** the source line, trimmed, at most ~200 chars */
  snippet: string;
  /** which detector matched: slash, dollar, at, skill-tool, backtick, prose, link, bare, flow */
  pattern: string;
  /** how this particular mention was classified; the edge's type is the strongest of its evidence */
  type?: EdgeType;
}

export interface SkillNode {
  id: string;
  name: string;
  description: string;
  /** union of harness modes: manual if any harness says manual-only, background if hidden from the slash menu */
  mode: Mode;
  invocation: { claude: Mode; codex: "auto" | "manual" };
  /** manual-only with no incoming edges */
  entry: boolean;
  /** reached by call/prerequisite edges from other skills and not manual-only */
  subSkill: boolean;
  dir: string;
  file: string;
  bodyLines: number;
  argumentHint?: string;
  allowedTools?: string[];
  context?: string;
  model?: string;
  scripts: string[];
  references: string[];
  /** every frontmatter key as parsed, for the detail panel */
  frontmatter: Record<string, unknown>;
  /** plugin id when the skill ships inside a plugin */
  plugin?: string;
  /** other SKILL.md paths with the same id (e.g. a built plugins/x/skills copy); the node is built from `file` */
  copies?: string[];
}

/** Anything in a library that is not a skill: plugin commands, agents, hooks, MCP servers, and the files next to a skill. */
export interface PartNode {
  /** `<kind>:<scope>/<name>`, scope being the plugin name, the skill id, or "project" */
  id: string;
  kind: PartKind;
  /** what a person types or sees: the slash name for a command, the agent name, "PreToolUse (Bash)" for a hook, a file path relative to its owner */
  name: string;
  description: string;
  plugin?: string;
  /** owning skill id, for scripts, references and assets */
  skill?: string;
  /** the file that defines it; for inline hooks and MCP servers, the manifest that holds them */
  file: string;
  /** kind-specific fields: frontmatter for commands and agents; event, matcher, type, command for hooks; transport, command, args, url, env keys for MCP */
  details: Record<string, unknown>;
}

export interface PluginNode {
  /** `plugin:<name>` */
  id: string;
  name: string;
  description: string;
  version?: string;
  /** plugin root folder ("" for the repo root) */
  dir: string;
  /** plugin.json files read (.claude-plugin, .codex-plugin, root) */
  manifests: string[];
  skills: string[];
  parts: string[];
}

export interface Marketplace {
  name: string;
  description: string;
  file: string;
  /** listed plugins; pluginId is set when the source is a folder in this repo and was read */
  plugins: Array<{ name: string; description: string; source: string; pluginId?: string }>;
}

export type Source =
  | { kind: "local"; roots: string[] }
  | {
      kind: "github";
      owner: string;
      repo: string;
      /** branch, tag or sha asked for; "HEAD" for the default branch */
      ref: string;
      /** commit sha when the fetch revealed it (tarball) */
      sha?: string;
      /** folder inside the repo the map is scoped to */
      subpath?: string;
      url: string;
      /** prefix a node's `file` with this to link to it on GitHub */
      blobBase: string;
      via: "tree" | "tarball";
    };

export interface Edge<T extends string = EdgeType> {
  source: string;
  target: string;
  type: T;
  /** set when the target is manual-only: the model may not be able to invoke it */
  warning?: "manual-target";
  evidence: Evidence[];
}

export interface Flow {
  id: string;
  kind: FlowKind;
  /** the skill whose body describes the flow */
  owner: string;
  /** skill ids in order (sequential), fanned out (parallel), or repeated (loop) */
  steps: string[];
  label: string;
  /** loop exit condition when found */
  until?: string;
  evidence: Evidence[];
}

export interface UnresolvedMention {
  name: string;
  count: number;
  sources: string[];
}

export interface Graph {
  meta: {
    generatedAt: string;
    roots: string[];
    skillCount: number;
    edgeCount: number;
    flowCount: number;
    partCount: number;
    pluginCount: number;
    version: string;
    source: Source;
    /** non-fatal problems: unparsable manifests, a truncated GitHub tree */
    warnings: string[];
  };
  /** skills */
  nodes: SkillNode[];
  /** skill -> skill only, unchanged from v0.1 */
  edges: Edge[];
  plugins: PluginNode[];
  marketplaces: Marketplace[];
  parts: PartNode[];
  /** every relation with a part at either end: command -> skill, skill -> script, hook -> script, ... */
  links: Edge<LinkType>[];
  flows: Flow[];
  unresolved: UnresolvedMention[];
}
