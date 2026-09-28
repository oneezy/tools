import path from "node:path";
import { findSkillFiles } from "./discover.js";
import { detect } from "./edges.js";
import { asStringArray, claudeMode, parseSkillFile, unionMode, type ParsedSkill } from "./parse.js";
import type { Graph, Mode, SkillNode } from "./types.js";

export const VERSION = "0.1.0";

export function buildGraph(roots: string[]): Graph {
  const files = findSkillFiles(roots);
  const parsed: ParsedSkill[] = files.map(parseSkillFile).sort((a, b) => a.id.localeCompare(b.id));
  return graphFromParsed(parsed, roots);
}

export function graphFromParsed(parsed: ParsedSkill[], roots: string[]): Graph {
  const modes = new Map<string, Mode>();
  const nodes: SkillNode[] = parsed.map((s) => {
    const claude = claudeMode(s.frontmatter);
    const codex = s.codex.allowImplicitInvocation ? "auto" : "manual";
    const mode = unionMode(claude, codex);
    modes.set(s.id, mode);
    const node: SkillNode = {
      id: s.id,
      name: s.name,
      description: s.description,
      mode,
      invocation: { claude, codex },
      entry: false,
      subSkill: false,
      dir: s.dir,
      file: s.file,
      bodyLines: s.body.length,
      scripts: s.scripts,
      references: s.references,
      frontmatter: s.frontmatter,
    };
    if (typeof s.frontmatter["argument-hint"] === "string") node.argumentHint = s.frontmatter["argument-hint"] as string;
    const tools = asStringArray(s.frontmatter["allowed-tools"]);
    if (tools) node.allowedTools = tools;
    if (typeof s.frontmatter.context === "string") node.context = s.frontmatter.context;
    if (typeof s.frontmatter.model === "string") node.model = s.frontmatter.model;
    return node;
  });

  const { edges, flows, unresolved } = detect(parsed, modes);

  const incomingCalls = new Map<string, number>();
  const incomingAny = new Map<string, number>();
  for (const e of edges) {
    // any single mention that calls or suggests a skill means someone else starts it for you
    if (e.evidence.some((v) => v.type === "calls" || v.type === "suggests")) incomingAny.set(e.target, (incomingAny.get(e.target) ?? 0) + 1);
    if (e.type === "calls" || e.type === "prerequisite") incomingCalls.set(e.target, (incomingCalls.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) {
    n.entry = n.mode === "manual" && (incomingAny.get(n.id) ?? 0) === 0;
    n.subSkill = n.mode !== "manual" && (incomingCalls.get(n.id) ?? 0) > 0;
  }

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      roots: roots.map((r) => path.resolve(r)),
      skillCount: nodes.length,
      edgeCount: edges.length,
      flowCount: flows.length,
      version: VERSION,
    },
    nodes,
    edges,
    flows,
    unresolved,
  };
}
