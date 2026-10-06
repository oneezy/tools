import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";
import { gitExclude, isLink, lexists, linkTarget, real, samePath, under } from "../src/fs.js";
import { harnessTable, type Harness } from "../src/harnesses.js";
import { findLibrary, Library, sidecarFor } from "../src/library.js";
import { apply, Report } from "../src/plan.js";
import { findProjects, home, layers, projects, status, unlink } from "../src/steps.js";
import { toWslPath } from "../src/wsl.js";

let base: string;
let lib: Library;
let homeDir: string;
let table: Harness[];
let claude: Harness;
let codex: Harness;

function skill(folder: string, name: string, body = "do the thing", extraFm = ""): string {
  const d = path.join(folder, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n${extraFm}---\n${body}\n`);
  return d;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  const dev = path.join(base, "dev");
  lib = new Library(path.join(dev, "skills"));
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  skill(lib.own, "oneezy-merge", "x", "disable-model-invocation: true\n");
  skill(lib.own, "oneezy-status");
  skill(lib.agents, "grilling"); // a third-party copy installed by npx skills
  fs.mkdirSync(path.join(lib.agents, "grilling", "agents"));
  fs.writeFileSync(path.join(lib.agents, "grilling", "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: true\n");
  fs.writeFileSync(lib.npxLockFile, JSON.stringify({ version: 1, skills: { grilling: { source: "mattpocock/skills", sourceType: "github", computedHash: "x" } } }));
  table = harnessTable(homeDir, {});
  claude = table.find((h) => h.id === "claude-code")!;
  codex = table.find((h) => h.id === "codex")!;
  fs.mkdirSync(claude.configDir, { recursive: true });
  fs.mkdirSync(codex.configDir, { recursive: true });
});

function runAll(plan = false): Report {
  const r = new Report();
  const l = new Report();
  layers(lib, [claude, codex], l);
  apply(l, plan);
  r.merge(l);
  const h = new Report();
  home(lib, [claude, codex], h);
  apply(h, plan);
  r.merge(h);
  return r;
}

test("own skills are linked into .agents and every skill into the Claude layer", () => {
  runAll();
  for (const n of ["oneezy-merge", "oneezy-status"]) {
    assert.ok(isLink(path.join(lib.agents, n)));
    assert.ok(samePath(real(path.join(lib.agents, n)), path.join(lib.own, n)));
  }
  for (const n of ["oneezy-merge", "oneezy-status", "grilling"]) {
    const link = path.join(lib.root, claude.projectSkills, n);
    assert.ok(isLink(link), n);
    assert.ok(fs.existsSync(path.join(link, "SKILL.md")), n);
  }
  assert.ok(!isLink(path.join(lib.agents, "grilling")), "third-party copy stays real");
  const gi = fs.readFileSync(path.join(lib.agents, ".gitignore"), "utf8");
  assert.ok(gi.includes("/oneezy-merge/\n"));
  assert.ok(!gi.includes("grilling"));
});

test("second run changes nothing", () => {
  runAll();
  const r = runAll();
  assert.deepEqual(r.changes(), []);
  assert.deepEqual(r.conflicts(), []);
});

test("plan touches nothing", () => {
  const r = runAll(true);
  assert.ok(r.actions.some((a) => a.kind === "link"));
  assert.ok(!fs.existsSync(path.join(lib.root, ".claude")));
  assert.ok(!fs.existsSync(claude.userSkills));
});

test("a removed own skill drops its links everywhere", () => {
  runAll();
  fs.rmSync(path.join(lib.own, "oneezy-status"), { recursive: true });
  const r = runAll();
  assert.ok(r.actions.some((a) => a.kind === "remove" && a.path.endsWith("oneezy-status")));
  assert.ok(!lexists(path.join(lib.agents, "oneezy-status")));
  assert.ok(!lexists(path.join(claude.userSkills, "oneezy-status")));
  assert.ok(lexists(path.join(claude.userSkills, "oneezy-merge")));
});

test("a stale copy in a generated layer becomes a link; a real folder in .agents is a conflict", () => {
  skill(path.join(lib.root, claude.projectSkills), "grilling", "old copy");
  skill(lib.agents, "oneezy-merge", "someone's copy");
  const r = runAll();
  assert.ok(r.actions.some((a) => a.kind === "replace-copy"));
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "grilling")));
  assert.ok(r.conflicts().some((a) => a.path.endsWith("oneezy-merge")));
  assert.ok(fs.readFileSync(path.join(lib.agents, "oneezy-merge", "SKILL.md"), "utf8").includes("someone's copy"));
});

test("user folders get one link per skill pointing at the real folder; unmanaged entries are left alone", () => {
  skill(claude.userSkills, "oneezy-brain", "not in the library");
  fs.mkdirSync(path.join(claude.userSkills, "synced"), { recursive: true });
  const r = runAll();
  for (const h of [claude, codex]) {
    for (const n of ["oneezy-merge", "oneezy-status", "grilling"]) {
      const link = path.join(h.userSkills, n);
      assert.ok(isLink(link), link);
      const t = linkTarget(link)!;
      assert.ok(!isLink(t), "points at the real folder, not another link");
      assert.ok(under(t, lib.root));
    }
  }
  assert.ok(!isLink(path.join(claude.userSkills, "oneezy-brain")));
  assert.ok(fs.statSync(path.join(claude.userSkills, "synced")).isDirectory());
  assert.equal(r.conflicts().length, 0);
});

test("unlink removes only our links", () => {
  runAll();
  const other = skill(path.join(base, "elsewhere"), "thing");
  fs.symlinkSync(other, path.join(codex.userSkills, "thing"), process.platform === "win32" ? "junction" : "dir");
  const r = new Report();
  unlink(lib, [claude, codex], r);
  apply(r, false);
  assert.ok(!lexists(path.join(codex.userSkills, "grilling")));
  assert.ok(isLink(path.join(codex.userSkills, "thing")));
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "grilling")), "library layers untouched");
});

test("sidecar is generated from Claude frontmatter for own skills", () => {
  runAll();
  const f = path.join(lib.own, "oneezy-merge", "agents", "openai.yaml");
  assert.ok(fs.existsSync(f));
  assert.ok(fs.readFileSync(f, "utf8").includes("allow_implicit_invocation: false"));
  const auto = sidecarFor(path.join(lib.own, "oneezy-status"))!;
  assert.ok(!auto.includes("policy"));
  assert.ok(auto.includes("display_name: oneezy-status"));
});

test("projects: link mode links each layer and excludes them from git; copy mode copies and is idempotent", () => {
  runAll();
  const dev = path.dirname(lib.root);
  const proj = path.join(dev, "app");
  fs.mkdirSync(path.join(proj, ".git", "info"), { recursive: true });
  fs.mkdirSync(path.join(dev, "notes"));
  assert.deepEqual(findProjects(dev, lib).map((x) => path.basename(x)), ["app"]);

  const r = new Report();
  projects(lib, [claude, codex], [proj], null, "link", r);
  apply(r, false, gitExclude);
  assert.ok(isLink(path.join(proj, ".claude", "skills", "grilling")));
  assert.ok(isLink(path.join(proj, ".agents", "skills", "oneezy-merge")));
  const exclude = fs.readFileSync(path.join(proj, ".git", "info", "exclude"), "utf8");
  assert.ok(exclude.includes("/.claude/skills/grilling/"));
  assert.ok(exclude.includes("/.agents/skills/oneezy-merge/"));

  const proj2 = path.join(dev, "site");
  fs.mkdirSync(path.join(proj2, ".git"), { recursive: true });
  const c = new Report();
  projects(lib, [claude, codex], [proj2], ["oneezy-merge", "grilling"], "copy", c);
  apply(c, false, gitExclude);
  assert.ok(!isLink(path.join(proj2, ".claude", "skills", "oneezy-merge")));
  assert.ok(fs.existsSync(path.join(proj2, ".agents", "skills", "grilling", "agents", "openai.yaml")));
  assert.ok(!fs.existsSync(path.join(proj2, ".agents", "skills", "oneezy-status")));
  const c2 = new Report();
  projects(lib, [claude, codex], [proj2], ["oneezy-merge", "grilling"], "copy", c2);
  assert.deepEqual(c2.changes(), []);
});

test("findLibrary walks up, then env; status counts lock entries not installed", () => {
  assert.equal(findLibrary(path.join(lib.own, "oneezy-merge"), {}, homeDir), lib.root);
  assert.equal(findLibrary(base, { SKILLS_REPO: lib.root }, homeDir), lib.root);
  assert.equal(findLibrary(base, {}, homeDir), null);
  fs.rmSync(path.join(lib.agents, "grilling"), { recursive: true });
  const s = status(lib, [claude, codex]);
  assert.deepEqual(s.missingFromLock, ["grilling"]);
  assert.deepEqual(s.own, ["oneezy-merge", "oneezy-status"]);
});

test("windows paths translate to /mnt for WSL", () => {
  assert.equal(toWslPath("V:\\dev\\skills"), "/mnt/v/dev/skills");
  assert.equal(toWslPath("/already/posix"), "/already/posix");
});
