import type { Graph } from "skills-viewer/src/types.ts";
import type { RepoRef } from "./repo.ts";

export type { Edge, EdgeType, Flow, Graph, Mode, SkillNode } from "skills-viewer/src/types.ts";

/** What GET /api/graph returns: the engine's graph plus where it came from. */
export interface AnalyzeResult {
  source: RepoRef & {
    /** commit the tarball was cut from */
    sha: string;
    /** prefix for linking a repo-relative path to GitHub, e.g. `${blobBase}/skills/x/SKILL.md` */
    blobBase: string;
  };
  graph: Graph;
}

export interface ApiError {
  error: string;
  /** GitHub's remaining unauthenticated requests this hour, when known */
  rateLimitRemaining?: number;
  rateLimitReset?: number;
}
