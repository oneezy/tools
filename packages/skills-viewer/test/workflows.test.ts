import { expect, test } from "vite-plus/test";
import { analyze, memoryFileSet } from "../src/index.js";

const skill = (body: string, name = "start") => `---\nname: ${name}\n---\n${body}`;
const graph = (body: string, extra: Record<string, string> = {}) =>
  analyze(
    memoryFileSet({
      "skills/ours/start/SKILL.md": skill(body),
      "skills/other/research/SKILL.md": skill("", "research"),
      ...extra,
    }),
  );

test("arbitrary directories and filenames use resolved references, not name categories", () => {
  for (const folder of ["templates", "bananas", "材料"]) {
    const g = graph(`Read [the material](<${folder}/odd name.md>) and \`${folder}/\`.`, {
      [`skills/ours/start/${folder}/odd name.md`]: "Read [more](deeper.md)",
      [`skills/ours/start/${folder}/deeper.md`]: "Run /research",
      "skills/ours/start/unused.md": "Run /research",
    });
    const doc = g.workflows!.find((d) => d.id === "start")!;
    expect(doc.references.map((r) => r.kind)).toEqual(["file", "directory"]);
    expect(doc.sequences).toEqual([]);
    const nested = g.workflows!.find((d) => d.file.endsWith("deeper.md"))!;
    expect(nested.references).toContainEqual(expect.objectContaining({ target: "research", kind: "calls" }));
    expect(doc.references.every((r) => !r.target.endsWith("unused.md"))).toBe(true);
    expect(g.workflows!.find((d) => d.file.endsWith("odd name.md"))!.references[0].target).toContain("deeper.md");
  }
});

test("ordered invocations preserve repeated calls and source line evidence", () => {
  const doc = graph("1. Run /research\n2. Run /research").workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences[0].map((s) => s.number)).toEqual(["1", "2"]);
  expect(doc.sequences[0].map((s) => s.references[0].target)).toEqual(["research", "research"]);
  expect(new Set(doc.sequences[0].map((s) => s.id)).size).toBe(2);
  expect(doc.sequences[0][0].evidence).toMatchObject({
    file: "skills/ours/start/SKILL.md",
    line: 4,
    rule: "ordered-action",
  });
});

test("parallel tasks require an explicit cue and joins require explicit waiting", () => {
  const doc = graph(
    "1. Launch agents in parallel:\n   - Research with model A\n   - Research with model B\n   Wait for all to finish.\n2. Combine the findings",
  ).workflows!.find((d) => d.id === "start")!;
  const first = doc.sequences[0][0];
  expect(first.branchKind).toBe("parallel");
  expect(first.branches!.map((b) => b.number)).toEqual(["1.1", "1.2"]);
  expect(first.join).toBe(true);
  const noJoin = graph(
    "1. Launch agents in parallel:\n   - Research A\n   - Research B\n2. Save notes",
  ).workflows!.find((d) => d.id === "start")!;
  expect(noJoin.sequences[0][0].join).toBe(false);
});

test("code, quotations, examples and noun lists do not become execution steps", () => {
  const doc = graph(
    [
      "```md",
      "1. Run /research",
      "```",
      "> 1. Run /research",
      "",
      "1. Tables",
      "2. Lists",
      "",
      "# Example",
      "1. Run /research",
      "# Instructions",
      "1. Read the input",
    ].join("\n"),
  ).workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences).toHaveLength(1);
  expect(doc.sequences[0][0].label).toBe("Read the input");
  expect(doc.references).toEqual([]);
});

test("choice and repeat are source-backed without inferring behavior from folder names", () => {
  const doc = graph(
    "1. Choose one format:\n   - Table\n   - List\n2. Repeat the check until it passes",
  ).workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences[0][0].branchKind).toBe("choice");
  expect(doc.sequences[0][1].repeat).toBe("Repeat the check until it passes");
});

test("ambiguous names stay unresolved and paths never fetch outside the file set", () => {
  const g = graph("Run /check\nRead `missing.md` and [remote](https://example.com/private.md)", {
    "skills/first/check/SKILL.md": skill("", "check"),
    "skills/second/check/SKILL.md": skill("", "check"),
  });
  expect(g.workflows!.find((d) => d.id === "start")!.references).toEqual([]);
});

test("numbered action sections retain their contained references", () => {
  const doc = graph(
    "## 1. Read the brief\nRead `strange/brief.md`\n## 2. Research the options\nRun /research\n## Notes\nRead `./`",
    {
      "skills/ours/start/strange/brief.md": "A brief",
    },
  ).workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences[0].map((s) => s.label)).toEqual(["Read the brief", "Research the options"]);
  expect(doc.sequences[0][0].references[0].target).toContain("strange/brief.md");
  expect(doc.references.some((r) => r.kind === "directory")).toBe(false);
});

test("negative instructions remain references and an explicit path beats ambiguous aliases", () => {
  const g = graph("Never run /research\nRead [the other check](../../second/check/SKILL.md)", {
    "skills/first/check/SKILL.md": skill("", "check"),
    "skills/second/check/SKILL.md": skill("", "check"),
  });
  const refs = g.workflows!.find((d) => d.id === "start")!.references;
  expect(refs.find((r) => r.target === "research")?.kind).toBe("reference");
  expect(refs.filter((r) => r.target.endsWith(":check")).map((r) => r.target)).toEqual(["second:check"]);
});

test("a choice introduction prevents a numbered menu from becoming a sequential workflow", () => {
  const doc = graph("Choose one:\n1. Run /research\n2. Read the brief").workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences[0]).toHaveLength(1);
  expect(doc.sequences[0][0].branchKind).toBe("choice");
  expect(doc.sequences[0][0].branches).toHaveLength(2);
});

test("parallel bullet groups and standalone repeat instructions need no magic folder or schema", () => {
  const doc = graph(
    "Launch work in parallel:\n- Research A\n- Research B\n\nRepeat /research until the checks pass",
  ).workflows!.find((d) => d.id === "start")!;
  expect(doc.sequences[0][0].branchKind).toBe("parallel");
  expect(doc.sequences[0][0].branches).toHaveLength(2);
  expect(doc.sequences[1][0].repeat).toContain("until the checks pass");
});

test("checklists mentioning a choice and negated parallel instructions do not create branches", () => {
  for (const text of [
    "- [ ] Did I choose one format?\n- [ ] Is it readable?\n- [ ] Is it complete?",
    "Do not launch in parallel:\n- Research A\n- Research B",
  ])
    expect(graph(text).workflows!.find((d) => d.id === "start")!.sequences).toEqual([]);
});
