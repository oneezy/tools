import type { ELK, ElkNode } from "elkjs/lib/elk-api.js";
import type { Node } from "@xyflow/svelte";
import { familyOf, type MapData, type MapNode } from "./data.ts";

export const CARD_W = 232;
export const CARD_H = 92;

export type LayoutKey = "libraries" | "flow" | "force";

export const LAYOUTS: { key: LayoutKey; name: string; sub: string }[] = [
  { key: "libraries", name: "Libraries", sub: "grouped by library, families boxed" },
  { key: "flow", name: "Flow", sub: "one layered graph, entry points first" },
  { key: "force", name: "Force", sub: "hubs pull their neighbours in" },
];

export interface SkillNodeData extends Record<string, unknown> {
  skill: MapNode;
  color: number;
}

export interface GroupNodeData extends Record<string, unknown> {
  label: string;
  count: number;
  /** plugin parts by kind, shown after the skill count */
  parts: Record<string, number>;
  color: number;
  family: boolean;
}

export type MapFlowNode = Node<SkillNodeData, "skill"> | Node<GroupNodeData, "group">;

/** Lay the map out; `aspect` is the viewport's width / height so phones get a tall map. */
export async function layout(
  key: LayoutKey,
  data: MapData,
  aspect: number,
  draggable: boolean,
): Promise<MapFlowNode[]> {
  const a = Math.max(0.55, Math.min(2, aspect));
  const colors = new Map(data.groups.map((g) => [g.key, g.color]));
  const skill = (n: MapNode, x: number, y: number, parentId?: string): MapFlowNode => ({
    id: n.id,
    type: "skill",
    position: { x, y },
    parentId,
    draggable,
    width: CARD_W,
    height: CARD_H,
    data: { skill: n, color: colors.get(n.group) ?? 0 },
  });
  if (key === "force") return layoutForce(data, a, skill);
  const elk = await getElk();
  return key === "flow" ? layoutFlow(elk, data, a, skill) : layoutLibraries(elk, data, a, skill, colors);
}

type Elk = ELK;
type MakeSkill = (n: MapNode, x: number, y: number, parentId?: string) => MapFlowNode;

let elkPromise: Promise<Elk> | undefined;

/** elkjs is 1.6 MB: load it on first use and run it in a worker so layout never blocks the page. */
function getElk(): Promise<Elk> {
  elkPromise ??= Promise.all([import("elkjs/lib/elk-api.js"), import("elkjs/lib/elk-worker.min.js?worker")]).then(
    ([api, worker]) => new api.default({ workerFactory: () => new worker.default() }),
  );
  return elkPromise;
}

const pad = (t: number, s: number) => `[top=${t},left=${s},bottom=${s},right=${s}]`;

