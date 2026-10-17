import { expect, test } from "vite-plus/test";
import type { MapData, MapNode } from "./data.ts";
import { filterMap, parseVisibility } from "./visibility.ts";

const nodes = [
  { id: "a", group: "oneezy" },
  { id: "b", group: "oneezy" },
  { id: "c", group: "matt-pocock" },
] as MapNode[];
const data: MapData = {
  nodes,
  edges: [
    { id: "ab", source: "a", target: "b", type: "calls", evidence: [] },
    { id: "ac", source: "a", target: "c", type: "calls", evidence: [] },
  ],
  flows: [{ kind: "sequential", owner: "a", steps: ["b", "c"] }],
  groups: [
    { key: "oneezy", label: "oneezy", color: 2, count: 2, parts: {} },
    { key: "matt-pocock", label: "matt-pocock", color: 1, count: 1, parts: {} },
  ],
  families: { "matt-pocock:test": { group: "matt-pocock", prefix: "test" } },
  duplicates: 0,
};

test("hidden libraries leave no dangling edges, shortened flows or family boxes", () => {
  const result = filterMap(data, { hidden: ["matt-pocock"], crossLibrary: true });
  expect(result.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  expect(result.edges.map((e) => e.id)).toEqual(["ab"]);
  expect(result.flows).toEqual([]);
  expect(result.families).toEqual({});
  expect(result.groups[0].color).toBe(2);
  expect(result.nodes[0].out).toBe(1);
});

test("cross-library toggle keeps all nodes and can restore all relations", () => {
  expect(filterMap(data, { hidden: [], crossLibrary: false }).edges.map((e) => e.id)).toEqual(["ab"]);
  expect(filterMap(data, { hidden: [], crossLibrary: false }).nodes).toHaveLength(3);
  expect(filterMap(data, { hidden: [], crossLibrary: true }).edges).toHaveLength(2);
  expect(filterMap(data, { hidden: data.groups.map((g) => g.key), crossLibrary: false }).nodes).toEqual([]);
});

test("preferences handle corrupt storage and preserve temporarily absent hidden libraries", () => {
  expect(parseVisibility("broken")).toEqual({ hidden: [], crossLibrary: false });
  expect(parseVisibility('{"hidden":["future",3],"crossLibrary":true}')).toEqual({
    hidden: ["future"],
    crossLibrary: true,
  });
});
