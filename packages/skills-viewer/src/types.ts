/** The single source of truth written to graph.json. */

export type Mode = "auto" | "manual" | "background";
export type EdgeType = "calls" | "suggests" | "prerequisite" | "reference";
export type FlowKind = "sequential" | "parallel" | "loop";

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
}

export interface Edge {
  source: string;
  target: string;
  type: EdgeType;
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
    version: string;
  };
  nodes: SkillNode[];
  edges: Edge[];
  flows: Flow[];
  unresolved: UnresolvedMention[];
}