async function layoutLibraries(
  elk: Elk,
  data: MapData,
  a: number,
  skill: MakeSkill,
  colors: Map<string, number>,
): Promise<MapFlowNode[]> {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const groups: ElkNode[] = data.groups.map((g) => {
    const members = data.nodes.filter((n) => n.group === g.key);
    const children: ElkNode[] = members
      .filter((n) => !familyOf(n, data.families))
      .map((n) => ({ id: n.id, width: CARD_W, height: CARD_H }));
    for (const fk of Object.keys(data.families).filter((k) => data.families[k].group === g.key)) {
      children.push({
        id: `f:${fk}`,
        layoutOptions: {
          "elk.algorithm": "rectpacking",
          "elk.aspectRatio": String(Math.max(0.8, a)),
          "elk.padding": pad(56, 20),
          "elk.spacing.nodeNode": "14",
        },
        children: members
          .filter((n) => familyOf(n, data.families) === fk)
          .map((n) => ({ id: n.id, width: CARD_W, height: CARD_H })),
      });
    }
    // edges inside this group, with family members standing in as their family box
    const local = (id: string) => {
      const n = byId.get(id);
      if (!n || n.group !== g.key) return null;
      const f = familyOf(n, data.families);
      return f ? `f:${f}` : id;
    };
    const seen = new Set<string>();
    const edges = data.edges.flatMap((e) => {
      const s = local(e.source);
      const t = local(e.target);
      if (!s || !t || s === t || seen.has(`${s}>${t}`)) return [];
      seen.add(`${s}>${t}`);
      return [{ id: `l${e.id}`, sources: [s], targets: [t] }];
    });
    return {
      id: `g:${g.key}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.padding": pad(28, 28),
        "elk.spacing.nodeNode": "22",
        "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        "elk.spacing.componentComponent": "36",
        "elk.separateConnectedComponents": "true",
        "elk.aspectRatio": String(a),
      },
      children,
      edges,
    };
  });

  const root = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "rectpacking",
      "elk.aspectRatio": String(a),
      "elk.spacing.nodeNode": "150",
      "elk.padding": pad(150, 40),
    },
    children: groups,
  });

  const out: MapFlowNode[] = [];
  const walk = (node: ElkNode, parentId?: string) => {
    for (const c of node.children ?? []) {
      const x = c.x ?? 0;
      const y = c.y ?? 0;
      if (c.id.startsWith("g:") || c.id.startsWith("f:")) {
        const family = c.id.startsWith("f:");
        const fam = family ? data.families[c.id.slice(2)] : undefined;
        const groupKey = fam ? fam.group : c.id.slice(2);
        out.push({
          id: c.id,
          type: "group",
          position: { x, y },
          parentId,
          draggable: false,
          selectable: false,
          focusable: false,
          width: c.width,
          height: c.height,
          data: {
            label: fam ? `${fam.prefix}-*` : groupKey,
            count: family ? (c.children?.length ?? 0) : data.nodes.filter((n) => n.group === groupKey).length,
            color: colors.get(groupKey) ?? 0,
            parts: family ? {} : (data.groups.find((g) => g.key === groupKey)?.parts ?? {}),
            family,
          },
        });
        walk(c, c.id);
      } else {
        const n = byId.get(c.id);
        if (n) out.push(skill(n, x, y, parentId));
      }
    }
  };
  walk(root);
  return out;
}

async function layoutFlow(elk: Elk, data: MapData, a: number, skill: MakeSkill): Promise<MapFlowNode[]> {
  const res = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": a < 1 ? "DOWN" : "RIGHT",
      "elk.padding": pad(40, 40),
      "elk.spacing.nodeNode": "22",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      "elk.spacing.componentComponent": "60",
      "elk.separateConnectedComponents": "true",
      "elk.aspectRatio": String(a),
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.edgeRouting": "POLYLINE",
    },
    children: data.nodes.map((n) => ({ id: n.id, width: CARD_W, height: CARD_H })),
    edges: data.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  return (res.children ?? []).flatMap((c) => {
    const n = byId.get(c.id);
    return n ? [skill(n, c.x ?? 0, c.y ?? 0)] : [];
  });
}

async function layoutForce(data: MapData, a: number, skill: MakeSkill): Promise<MapFlowNode[]> {
  const d3 = await import("d3-force");
  // one anchor per group, spread on an ellipse shaped like the viewport
  const R = 700;
  const anchors = new Map(
    data.groups.map((g, i) => {
      if (data.groups.length === 1) return [g.key, [0, 0]] as const;
      const t = (i / data.groups.length) * Math.PI * 2;
      return [g.key, [Math.cos(t) * R * a, Math.sin(t) * (R / a)]] as const;
    }),
  );
  type SimNode = { id: string; group: string; x: number; y: number };
  const nodes: SimNode[] = data.nodes.map((n, i) => {
    const [ax, ay] = anchors.get(n.group)!;
    return { id: n.id, group: n.group, x: ax + Math.cos(i) * 200, y: ay + Math.sin(i) * 200 };
  });
  const groupOf = new Map(data.nodes.map((n) => [n.id, n.group]));
  const links = data.edges.map((e) => ({ source: e.source, target: e.target, type: e.type }));
  const id = (v: string | SimNode) => (typeof v === "string" ? v : v.id);
  d3.forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.id)
        .distance((l) => (l.type === "reference" ? 320 : 260))
        .strength((l) => (groupOf.get(id(l.source)) === groupOf.get(id(l.target)) ? 0.5 : 0.08)),
    )
    .force("charge", d3.forceManyBody().strength(-900).distanceMax(900))
    .force("collide", d3.forceCollide(140).strength(1))
    .force("x", d3.forceX<SimNode>((d) => anchors.get(d.group)![0]).strength(0.12))
    .force("y", d3.forceY<SimNode>((d) => anchors.get(d.group)![1]).strength(0.12))
    .stop()
    .tick(420);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  return nodes.map((s) => skill(byId.get(s.id)!, s.x - CARD_W / 2, s.y - CARD_H / 2));
}
