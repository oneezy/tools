import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { createLocalReader } from "./local-reader.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("local libraries use configured ownership, including renamed dependencies and new authored groups", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-skills-groups-"));
  roots.push(root);
  write(
    root,
    "skills-sync.json",
    JSON.stringify({
      sources: { pstack: { rename: { tdd: "pstack-tdd" } } },
      plugins: { pstack: { source: "pstack" }, "matt-pocock": { source: "matt" }, play: { group: "play" } },
    }),
  );
  write(
    root,
    "skills-sync.lock.json",
    JSON.stringify({
      sources: {
        pstack: { skills: { tdd: {} } },
        matt: { skills: { tdd: {} } },
      },
    }),
  );
  write(root, ".agents/skills/pstack-tdd/SKILL.md", skill("pstack-tdd", "Pstack"));
  write(root, ".agents/skills/tdd/SKILL.md", skill("tdd", "Matt"));
  write(root, "skills/play/hi/SKILL.md", skill("hi", "Hi"));
  write(root, "skills/dev/experiment/SKILL.md", skill("experiment", "New group"));
  const read = createLocalReader(root);
  expect(Object.fromEntries(read().graph.nodes.map((n) => [n.name, n.library]))).toEqual({
    "pstack-tdd": "pstack",
    tdd: "matt-pocock",
    hi: "play",
    experiment: "dev",
  });
  const first = read();
  write(root, "skills-sync.json", JSON.stringify({ plugins: { playground: { group: "play" } } }));
  expect(read().revision).not.toBe(first.revision);
  expect(read().graph.nodes.find((n) => n.name === "hi")?.library).toBe("playground");
});
function write(root: string, name: string, text: string) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nHello\n`;

test("local graph follows edits, new skills and deletion without including built plugin copies", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-skills-map-"));
  roots.push(root);
  write(root, "skills/play/hi/SKILL.md", skill("hi", "Original"));
  write(root, ".agents/skills/external/SKILL.md", skill("external", "Dependency"));
  write(root, "plugins/play/skills/hi/SKILL.md", skill("hi", "Stale generated copy"));
  const read = createLocalReader(root);
  const first = read();
  expect(first.graph.nodes.map((n) => n.name).sort()).toEqual(["external", "hi"]);
  expect(first.graph.nodes.find((n) => n.name === "hi")?.file).toBe("skills/play/hi/SKILL.md");
  expect(read().graph).toBe(first.graph);
  write(root, "skills/play/hi/SKILL.md", skill("hi", "Original"));
  expect(read().graph).toBe(first.graph);
  write(root, "skills/play/hi/SKILL.md", skill("hi", "Edited"));
  expect(read().graph.nodes.find((n) => n.name === "hi")?.description).toBe("Edited");
  write(root, "skills/play/new/SKILL.md", skill("new", "New"));
  expect(read().graph.nodes).toHaveLength(3);
  fs.unlinkSync(path.join(root, "skills/play/new/SKILL.md"));
  expect(read().graph.nodes).toHaveLength(2);
});

test("supporting document edits update workflow data and identical saves reuse the graph", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-workflow-files-"));
  roots.push(root);
  write(root, "skills/play/start/SKILL.md", "Read [notes](arbitrary/notes.md)");
  write(root, "skills/play/start/arbitrary/notes.md", "1. Read the input\n2. Write the output");
  const read = createLocalReader(root);
  const first = read();
  const file = () => read().graph.workflows!.find((d) => d.file.endsWith("notes.md"))!;
  expect(file().sequences[0]).toHaveLength(2);
  write(root, "skills/play/start/arbitrary/notes.md", "1. Read the input\n2. Write the output");
  expect(read().graph).toBe(first.graph);
  write(root, "skills/play/start/arbitrary/notes.md", "1. Read the input\n2. Repeat the check until it passes");
  expect(read().revision).not.toBe(first.revision);
  expect(file().sequences[0][1].repeat).toBe("Repeat the check until it passes");
  fs.unlinkSync(path.join(root, "skills/play/start/arbitrary/notes.md"));
  expect(read().graph.workflows!.find((d) => d.id === "start")!.references).toEqual([]);
});
