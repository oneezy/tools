import { expect, test } from "vite-plus/test";
import { analyze, memoryFileSet } from "skills-viewer";
import { buildWorkflow } from "./workflow.ts";

const fixture = () =>
  analyze(
    memoryFileSet({
      "skills/oneezy/start/SKILL.md": "---\nname: start\n---\n1. Run /research\n2. Run /research",
      "skills/matt-pocock/research/SKILL.md": "---\nname: research\n---\nRun /start",
    }),
  );

test("cross-library occurrences stay separate and recursion terminates", () => {
  const view = buildWorkflow(fixture(), "start", new Set(["start", "research"]));
  expect(view.nodes.filter((n) => n.data.label === "research")).toHaveLength(2);
  expect(view.nodes.filter((n) => n.data.label === "research").every((n) => n.data.library === "matt-pocock")).toBe(
    true,
  );
  expect(view.edges.filter((e) => e.label === "recursive reference")).toHaveLength(2);
  expect(view.truncated).toBe(false);
});

test("collapsing removes downstream calls and enforces a graph size limit without dangling edges", () => {
  const collapsed = buildWorkflow(fixture(), "start", new Set());
  expect(collapsed.nodes).toHaveLength(1);
  expect(collapsed.edges).toHaveLength(0);
  const limited = buildWorkflow(fixture(), "start", new Set(["start", "research"]), true, 3);
  expect(limited.nodes).toHaveLength(3);
  expect(limited.truncated).toBe(true);
  const ids = new Set(limited.nodes.map((n) => n.id));
  expect(limited.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
});

test("only explicitly joined parallel branches connect to a completion node", () => {
  for (const join of [false, true]) {
    const graph = analyze(
      memoryFileSet({
        "start/SKILL.md": `1. Launch work in parallel:\n   - Research A\n   - Research B\n${join ? "   Wait for all.\n" : ""}2. Save results`,
      }),
    );
    const view = buildWorkflow(graph, "start", new Set(["start"]));
    expect(view.nodes.filter((n) => n.data.kind === "join")).toHaveLength(join ? 1 : 0);
    expect(view.edges.filter((e) => e.label === "complete")).toHaveLength(join ? 2 : 0);
  }
});
