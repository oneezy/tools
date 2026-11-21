import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { BuildInputs, watchDevelopment } from "../src/develop-watch.js";
import { develop } from "../src/develop.js";
import { Library } from "../src/library.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await wait(50);
  }
  throw new Error("Watcher did not observe the expected change");
}

test("watcher skips no-op saves and generated files, reconciles additions/renames/deletions, and restores only config changes", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "skills-watch-"));
  cleanup.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, "packages", "skills");
  const dir = path.join(root, "skills", "play", "hi");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  const text = "---\nname: hi\ndescription: greeting\n---\nHi\n";
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(root, "skills-sync.json"), JSON.stringify({ version: 1, sources: {}, plugins: {} }));
  fs.writeFileSync(path.join(root, "skills-sync.lock.json"), JSON.stringify({ version: 2, sources: {} }));
  const options = {
    plan: false,
    home: path.join(workspace, "home"),
    codexHome: path.join(workspace, "home", ".codex"),
  };
  const lib = new Library(root);
  const reconcile = () => {
    expect(develop(lib, workspace, options).conflicts()).toEqual([]);
  };
  reconcile();
  let reconciles = 0;
  let restores = 0;
  const logs: string[] = [];
  const errors: unknown[] = [];
  cleanup.push(
    watchDevelopment(
      root,
      {
        reconcile: () => {
          reconcile();
          reconciles++;
        },
        restore: () => {
          restores++;
        },
        log: (message) => logs.push(message),
        error: (error) => errors.push(error),
      },
      50,
    ),
  );
  fs.writeFileSync(file, text);
  await wait(200);
  expect(logs).toEqual([]);
  fs.writeFileSync(file, text + "Edited\n");
  await until(() => logs.length === 1);
  expect(reconciles).toBe(0);
  expect(fs.readFileSync(path.join(workspace, ".agents/skills/hi/SKILL.md"), "utf8")).toContain("Edited");
  const added = path.join(root, "skills", "play", "new");
  fs.mkdirSync(added);
  fs.writeFileSync(path.join(added, "SKILL.md"), text.replace("name: hi", "name: new"));
  await until(() => reconciles === 1);
  expect(fs.existsSync(path.join(workspace, ".agents/skills/new/SKILL.md"))).toBe(true);
  const renamed = path.join(root, "skills", "play", "renamed");
  fs.renameSync(added, renamed);
  await until(() => reconciles === 2);
  expect(fs.existsSync(path.join(workspace, ".agents/skills/new"))).toBe(false);
  expect(fs.existsSync(path.join(workspace, ".agents/skills/renamed/SKILL.md"))).toBe(true);
  fs.rmSync(renamed, { recursive: true });
  await until(() => reconciles === 3);
  fs.mkdirSync(path.join(root, "plugins"));
  fs.writeFileSync(path.join(root, "plugins", "generated.txt"), "output");
  await wait(200);
  expect(reconciles).toBe(3);
  fs.appendFileSync(path.join(root, "skills-sync.json"), "\n");
  await until(() => restores === 1);
  expect(reconciles).toBe(4);
  expect(errors).toEqual([]);
});

test("an edit inside a skill's own dist, node_modules or __pycache__ is a build input: packaging copies those folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-inputs-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, "skills", "play", "hi");
  for (const dir of ["dist", "node_modules", "__pycache__"]) {
    fs.mkdirSync(path.join(skill, dir), { recursive: true });
    fs.writeFileSync(path.join(skill, dir, "data.txt"), "one");
  }
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: hi\ndescription: greeting\n---\nHi\n");
  // the Library's own dist (the Development builds) stays out
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const inputs = new BuildInputs(root);
  let last = inputs.digest();

  fs.writeFileSync(path.join(root, "dist", "status.json"), "{}");
  expect(inputs.digest()).toBe(last);
  for (const dir of ["dist", "node_modules", "__pycache__"]) {
    fs.writeFileSync(path.join(skill, dir, "data.txt"), "two, longer");
    const next = inputs.digest();
    expect(next, dir).not.toBe(last);
    last = next;
  }
});
