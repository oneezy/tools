import type { MapData } from "./data.ts";

export interface Visibility {
  hidden: string[];
  crossLibrary: boolean;
}

export function parseVisibility(raw: string | null): Visibility {
  try {
    const value = JSON.parse(raw ?? "null");
    if (value && Array.isArray(value.hidden))
      return {
        hidden: value.hidden.filter((key: unknown): key is string => typeof key === "string"),
        crossLibrary: value.crossLibrary === true,
      };
  } catch {
    /* a damaged preference must not prevent loading the map */
  }
  return { hidden: [], crossLibrary: false };
}

export function filterMap(data: MapData, visibility: Visibility): MapData {
  const hidden = new Set(visibility.hidden);
  const nodes = data.nodes.filter((n) => !hidden.has(n.group));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = data.edges.filter(
    (e) =>
      byId.has(e.source) &&
      byId.has(e.target) &&
      (visibility.crossLibrary || byId.get(e.source)!.group === byId.get(e.target)!.group),
  );
  const flows = data.flows.filter(
    (f) =>
      byId.has(f.owner) &&
      f.steps.every((id) => byId.has(id)) &&
      (visibility.crossLibrary || f.steps.every((id) => byId.get(id)!.group === byId.get(f.owner)!.group)),
  );
  const loops = new Set(flows.filter((f) => f.kind === "loop").flatMap((f) => f.steps));
  return {
    ...data,
    nodes: nodes.map((n) => ({
      ...n,
      in: edges.filter((e) => e.target === n.id).length,
      out: edges.filter((e) => e.source === n.id).length,
      loop: loops.has(n.id),
    })),
    edges,
    flows,
    groups: data.groups.filter((g) => !hidden.has(g.key)),
    families: Object.fromEntries(Object.entries(data.families).filter(([, f]) => !hidden.has(f.group))),
  };
}
