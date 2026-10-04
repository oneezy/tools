import path from "node:path";
import { analyze, VERSION } from "./analyze.js";
import { readLocal, toPosix } from "./local.js";
import type { Graph } from "./types.js";

export { VERSION };

/** Map local folders (Node only). For a GitHub repo, see loadGitHub in github.ts. */
export function buildGraph(roots: string[]): Graph {
  const abs = roots.map((r) => toPosix(path.resolve(r)));
  return analyze(readLocal(roots), { source: { kind: "local", roots: abs }, roots: abs });
}
