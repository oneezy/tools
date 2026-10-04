import type { Graph } from "skills-viewer";

export type { Edge, EdgeType, Evidence, Flow, Graph, Mode, PartNode, PluginNode, SkillNode } from "skills-viewer";

/** GitHub location of a graph, from the engine's `meta.source` */
export type GitHubSource = Extract<Graph["meta"]["source"], { kind: "github" }>;

/** What GET /api/graph returns. Where it came from is `graph.meta.source`. */
export interface AnalyzeResult {
  graph: Graph;
}

export interface ApiError {
  error: string;
  /** unix seconds when GitHub's rate limit resets, when it is spent */
  rateLimitReset?: number;
}
