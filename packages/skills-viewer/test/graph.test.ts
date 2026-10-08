import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { classify } from "../src/edges.js";
import { buildGraph } from "../src/graph.js";
import { toMermaid } from "../src/mermaid.js";
import { claudeMode, unionMode } from "../src/parse.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "..", "fixtures", "mattpocock-skills");
const graph = buildGraph([FIXTURE]);
const edge = (s: string, t: string) => graph.edges.find((e) => e.source === s && e.target === t);
const node = (id: string) => graph.nodes.find((n) => n.id === id)!;

test("finds every skill in the fixture", () => {
  assert.equal(graph.nodes.length, 38);
  assert.equal(graph.meta.skillCount, 38);
});

test("invocation mode comes from frontmatter", () => {
  assert.equal(claudeMode({ "disable-model-invocation": true }), "manual");
  assert.equal(claudeMode({ "user-invocable": false }), "background");
  assert.equal(claudeMode({}), "auto");
  assert.equal(unionMode("auto", "manual"), "manual");
  assert.equal(node("wayfinder").mode, "manual");
  assert.equal(node("grilling").mode, "auto");
  assert.equal(graph.nodes.filter((n) => n.mode === "manual").length, 22);
});

test("Skill tool phrasing produces call edges", () => {
  for (const t of ["grilling", "domain-modeling", "research", "prototype"]) {
    const e = edge("wayfinder", t);
    assert.ok(e, `wayfinder -> ${t}`);
    assert.equal(e.type, "calls");
  }
  assert.equal(edge("grill-with-docs", "grilling")?.type, "calls");
  assert.equal(edge("grill-with-docs", "domain-modeling")?.type, "calls");
  assert.equal(edge("grill-me", "grilling")?.type, "calls");
  assert.equal(edge("tdd", "codebase-design")?.type, "calls");
});

test("slash mentions produce edges with the right flavour", () => {
  assert.equal(edge("implement", "tdd")?.type, "calls");
  assert.equal(edge("to-spec", "setup-matt-pocock-skills")?.type, "prerequisite");
  assert.equal(edge("ask-matt", "wayfinder")?.type, "suggests");
  assert.ok(graph.edges.filter((e) => e.source === "ask-matt").length >= 20, "ask-matt routes to most skills");
});

test("no self edges, no path-like false positives, no unknown targets", () => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    assert.notEqual(e.source, e.target);
    assert.ok(ids.has(e.target), e.target);
    assert.ok(e.evidence.length > 0);
    for (const v of e.evidence) assert.ok(v.line > 0 && v.snippet.length > 0);
  }
  assert.ok(
    graph.unresolved.some((u) => u.name === "what-to-do"),
    "unknown /what-to-do is reported, not dropped",
  );
  assert.ok(!graph.unresolved.some((u) => u.name === "the"));
});

test("entry points are manual-only skills nothing calls or suggests", () => {
  const entries = graph.nodes.filter((n) => n.entry).map((n) => n.id);
  assert.ok(entries.includes("ask-matt"));
  assert.ok(entries.includes("setup-matt-pocock-skills"));
  assert.ok(!entries.includes("wayfinder"), "ask-matt suggests wayfinder, so it is not an entry");
  assert.ok(!entries.includes("grilling"), "auto skills are never entries");
  assert.ok(node("grilling").subSkill);
});

test("flows: sequential, parallel and loop are detected with evidence", () => {
  const seq = graph.flows.find((f) => f.kind === "sequential" && f.owner === "wayfinder");
  assert.ok(seq);
  assert.deepEqual(seq.steps.slice(0, 2), ["grilling", "domain-modeling"]);
  const par = graph.flows.find((f) => f.kind === "parallel" && f.owner === "wayfinder");
  assert.ok(par && par.steps.includes("research"));
  const loop = graph.flows.find((f) => f.kind === "loop" && f.steps.includes("wayfinder"));
  assert.ok(loop && loop.until && /fog/.test(loop.until));
  for (const f of graph.flows) assert.ok(f.evidence.length > 0);
});

test("classify reads the words around a mention", () => {
  assert.equal(classify("If not, tell the user to run /setup first.", 25, 31, "slash"), "prerequisite");
  assert.equal(classify('Call the Skill tool with "grilling".', 25, 33, "skill-tool"), "calls");
  assert.equal(classify("- **Something's broken** → /diagnosing-bugs.", 27, 43, "slash"), "suggests");
  assert.equal(classify("Use /tdd where possible.", 4, 8, "slash"), "calls");
  assert.equal(classify("See the notes on `triage` for details.", 17, 25, "backtick"), "reference");
});

test("mermaid output is a flowchart with classes, subgraphs and every skill", () => {
  const mmd = toMermaid(graph, { html: false });
  assert.ok(mmd.startsWith("flowchart LR"));
  assert.ok(mmd.includes("classDef manual"));
  assert.ok(mmd.includes("subgraph entry"));
  for (const n of graph.nodes) assert.ok(mmd.includes(`n_${n.id.replace(/-/g, "_")}[`), n.id);
  assert.ok(!mmd.includes("click "), "plain export has no click handlers");
  const html = toMermaid(graph, { html: true, focus: "wayfinder" });
  assert.ok(html.includes("click n_wayfinder call skillClick()"));
  assert.ok(!html.includes("n_migrate_to_shoehorn["), "focus view leaves unrelated skills out");
});
