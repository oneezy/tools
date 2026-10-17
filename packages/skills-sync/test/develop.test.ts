import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { develop, developmentConfig, externalSkills } from "../src/develop.js";
import { Library } from "../src/library.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-development-"));
  temps.push(base);
  const workspace = path.join(base, "workspace");
  const root = path.join(workspace, "packages", "skills");
  const home = path.join(base, "home");
  const codexHome = path.join(home, ".codex");
  const file = path.join(root, "skills", "own", "example", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "---\nname: example\ndescription: alpha\n---\nAlpha\n");
  fs.writeFileSync(path.join(root, "skills-sync.json"), JSON.stringify({ version: 1, sources: {}, plugins: {} }));
  fs.writeFileSync(path.join(root, "skills-sync.lock.json"), JSON.stringify({ version: 2, sources: {} }));
  const lib = new Library(root);
  const options = { home, codexHome, plan: false };
  return { base, workspace, root, home, codexHome, file, lib, options };
}

test("a workspace install exposes source edits immediately, preserves global files, and is idempotent", () => {
  const f = fixture();
  const external = path.join(
    f.codexHome,
    "plugins",
    "cache",
    "account",
    "example",
    "1",
    "skills",
    "example",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(external), { recursive: true });
  fs.writeFileSync(external, "external content");
  const result = develop(f.lib, f.workspace, f.options);
  assert.deepEqual(result.conflicts(), []);
  const link = path.join(f.workspace, ".agents", "skills", "example", "SKILL.md");
  assert.equal(fs.realpathSync(link), fs.realpathSync(f.file));
  fs.writeFileSync(f.file, "Bravo\n");
  assert.equal(fs.readFileSync(link, "utf8"), "Bravo\n");
  assert.equal(fs.readFileSync(path.join(f.workspace, ".claude", "skills", "example", "SKILL.md"), "utf8"), "Bravo\n");
  assert.equal(fs.readFileSync(external, "utf8"), "external content");
  assert.match(fs.readFileSync(path.join(f.workspace, ".codex", "config.toml"), "utf8"), /enabled = false/);
  assert.deepEqual(develop(f.lib, f.workspace, f.options).changes(), []);
});

test("plan writes nothing and an existing real skill blocks the entire install", () => {
  const f = fixture();
  assert.equal(develop(f.lib, f.workspace, { ...f.options, plan: true }).conflicts().length, 0);
  assert.equal(fs.existsSync(path.join(f.workspace, ".agents")), false);
  const occupied = path.join(f.workspace, ".agents", "skills", "example");
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "keep.txt"), "keep");
  assert.equal(develop(f.lib, f.workspace, f.options).conflicts().length, 1);
  assert.equal(fs.existsSync(path.join(f.workspace, ".claude")), false);
  assert.equal(fs.readFileSync(path.join(occupied, "keep.txt"), "utf8"), "keep");
});

test("renamed source removes only owned links and retains the source", () => {
  const f = fixture();
  develop(f.lib, f.workspace, f.options);
  const renamed = path.join(path.dirname(path.dirname(f.file)), "renamed");
  fs.renameSync(path.dirname(f.file), renamed);
  const result = develop(f.lib, f.workspace, f.options);
  assert.deepEqual(result.conflicts(), []);
  assert.equal(fs.existsSync(path.join(f.workspace, ".agents", "skills", "example")), false);
  assert.equal(
    fs.readFileSync(path.join(f.workspace, ".agents", "skills", "renamed", "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(renamed, "SKILL.md"), "utf8"),
  );
});

test("missing locked dependency prevents partial install", () => {
  const f = fixture();
  fs.writeFileSync(
    path.join(f.root, "skills-sync.lock.json"),
    JSON.stringify({ version: 2, sources: { upstream: { skills: { missing: {} } } } }),
  );
  assert.ok(
    develop(f.lib, f.workspace, f.options)
      .conflicts()
      .some((a) => a.note?.includes("Missing missing")),
  );
  assert.equal(fs.existsSync(path.join(f.workspace, ".agents")), false);
});

test("config keeps other settings, refreshes its block, and refuses another skills policy", () => {
  const before = "[features]\nplugins = true\n";
  const first = developmentConfig(before, ["C:\\test\\SKILL.md"]);
  assert.ok(first.startsWith(before));
  assert.equal(developmentConfig(first, ["C:\\test\\SKILL.md"]), first);
  assert.equal(developmentConfig(first, []).includes("C:/test"), false);
  const withPlugins = developmentConfig(first, [], ["oneezy@created-by-me-remote", "oneezy@oneezy-skills"]);
  assert.ok(withPlugins.includes('[plugins."oneezy@created-by-me-remote"]\nenabled = false'));
  assert.equal(
    developmentConfig(withPlugins, [], ["oneezy@created-by-me-remote", "oneezy@oneezy-skills"]),
    withPlugins,
  );
  assert.throws(
    () => developmentConfig('[plugins."mine@mine"]\nenabled=true\n', [], ["oneezy@oneezy-skills"]),
    /explicit merge/,
  );
  for (const policy of ["[skills]\nconfig=[]\n", '[[skills.config]]\npath="test"\n', "skills.config=[]\n"])
    assert.throws(() => developmentConfig(policy, []), /explicit merge/);
});

test("external scan excludes system and workspace sources", () => {
  const f = fixture();
  const system = path.join(f.codexHome, "skills", ".system", "builtin");
  fs.mkdirSync(system, { recursive: true });
  fs.writeFileSync(path.join(system, "SKILL.md"), "builtin");
  assert.deepEqual(externalSkills([f.codexHome, f.workspace], f.workspace), []);
});
