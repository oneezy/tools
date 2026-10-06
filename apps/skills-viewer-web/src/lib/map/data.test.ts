import { describe, expect, it } from "vite-plus/test";
import type { Graph, PartNode, SkillNode } from "skills-viewer";
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
  meta: {
    generatedAt: "",
    roots: [],
    skillCount: nodes.length,
    edgeCount: edges.length,
    flowCount: 0,
    partCount: 0,
    pluginCount: 0,
    version: "0.2.0",
    source: { kind: "local", roots: [] },
    warnings: [],
  },
  nodes,
  edges,
  plugins: [],
  marketplaces: [],
  parts: [],
  links: [],
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
  it("groups by plugin, counts merged copies and drops edges to nothing", () => {
    const m = toMapData(
      graph(
        [
          node("tdd", "skills/tdd", { copies: ["plugins/p/skills/tdd/SKILL.md"] }),
          node("ship", "plugins/p/skills/ship", { plugin: "plugin:p" }),
        ],
        [
          { source: "ship", target: "tdd", type: "calls", evidence: [] },
          { source: "ship", target: "tdd", type: "calls", evidence: [] },
          { source: "ship", target: "ghost", type: "calls", evidence: [] },
        ],
      ),
      "repo",
    );
    expect(m.nodes.map((n) => [n.id, n.group])).toEqual([
      ["tdd", "repo"],
      ["ship", "p"],
    ]);
    expect(m.duplicates).toBe(1);
    expect(m.edges).toHaveLength(1);
    expect(m.nodes.find((n) => n.id === "tdd")).toMatchObject({ in: 1, out: 0, short: "tdd does things." });
  });

  it("hangs a skill's files on the skill and counts plugin parts on the group", () => {
    const g = graph([node("ship", "plugins/p/skills/ship", { plugin: "plugin:p" })]);
    const part = (id: string, kind: PartNode["kind"], extra: Partial<PartNode>): PartNode => ({
      id,
      kind,
      name: id,
      description: "",
      file: id,
      details: {},
      ...extra,
    });
    g.parts = [
      part("check.sh", "script", { skill: "ship", plugin: "plugin:p" }),
      part("ship-cmd", "command", { plugin: "plugin:p" }),
      part("pre", "hook", { plugin: "plugin:p" }),
      part("post", "hook", { plugin: "plugin:p" }),
    ];
    const m = toMapData(g, "repo");
    expect(m.nodes[0].parts).toEqual([{ kind: "script", name: "check.sh", file: "check.sh" }]);
    expect(m.groups[0].parts).toEqual({ command: 1, hook: 2 });
  });

  it("boxes a prefix family only when it is part of a bigger group", () => {
    const ws = ["a", "b", "c", "d"].map((x) => node(`writing-${x}`, `skills/w/writing-${x}`));
    expect(toMapData(graph(ws), "r").families).toEqual({});
    expect(toMapData(graph([...ws, node("tdd", "skills/w/tdd")]), "r").families).toEqual({
      "w:writing": { group: "w", prefix: "writing" },
    });
  });
});
