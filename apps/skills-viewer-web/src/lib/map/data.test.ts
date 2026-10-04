import { describe, expect, it } from "vite-plus/test";
import type { Graph, SkillNode } from "skills-viewer/src/types.ts";
import { groupOf, toMapData } from "./data.ts";

const node = (id: string, dir: string, extra: Partial<SkillNode> = {}): SkillNode => ({
  id,
  name: id,
  description: `${id} does things. Use when needed.`,
  mode: "auto",
  invocation: { claude: "auto", codex: "auto" },
  entry: false,
  subSkill: false,
  dir,
  file: `${dir}/SKILL.md`,
  bodyLines: 10,
  scripts: [],
  references: [],
  frontmatter: {},
  ...extra,
});

const graph = (nodes: SkillNode[], edges: Graph["edges"] = []): Graph => ({
  meta: { generatedAt: "", roots: [], skillCount: nodes.length, edgeCount: edges.length, flowCount: 0, version: "0.1.0" },
  nodes,
  edges,
  flows: [],
  unresolved: [],
});

describe("groupOf", () => {
  it.each([
    ["plugins/pstack/skills/architect", "pstack"],
    ["skills/engineering/tdd", "engineering"],
    ["skills/tdd", "repo"],
    ["tdd", "repo"],
    [".claude/skills/tdd", "repo"],
    ["packages/x/fixtures/mattpocock-skills/tdd", "mattpocock-skills"],
  ])("%s → %s", (dir, want) => expect(groupOf(dir, "repo")).toBe(want));
});

describe("toMapData", () => {
  it("keeps the authored copy of a duplicated skill and drops edges to nothing", () => {
    const m = toMapData(
      graph(
        [node("tdd", "plugins/p/skills/tdd"), node("tdd", "skills/tdd"), node("grill", "skills/grill")],
        [
          { source: "grill", target: "tdd", type: "calls", evidence: [] },
          { source: "grill", target: "tdd", type: "calls", evidence: [] },
          { source: "grill", target: "ghost", type: "calls", evidence: [] },
        ],
      ),
      "repo",
    );
    expect(m.nodes.map((n) => [n.id, n.file])).toEqual([
      ["tdd", "skills/tdd/SKILL.md"],
      ["grill", "skills/grill/SKILL.md"],
    ]);
    expect(m.duplicates).toBe(1);
    expect(m.edges).toHaveLength(1);
    expect(m.nodes.find((n) => n.id === "tdd")).toMatchObject({ in: 1, out: 0, short: "tdd does things." });
  });

  it("boxes a prefix family only when it is part of a bigger group", () => {
    const ws = ["a", "b", "c", "d"].map((x) => node(`writing-${x}`, `skills/w/writing-${x}`));
    expect(toMapData(graph(ws), "r").families).toEqual({});
    expect(toMapData(graph([...ws, node("tdd", "skills/w/tdd")]), "r").families).toEqual({ "w:writing": { group: "w", prefix: "writing" } });
  });
});
