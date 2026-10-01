// Per-machine answers live in skills-sync.local.json; skills-sync.json is the committed config. Links are directory
// symlinks first, junctions when Windows refuses; --symlinks / --junctions force one and are remembered.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { isLink, linkDeps, linkTarget, makeLink, samePath, setLinkMode } from "../src/fs.js";
import { harnessTable, type Harness } from "../src/harnesses.js";
import { EMPTY_LOCK, Library } from "../src/library.js";
import { apply, Report } from "../src/plan.js";
import { home, layers } from "../src/steps.js";

let base: string;
let lib: Library;
let homeDir: string;
let claude: Harness;
let codex: Harness;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const SYNC = ["--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl"];

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", lib.root], { encoding: "utf8", cwd: lib.root, env });
}

function skill(folder: string, name: string): string {
  const d = path.join(folder, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\ndo the thing\n`);
  return d;
}

function json(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const local = () => path.join(lib.root, "skills-sync.local.json");
const config = () => path.join(lib.root, "skills-sync.json");

/** What the file system says a link is, independently of this tool: Windows' reparse tag through fsutil; POSIX has only symlinks. */
function kindOnDisk(p: string): "symlink" | "junction" {
  if (process.platform !== "win32") return "symlink";
  const r = spawnSync("fsutil", ["reparsepoint", "query", p], { encoding: "utf8" });
  const m = /Reparse Tag Value\s*:\s*0x([0-9a-f]+)/i.exec(r.stdout);
  assert.ok(m, `fsutil on ${p}: ${r.stdout}${r.stderr}`);
  const tag = m[1].toLowerCase();
  if (tag === "a000000c") return "symlink";
  if (tag === "a0000003") return "junction";
  assert.fail(`unknown reparse tag 0x${tag} on ${p}`);
}

/** Whether this machine lets a non-elevated process create directory symlinks (Developer Mode on Windows). */
function canSymlink(): boolean {
  const d = fs.mkdtempSync(path.join(base, "probe-"));
  fs.mkdirSync(path.join(d, "t"));
  try {
    fs.symlinkSync(path.join(d, "t"), path.join(d, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-local-"));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  lib = new Library(path.join(base, "dev", "skills"));
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  skill(path.join(lib.own, "oneezy"), "a");
  skill(lib.own, "c");
  fs.writeFileSync(lib.lockFile, EMPTY_LOCK);
  const table = harnessTable(homeDir, {});
  claude = table.find((h) => h.id === "claude-code")!;
  codex = table.find((h) => h.id === "codex")!;
  fs.mkdirSync(claude.configDir, { recursive: true });
  fs.mkdirSync(codex.configDir, { recursive: true });
  setLinkMode("auto");
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

test("answers are written to skills-sync.local.json, never to skills-sync.json; the first run records links: auto", () => {
  const r = cli(...SYNC, "--agents", "claude-code,codex");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(config()), "a sync never writes the committed config");
  const l = json(local());
  assert.deepEqual(l.agents, ["claude-code", "codex"]);
  assert.equal(l.global, true);
  assert.equal(l.links, "auto");
  // the answers are read back: a run without --agents syncs the remembered ones
  const again = cli(...SYNC);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual((JSON.parse(again.stdout).actions as Array<{ kind: string }>).filter((a) => a.kind !== "skip"), []);
  assert.deepEqual(json(local()).agents, ["claude-code", "codex"]);
});

test("a legacy answers-only skills-sync.json is migrated once to skills-sync.local.json: the file is moved, one line reports it, the answers hold", () => {
  const legacy = { agents: ["codex"], global: false, dev: path.dirname(lib.root), projects: [], mode: "link", wsl: [], unavailable: ["old"] };
  fs.writeFileSync(config(), JSON.stringify(legacy, null, 2) + "\n");
  const r = cli(...SYNC);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(config()), "the legacy answers file is gone");
  const l = json(local());
  assert.deepEqual(l.agents, ["codex"], "the remembered harness");
  assert.equal(l.global, false, "the remembered answer");
  assert.deepEqual(l.unavailable, ["old"]);
  assert.equal(l.links, "auto");
  assert.ok(!fs.existsSync(claude.userSkills), "global: false was honoured, so no user-folder links");
  const lines = (JSON.parse(r.stdout).actions as Array<{ kind: string; path: string; target?: string }>).filter((a) => samePath(a.path, config()) || (a.target && samePath(a.target, local())));
  assert.equal(lines.length, 1, `one report line for the move: ${JSON.stringify(lines)}`);
  assert.equal(lines[0].kind, "move");
  assert.ok(samePath(lines[0].target!, local()));
  const again = cli(...SYNC);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!(JSON.parse(again.stdout).actions as Array<{ kind: string }>).some((a) => a.kind === "move"), "migrated once");
});

test("a skills-sync.json with a sources or plugins key is the committed config, never answers: it is left alone and the answers go to the local file", () => {
  const cfg = { version: 1, sources: {}, plugins: {} };
  const text = JSON.stringify(cfg, null, 2) + "\n";
  fs.writeFileSync(config(), text);
  const r = cli(...SYNC, "--agents", "claude-code,codex");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(config(), "utf8"), text, "the config is untouched");
  assert.deepEqual(json(local()).agents, ["claude-code", "codex"]);
  assert.ok(!(JSON.parse(r.stdout).actions as Array<{ kind: string }>).some((a) => a.kind === "move"));
  // a file holding both answers and a sources key is a config with keys it may not have, not a legacy answers file
  fs.writeFileSync(config(), JSON.stringify({ version: 1, sources: {}, agents: ["codex"] }) + "\n");
  const bad = cli(...SYNC);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /\$\.agents: not allowed/);
  assert.ok(fs.existsSync(config()), "never moved");
});

test("links: a directory symlink is tried first; when it is refused with EPERM the link becomes a junction and the report says so", () => {
  const eperm = Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
  const real = linkDeps.symlink;
  linkDeps.symlink = (target, link, type) => {
    if (type !== "junction") throw eperm;
    return real(target, link, type);
  };
  try {
    const r = runAll();
    assert.deepEqual(r.conflicts(), []);
    assert.equal(r.links.symlink, 0);
    assert.ok(r.links.junction >= 4, `junctions made: ${r.links.junction}`);
    if (process.platform === "win32") {
      for (const p of [path.join(lib.agents, "a"), path.join(claude.userSkills, "c")]) {
        assert.ok(isLink(p), p);
        assert.equal(kindOnDisk(p), "junction", p);
      }
    }
  } finally {
    linkDeps.symlink = real;
  }
  assert.deepEqual(runAll().changes(), [], "a second run leaves the junctions alone");
});

test("links: where the symlink succeeds, the link is a symlink and the report counts it so", (t) => {
  if (!canSymlink()) return t.skip("this machine refuses directory symlinks (no Developer Mode, not elevated)");
  const r = runAll();
  assert.deepEqual(r.conflicts(), []);
  assert.equal(r.links.junction, 0);
  assert.ok(r.links.symlink >= 4, `symlinks made: ${r.links.symlink}`);
  const p = path.join(lib.agents, "a");
  assert.equal(kindOnDisk(p), "symlink");
  assert.ok(samePath(linkTarget(p)!, path.join(lib.own, "oneezy", "a")));
  assert.equal(makeLink(path.join(lib.own, "c"), path.join(base, "made-by-hand")), "symlink");
});

test("--junctions forces junctions and records links: junction; --symlinks the inverse; the remembered mode is read on every run", (t) => {
  const first = cli(...SYNC, "--agents", "claude-code,codex", "--junctions");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(json(local()).links, "junction");
  const out = JSON.parse(first.stdout);
  assert.equal(out.links.symlink, 0);
  assert.ok(out.links.junction >= 4, JSON.stringify(out.links));
  if (process.platform === "win32") assert.equal(kindOnDisk(path.join(claude.userSkills, "a")), "junction");

  // the inverse: the user folders are unlinked and made again as symlinks
  assert.equal(cli("unlink", "--quiet").status, 0);
  const second = cli(...SYNC, "--symlinks");
  assert.equal(second.status, 0, second.stderr);
  assert.equal(json(local()).links, "symlink");
  if (!canSymlink()) return t.skip("symlinks refused on this machine; the mode was still recorded");
  const out2 = JSON.parse(second.stdout);
  assert.equal(out2.links.junction, 0);
  assert.ok(out2.links.symlink >= 2, JSON.stringify(out2.links));
  assert.equal(kindOnDisk(path.join(claude.userSkills, "a")), "symlink");

  // no flag: the remembered mode stands
  const third = cli(...SYNC);
  assert.equal(third.status, 0, third.stderr);
  assert.equal(json(local()).links, "symlink");
  assert.equal(JSON.parse(third.stdout).linkMode, "symlink");
});
