import type { EdgeType, Evidence, Graph, SkillNode } from "skills-viewer/src/types.ts";

/** One skill as the canvas draws it. */
export interface MapNode {
  id: string;
  /** library or plugin the skill belongs to; colours the card and boxes it in the Libraries layout */
  group: string;
  description: string;
  /** first sentence, capped, for the card */
  short: string;
  manual: boolean;
  entry: boolean;
  loop: boolean;
  out: number;
  in: number;
  lines: number;
  scripts: number;
  references: number;
  /** repo-relative path of SKILL.md */
  file: string;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  evidence: Evidence[];
}

export interface MapFlow {
  kind: "sequential" | "parallel" | "loop";
  owner: string;
  steps: string[];
  until?: string;
}

export interface MapGroup {
  key: string;
  label: string;
  /** index into the --g0..--g7 palette */
  color: number;
  count: number;
}

export interface MapData {
  nodes: MapNode[];
  edges: MapEdge[];
  flows: MapFlow[];
  groups: MapGroup[];
  /** "group:prefix" → family of 4+ skills sharing a name prefix inside one group */
  families: Record<string, { group: string; prefix: string }>;
  /** skills dropped because another copy of the same id was kept (skills/ + plugins/ builds) */
  duplicates: number;
}

export const PALETTE_SIZE = 8;

/** Turn the engine's graph into what the canvas needs: unique ids, groups, families, degrees. */
export function toMapData(graph: Graph, repoName: string): MapData {
  const kept = new Map<string, SkillNode>();
  for (const n of graph.nodes) {
    const prev = kept.get(n.id);
    if (!prev || preferCopy(n, prev)) kept.set(n.id, n);
  }
  const duplicates = graph.nodes.length - kept.size;

  const seen = new Set<string>();
  const edges: MapEdge[] = [];
  for (const e of graph.edges) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key) || !kept.has(e.source) || !kept.has(e.target) || e.source === e.target) continue;
    seen.add(key);
    edges.push({ id: `e${edges.length}`, source: e.source, target: e.target, type: e.type, evidence: e.evidence });
  }

  const flows: MapFlow[] = graph.flows
    .map((f) => ({ kind: f.kind, owner: f.owner, steps: f.steps.filter((s) => kept.has(s)), until: f.until }))
    .filter((f) => kept.has(f.owner) && f.steps.length > 0);
  const loops = new Set(flows.filter((f) => f.kind === "loop").flatMap((f) => f.steps));

  const deg = new Map<string, { in: number; out: number }>();
  const d = (id: string) => deg.get(id) ?? (deg.set(id, { in: 0, out: 0 }), deg.get(id)!);
  for (const e of edges) {
    d(e.source).out++;
    d(e.target).in++;
  }

  const nodes: MapNode[] = [...kept.values()].map((n) => ({
    id: n.id,
    group: groupOf(n.dir, repoName),
    description: n.description,
    short: shortDescription(n.description),
    manual: n.mode === "manual",
    entry: n.entry,
    loop: loops.has(n.id),
    out: d(n.id).out,
    in: d(n.id).in,
    lines: n.bodyLines,
    scripts: n.scripts.length,
    references: n.references.length,
    file: n.file,
  }));

  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
  const groups: MapGroup[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count], i) => ({ key, label: key, color: i % PALETTE_SIZE, count }));

  return { nodes, edges, flows, groups, families: findFamilies(nodes), duplicates };
}

/** The authored copy (outside plugins/) beats a built plugin copy; otherwise the shorter path. */
function preferCopy(a: SkillNode, b: SkillNode): boolean {
  const ap = isPluginPath(a.dir);
  const bp = isPluginPath(b.dir);
  if (ap !== bp) return !ap;
  return a.dir.length < b.dir.length;
}

const isPluginPath = (dir: string) => dir.split("/").includes("plugins");

/**
 * `plugins/<name>/…` → the plugin. Otherwise the folder that holds the skill folders,
 * ignoring a trailing `skills` (so `skills/engineering/tdd` → engineering and
 * `skills/tdd` → the repo).
 */
export function groupOf(dir: string, repoName: string): string {
  const parts = dir.split("/").filter(Boolean);
  const p = parts.lastIndexOf("plugins");
  if (p >= 0 && parts[p + 1]) return parts[p + 1];
  const container = parts.slice(0, -1);
  while (container.length && container[container.length - 1] === "skills") container.pop();
  const last = container[container.length - 1];
  return !last || last.startsWith(".") ? repoName : last;
}

/** Within a group, 4+ skills that share a first-word prefix (principle-*, writing-*) get a box. */
function findFamilies(nodes: MapNode[]): MapData["families"] {
  const byGroup = new Map<string, MapNode[]>();
  for (const n of nodes) byGroup.set(n.group, [...(byGroup.get(n.group) ?? []), n]);
  const out: MapData["families"] = {};
  for (const [group, members] of byGroup) {
    const counts = new Map<string, number>();
    for (const n of members) if (n.id.includes("-")) counts.set(prefixOf(n.id), (counts.get(prefixOf(n.id)) ?? 0) + 1);
    for (const [prefix, c] of counts) {
      // a family that is the whole group adds a box and no information
      if (c >= 4 && c < members.length) out[`${group}:${prefix}`] = { group, prefix };
    }
  }
  return out;
}

const prefixOf = (id: string) => id.split("-")[0];

export function familyOf(n: MapNode, families: MapData["families"]): string | null {
  if (!n.id.includes("-")) return null;
  const key = `${n.group}:${prefixOf(n.id)}`;
  return families[key] ? key : null;
}

export function shortDescription(d: string): string {
  const s = d.split(/(?<=[.!?])\s|\s(?=Use (?:when|for|whenever)\b)/)[0] || d;
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}
