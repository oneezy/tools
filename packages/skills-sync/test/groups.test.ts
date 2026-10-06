// A grouped library: skills/<plugin>/<skill> beside flat skills/<skill>. Every step sees a grouped skill by its folder name.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";
import { isLink, lexists, linkTarget, real, samePath } from "../src/fs.js";
import { harnessTable, type Harness } from "../src/harnesses.js";
import { EMPTY_LOCK, findLibrary, Library, looksLikeLibrary } from "../src/library.js";
import { apply, Report } from "../src/plan.js";
import { home, layers } from "../src/steps.js";

let base: string;
let lib: Library;
let homeDir: string;
let claude: Harness;
let codex: Harness;

function skill(folder: string, name: string): string {
  const d = path.join(folder, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\ndo the thing\n`);
  return d;
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-groups-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  lib = new Library(path.join(base, "dev", "skills"));
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  skill(path.join(lib.own, "oneezy"), "a");
  skill(path.join(lib.own, "oneezy"), "b");
  skill(lib.own, "c");
  fs.writeFileSync(lib.npxLockFile, EMPTY_LOCK);
  const table = harnessTable(homeDir, {});
  claude = table.find((h) => h.id === "claude-code")!;
  codex = table.find((h) => h.id === "codex")!;
  fs.mkdirSync(claude.configDir, { recursive: true });
  fs.mkdirSync(codex.configDir, { recursive: true });
});

function runAll(): Report {
  const r = new Report();
  const l = new Report();
  layers(lib, [claude, codex], l);
  apply(l, false);
  r.merge(l);
  const h = new Report();
  home(lib, [claude, codex], h);
  apply(h, false);
  r.merge(h);
  return r;
}

const expected = () => [
  ["a", path.join(lib.own, "oneezy", "a")],
  ["b", path.join(lib.own, "oneezy", "b")],
  ["c", path.join(lib.own, "c")],
];

test("grouped and flat own skills sync by folder name into .agents, every layer and every user folder; a second run changes nothing", () => {
  const r = runAll();
  assert.deepEqual(r.conflicts(), []);
  for (const [n, dir] of expected()) {
    const link = path.join(lib.agents, n);
    assert.ok(isLink(link), link);
    assert.ok(samePath(real(link), dir), `${n} links to its real folder`);
    assert.ok(isLink(path.join(lib.root, claude.projectSkills, n)), `${n} in the Claude layer`);
    for (const h of [claude, codex]) {
      const u = path.join(h.userSkills, n);
      assert.ok(isLink(u), u);
      assert.ok(samePath(linkTarget(u)!, dir), `${u} points at the real folder`);
    }
  }
  assert.ok(!lexists(path.join(lib.agents, "oneezy")), "the group itself is never linked");
  const gi = fs.readFileSync(path.join(lib.agents, ".gitignore"), "utf8");
  for (const n of ["a", "b", "c"]) assert.ok(gi.includes(`/${n}/\n`), `${n} in .agents/skills/.gitignore`);
  const again = runAll();
  assert.deepEqual(again.changes(), []);
  assert.deepEqual(again.conflicts(), []);
});

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");

/** The harness locations the CLI reads from its environment. The child must see the temp home only, whatever the session running the tests has set. */
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;

/** Run the CLI against the temp library with the home directory redirected into the temp folder and every harness override dropped, so its harness table is harnessTable(homeDir, {}). */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", lib.root, "--agents", "claude-code,codex"], { encoding: "utf8", cwd: lib.root, env });
}

test("status --json names each own skill's plugin id: oneezy, oneezy, none", () => {
  const r = cli("status", "--json");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.own, ["a", "b", "c"]);
  assert.deepEqual(s.ownSkills, [
    { name: "a", plugin: "oneezy", path: "skills/oneezy/a" },
    { name: "b", plugin: "oneezy", path: "skills/oneezy/b" },
    { name: "c", plugin: null, path: "skills/c" },
  ]);
  assert.ok(!lexists(path.join(os.homedir(), ".skills-sync")) || !samePath(real(path.join(os.homedir(), ".skills-sync")), lib.root), "the real home is untouched");
});

test("a play group links exactly like oneezy: skills/play/play-unslop is play-unslop in .agents, every layer and every user folder, by its folder name", () => {
  const dir = skill(path.join(lib.own, "play"), "play-unslop");
  const r = runAll();
  assert.deepEqual(r.conflicts(), []);
  assert.ok(samePath(real(path.join(lib.agents, "play-unslop")), dir));
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "play-unslop")));
  for (const h of [claude, codex]) assert.ok(samePath(linkTarget(path.join(h.userSkills, "play-unslop"))!, dir), h.userSkills);
  assert.ok(!lexists(path.join(lib.agents, "play")), "the group itself is never linked");
  assert.ok(fs.readFileSync(path.join(lib.agents, ".gitignore"), "utf8").includes("/play-unslop/\n"));
  assert.deepEqual(lib.scanOwn().skills.map((s) => [s.name, s.plugin]), [["a", "oneezy"], ["b", "oneezy"], ["c", null], ["play-unslop", "play"]]);
});

test("removing a grouped skill drops its links everywhere; its siblings stay", () => {
  runAll();
  fs.rmSync(path.join(lib.own, "oneezy", "b"), { recursive: true });
  const r = runAll();
  assert.ok(r.actions.some((a) => a.kind === "remove" && a.path.endsWith("b")));
  assert.ok(!lexists(path.join(lib.agents, "b")));
  assert.ok(!lexists(path.join(lib.root, claude.projectSkills, "b")));
  for (const h of [claude, codex]) assert.ok(!lexists(path.join(h.userSkills, "b")), h.userSkills);
  assert.ok(isLink(path.join(lib.agents, "a")));
  assert.ok(isLink(path.join(claude.userSkills, "a")));
  assert.ok(!fs.readFileSync(path.join(lib.agents, ".gitignore"), "utf8").includes("/b/"));
});

test("a skill that moves from flat into a group keeps its name: every link is retargeted, none is dropped", () => {
  runAll();
  fs.renameSync(path.join(lib.own, "c"), path.join(lib.own, "oneezy", "c"));
  const r = runAll();
  assert.ok(!r.actions.some((a) => a.kind === "remove"), "nothing removed");
  assert.ok(r.actions.some((a) => a.kind === "relink" && a.path.endsWith("c")), ".agents link retargeted");
  const moved = path.join(lib.own, "oneezy", "c");
  assert.ok(samePath(real(path.join(lib.agents, "c")), moved));
  for (const h of [claude, codex]) assert.ok(samePath(linkTarget(path.join(h.userSkills, "c"))!, moved), h.userSkills);
  assert.deepEqual(runAll().changes(), []);
});

test("a library is skills/ beside skills-sync.json, skills-lock.json or skills-sync.lock.json; findLibrary order and the dot-folder rule hold", () => {
  const mk = (name: string, marker: string | null, withSkills = true) => {
    const d = path.join(base, name);
    fs.mkdirSync(withSkills ? path.join(d, "skills") : d, { recursive: true });
    if (marker) fs.writeFileSync(path.join(d, marker), JSON.stringify({ version: 1, sources: {} }));
    return d;
  };
  assert.ok(looksLikeLibrary(mk("config-only", "skills-sync.json")), "config, no lock");
  assert.ok(looksLikeLibrary(mk("lock-only", "skills-lock.json")), "lock, no config");
  assert.ok(looksLikeLibrary(mk("v2-lock-only", "skills-sync.lock.json")), "the skills-sync lock, no config");
  assert.ok(!looksLikeLibrary(mk("bare", null)), "skills/ alone is not a library");
  assert.ok(!looksLikeLibrary(mk("no-skills", "skills-sync.json", false)), "a config without skills/ is not a library");
  assert.ok(!looksLikeLibrary(mk("old-manifest", "skills-sources.json")), "the old manifest name is not a marker");
  assert.ok(!looksLikeLibrary(mk("old-sources-lock", "skills-sources-lock.json")), "the old sources lock is not a marker");

  // the walk-up skips a dot-folder that looks like a library and finds the real one above it
  const dot = mk(path.join("dev", "skills", ".claude"), "skills-sync.json");
  assert.equal(findLibrary(path.join(dot, "skills"), {}, homeDir), lib.root);
  // $SKILLS_REPO beats ~/.skills-sync, which beats the walk-up
  const other = mk("other", "skills-sync.json");
  fs.symlinkSync(other, path.join(homeDir, ".skills-sync"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(findLibrary(lib.own, {}, homeDir), real(other));
  const third = mk("third", "skills-lock.json");
  assert.equal(findLibrary(lib.own, { SKILLS_REPO: third }, homeDir), path.resolve(third));
});

test("a SKILL.md two levels below a group is ignored with one reported line and never linked", () => {
  skill(path.join(lib.own, "x", "y"), "z");
  const r = runAll();
  const reported = r.actions.filter((a) => samePath(a.path, path.join(lib.own, "x", "y")));
  assert.equal(reported.length, 1, "exactly one line for skills/x/y");
  assert.equal(reported[0].kind, "conflict");
  assert.ok(reported[0].note?.includes("ignored"), reported[0].note);
  assert.deepEqual(r.changes().map((a) => path.basename(a.path)).filter((n) => ["x", "y", "z"].includes(n)), []);
  for (const n of ["x", "y", "z"]) {
    assert.ok(!lexists(path.join(lib.agents, n)), n);
    assert.ok(!lexists(path.join(lib.root, claude.projectSkills, n)), n);
    for (const h of [claude, codex]) assert.ok(!lexists(path.join(h.userSkills, n)), n);
  }
  assert.ok(!fs.readFileSync(path.join(lib.agents, ".gitignore"), "utf8").includes("/z/"));
  assert.equal(runAll().actions.filter((a) => samePath(a.path, path.join(lib.own, "x", "y"))).length, 1, "reported again next run, still once");
});

test("two own skills with one folder name: the first by path wins, the other is ignored with one reported line", () => {
  const dup = skill(path.join(lib.own, "trident"), "a"); // skills/trident/a beside skills/oneezy/a
  const r = runAll();
  const reported = r.actions.filter((a) => samePath(a.path, dup));
  assert.equal(reported.length, 1, "exactly one line for the duplicate");
  assert.equal(reported[0].kind, "conflict");
  assert.ok(reported[0].note?.includes("ignored"), reported[0].note);
  assert.ok(samePath(real(path.join(lib.agents, "a")), path.join(lib.own, "oneezy", "a")), "skills/oneezy/a wins");
  assert.equal(lib.ownSkills().filter((n) => n === "a").length, 1);
  assert.deepEqual(runAll().changes(), []);
});

test("sync through the CLI links grouped and flat skills alike; the second run reports no changes", () => {
  const first = cli("--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl");
  assert.equal(first.status, 0, first.stderr);
  const linked = (JSON.parse(first.stdout).actions as Array<{ kind: string; path: string }>).filter((a) => a.kind === "link").map((a) => a.path);
  for (const [n, dir] of expected()) {
    assert.ok(linked.some((p) => samePath(p, path.join(lib.agents, n))), `${n} linked into .agents`);
    assert.ok(samePath(real(path.join(lib.agents, n)), dir), `${n} resolves to its real folder`);
    for (const h of [claude, codex]) assert.ok(linked.some((p) => samePath(p, path.join(h.userSkills, n))), `${n} in ${h.userSkills}`);
  }
  const second = cli("--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual((JSON.parse(second.stdout).actions as Array<{ kind: string }>).filter((a) => a.kind !== "skip"), []);
});

test("harness overrides in the environment running the tests never reach the CLI child: it links into the temp home, not into them", () => {
  const decoy = path.join(base, "decoy");
  const saved = HARNESS_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of HARNESS_ENV) {
    process.env[k] = path.join(decoy, k);
    fs.mkdirSync(process.env[k], { recursive: true });
  }
  try {
    const r = cli("--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl");
    assert.equal(r.status, 0, r.stderr);
    for (const k of HARNESS_ENV) assert.deepEqual(fs.readdirSync(path.join(decoy, k)), [], `nothing written under $${k}`);
    for (const [n, dir] of expected()) {
      const u = path.join(claude.userSkills, n);
      assert.ok(isLink(u), u);
      assert.ok(samePath(linkTarget(u)!, dir), `${u} points at the real folder`);
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
