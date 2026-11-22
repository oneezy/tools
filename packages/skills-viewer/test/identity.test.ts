import { expect, test } from "vite-plus/test";
import { analyze, memoryFileSet } from "../src/index.js";

const skill = (name: string, body = "") => `---\nname: ${name}\n---\n${body}`;

test("same-named plugin skills remain distinct and references prefer their own library", () => {
  const graph = analyze(
    memoryFileSet(
      new Map([
        ["plugins/a/.claude-plugin/plugin.json", '{"name":"a"}'],
        ["plugins/b/.claude-plugin/plugin.json", '{"name":"b"}'],
        ["plugins/a/skills/review/SKILL.md", skill("review")],
        ["plugins/b/skills/review/SKILL.md", skill("review")],
        ["plugins/a/skills/start/SKILL.md", skill("start", "Run /review then run /b:review")],
        ["skills/outsider/SKILL.md", skill("outsider", "Run /review")],
      ]),
    ),
  );
  expect(graph.nodes.filter((n) => n.name === "review").map((n) => n.id)).toEqual(["a:review", "b:review"]);
  expect(graph.edges.map((e) => [e.source, e.target])).toEqual([
    ["start", "a:review"],
    ["start", "b:review"],
  ]);
  expect(graph.unresolved).toContainEqual(expect.objectContaining({ name: "review", sources: ["outsider"] }));
});

test("two frontmatter aliases never resolve by file order", () => {
  const graph = analyze(
    memoryFileSet(
      new Map([
        ["skills/play/one/SKILL.md", skill("hi")],
        ["skills/play/two/SKILL.md", skill("hi")],
        ["skills/play/start/SKILL.md", skill("start", "Run /hi")],
      ]),
    ),
  );
  expect(graph.edges).toEqual([]);
  expect(graph.unresolved).toContainEqual(expect.objectContaining({ name: "hi" }));
});

test("live library ownership keeps matching folder names separate and retains file paths", () => {
  const files = new Map([
    ["skills/play/check/SKILL.md", skill("Check")],
    ["skills/dev/check/SKILL.md", skill("check")],
    ["skills/play/start/SKILL.md", skill("start", 'Use Skill tool "check" then "dev:check"')],
  ]);
  const graph = analyze(memoryFileSet(files), {
    skillLibraries: {
      "skills/play/check": "play",
      "skills/dev/check": "dev",
      "skills/play/start": "play",
    },
  });
  expect(graph.nodes).toHaveLength(3);
  expect(graph.nodes.find((n) => n.id === "play:check")?.file).toBe("skills/play/check/SKILL.md");
  expect(graph.edges.map((e) => e.target)).toEqual(["dev:check", "play:check"]);
});
