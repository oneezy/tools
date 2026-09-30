import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { samePath } from "../src/fs.js";
import { ensureHookFile, ensureProjectHooks } from "../src/hooks.js";
import { findLibrary, homeLibrary } from "../src/library.js";
import { apply, Report } from "../src/plan.js";

let base: string;
before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-hooks-"));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

test("hooks: user and project files are merged once, other hooks kept, ignores appended", () => {
  const homeDir = path.join(base, "home");
  const settings = path.join(homeDir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "bash sync-dev.sh" }] }] } }));
  const r = new Report();
  ensureHookFile(r, settings, "claude");
  apply(r, false);
  const doc = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(doc.theme, "dark");
  assert.equal(doc.hooks.SessionStart.length, 2);
  assert.ok(doc.hooks.SessionStart[1].hooks[0].command.includes("@oneezy/skills-sync --quiet"));
  const again = new Report();
  ensureHookFile(again, settings, "claude");
  assert.deepEqual(again.changes(), []);

  const proj = path.join(base, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".gitignore"), "node_modules/\n");
  const pr = new Report();
  ensureProjectHooks(pr, proj);
  apply(pr, false);
  const codex = JSON.parse(fs.readFileSync(path.join(proj, ".codex", "hooks.json"), "utf8"));
  assert.equal(codex.hooks.SessionStart[0].matcher, "startup|resume");
  const gi = fs.readFileSync(path.join(proj, ".gitignore"), "utf8");
  assert.ok(gi.startsWith("node_modules/\n"));
  assert.ok(gi.includes(".claude/skills/\n") && gi.includes(".agents/skills/\n"));
  const pr2 = new Report();
  ensureProjectHooks(pr2, proj);
  assert.deepEqual(pr2.changes(), []);
});

test("~/.skills-sync wins over the walk-up", () => {
  const homeDir = path.join(base, "home2");
  const libRoot = path.join(base, "somewhere", "library");
  fs.mkdirSync(path.join(libRoot, "skills", "x"), { recursive: true });
  fs.writeFileSync(path.join(libRoot, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: x\n---\n");
  fs.writeFileSync(path.join(libRoot, "skills-lock.json"), '{"version":1,"skills":{}}');
  // a harness config folder with a skills/ subfolder is not a library
  const fakeClaude = path.join(base, ".claude");
  fs.mkdirSync(path.join(fakeClaude, "skills", "y"), { recursive: true });
  fs.writeFileSync(path.join(fakeClaude, "skills", "y", "SKILL.md"), "---\nname: y\ndescription: y\n---\n");
  fs.writeFileSync(path.join(fakeClaude, "skills-lock.json"), '{"version":1,"skills":{}}');
  assert.equal(findLibrary(path.join(fakeClaude, "skills"), {}, homeDir), null);
  fs.mkdirSync(homeDir, { recursive: true });
  assert.equal(homeLibrary(homeDir), path.join(homeDir, ".skills-sync"));
  assert.equal(findLibrary(base, {}, homeDir), null);
  fs.symlinkSync(libRoot, homeLibrary(homeDir), process.platform === "win32" ? "junction" : "dir");
  assert.ok(samePath(findLibrary(base, {}, homeDir)!, libRoot));
});
