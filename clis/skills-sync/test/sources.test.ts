// Third-party sources: skills-sync.json declares them, refresh snapshots them under upstream/, writes the lock,
// rebuilds the working set and regenerates skills-lock.json. Upstream is a temp git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { isLink, lexists } from "../src/fs.js";
import { Library } from "../src/library.js";

let base: string;
let lib: Library;
let homeDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", lib.root], { encoding: "utf8", cwd: lib.root, env });
}

const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** A temp git repository standing in for a source: skills/<n>/SKILL.md files and a LICENSE, committed. */
class Upstream {
  constructor(public dir: string) {}
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  skill(name: string, body = "do the thing", root = "skills"): void {
    const d = path.join(this.dir, root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", msg);
    return this.head();
  }
  head(): string {
    return this.git("rev-parse", "HEAD");
  }
}

function upstream(name: string): Upstream {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const u = new Upstream(dir);
  u.git("init", "-q", "-b", "main");
  return u;
}

/** The npx skills recipe, written from vercel-labs/skills src/local-lock.ts, not from this tool's code. */
function recipeHash(dir: string): string {
  const files: Array<{ rel: string; full: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== "node_modules") walk(full);
      } else if (e.isFile()) files.push({ rel: path.relative(dir, full).split("\\").join("/"), full });
    }
  };
  walk(dir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.rel);
    h.update(fs.readFileSync(f.full));
  }
  return h.digest("hex");
}

function json(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function manifest(sources: Record<string, unknown>): void {
  fs.writeFileSync(lib.configFile, JSON.stringify({ version: 1, sources, plugins: {} }, null, 2) + "\n");
}

function source(u: Upstream, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: u.dir, ref: "main", policy: "follow", root: "skills", skills: ["a", "b"], attribution: ["LICENSE"], ...extra };
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-sources-"));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  lib = new Library(path.join(base, "dev", "skills"));
  fs.mkdirSync(path.join(lib.own, "oneezy", "own-one"), { recursive: true });
  fs.writeFileSync(path.join(lib.own, "oneezy", "own-one", "SKILL.md"), "---\nname: own-one\ndescription: mine\n---\nmine\n");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  up = upstream("up");
  up.skill("a");
  up.skill("b");
  up.skill("c");
  fs.writeFileSync(path.join(up.dir, "LICENSE"), "MIT\n");
  up.commit("one");
});

test("refresh snapshots the selected skills and the attribution file, writes .snapshot.json and the lock with the commit and recipe hashes, regenerates skills-lock.json, copies the working set; a second refresh is a no-op", () => {
  manifest({ up: source(up) });
  const r = cli("refresh", "--json");
  assert.equal(r.status, 0, r.stderr);
  const snap = path.join(lib.upstream, "up");
  for (const n of ["a", "b"]) assert.ok(fs.existsSync(path.join(snap, "skills", n, "SKILL.md")), `${n} snapshotted`);
  assert.ok(!fs.existsSync(path.join(snap, "skills", "c")), "c not selected, not snapshotted");
  assert.equal(fs.readFileSync(path.join(snap, "LICENSE"), "utf8"), "MIT\n");
  const meta = json(path.join(snap, ".snapshot.json"));
  assert.equal(meta.source, "up");
  assert.equal(meta.commit, up.head());

  const lock = json(lib.sourcesLockFile);
  assert.equal(lock.version, 1);
  assert.equal(lock.sources.up.commit, up.head());
  assert.match(lock.sources.up.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(lock.sources.up.skills), ["a", "b"]);
  for (const n of ["a", "b"]) {
    assert.equal(lock.sources.up.skills[n].path, `skills/${n}`);
    assert.equal(lock.sources.up.skills[n].hash, recipeHash(path.join(up.dir, "skills", n)), `${n} hash is the recipe's`);
    assert.equal(lock.sources.up.skills[n].hash, recipeHash(path.join(snap, "skills", n)), `${n} snapshot matches`);
  }
  assert.equal(lock.generated.manifest, createHash("sha256").update(fs.readFileSync(lib.configFile)).digest("hex"));

  const compat = json(lib.lockFile);
  assert.deepEqual(Object.keys(compat.skills), ["a", "b"]);
  assert.equal(compat.skills.a.skillPath, "skills/a/SKILL.md");
  assert.equal(compat.skills.a.computedHash, lock.sources.up.skills.a.hash);
  assert.equal(compat.skills.a.ref, "main");

  for (const n of ["a", "b"]) {
    const w = path.join(lib.agents, n);
    assert.ok(fs.existsSync(path.join(w, "SKILL.md")), `${n} in the working set`);
    assert.ok(!isLink(w), "a copy, not a link");
  }
  assert.ok(!lexists(path.join(lib.agents, "c")));

  const before = [lib.sourcesLockFile, lib.lockFile, path.join(snap, ".snapshot.json")].map((f) => fs.readFileSync(f, "utf8"));
  const again = cli("refresh", "--json");
  assert.equal(again.status, 0, again.stderr);
  const actions = JSON.parse(again.stdout).actions as Array<{ kind: string; path: string }>;
  assert.deepEqual(actions.filter((a) => a.kind !== "skip"), [], "second refresh changes nothing");
  assert.deepEqual([lib.sourcesLockFile, lib.lockFile, path.join(snap, ".snapshot.json")].map((f) => fs.readFileSync(f, "utf8")), before);
});

/** The actions of a --json run that touch a file: neither a skip nor a reported conflict. */
function changes(r: { stdout: string }): Array<{ kind: string; path: string }> {
  return (JSON.parse(r.stdout).actions as Array<{ kind: string; path: string }>).filter((a) => a.kind !== "skip" && a.kind !== "conflict");
}

test("a follow source moves to the new upstream commit on refresh and stays on refresh --frozen; a pinned source stays; a per-skill pin holds that skill while its sibling moves", () => {
  const first = up.head();
  manifest({ up: source(up), pinned: source(up, { policy: "pin" }), partial: source(up, { pins: { a: first } }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  up.skill("a", "a, second edition");
  up.skill("b", "b, second edition");
  const second = up.commit("two");

  const frozen = cli("refresh", "--frozen", "--json");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.deepEqual(changes(frozen), [], "frozen moves nothing");
  assert.equal(json(lib.sourcesLockFile).sources.up.commit, first);
  assert.ok(!fs.readFileSync(path.join(lib.agents, "a", "SKILL.md"), "utf8").includes("second edition"));

  const moved = cli("refresh", "--json");
  assert.equal(moved.status, 0, moved.stderr);
  const lock = json(lib.sourcesLockFile);
  assert.equal(lock.sources.up.commit, second, "follow moved");
  assert.equal(lock.sources.pinned.commit, first, "pin stayed");
  assert.equal(lock.sources.partial.commit, second, "the source of the pinned skill moved");
  assert.equal(lock.sources.partial.skills.a.pinnedCommit, first, "a is held at its pin");
  assert.equal(lock.sources.partial.skills.b.pinnedCommit, undefined);
  assert.equal(lock.sources.partial.skills.a.hash, lock.sources.pinned.skills.a.hash, "the snapshot of a in partial is the first edition");
  assert.equal(lock.sources.partial.skills.b.hash, lock.sources.up.skills.b.hash, "the snapshot of b in partial is the second edition");
  assert.ok(fs.readFileSync(path.join(lib.upstream, "up", "skills", "a", "SKILL.md"), "utf8").includes("second edition"));
  assert.ok(!fs.readFileSync(path.join(lib.upstream, "partial", "skills", "a", "SKILL.md"), "utf8").includes("second edition"));
  assert.ok(!fs.readFileSync(path.join(lib.upstream, "pinned", "skills", "a", "SKILL.md"), "utf8").includes("second edition"));
  // three sources select a and b under the same names: the first source by id (partial) wins the copy, the others are conflicts
  const conflicts = (JSON.parse(moved.stdout).actions as Array<{ kind: string; note?: string }>).filter((a) => a.kind === "conflict").map((a) => a.note);
  assert.equal(conflicts.length, 4, conflicts.join("\n"));
  assert.ok(conflicts.some((n) => n?.startsWith("pinned also selects a as a; partial wins")), conflicts.join("\n"));
  assert.ok(!fs.readFileSync(path.join(lib.agents, "a", "SKILL.md"), "utf8").includes("second edition"), "a in the working set is the pinned one from partial");
  assert.ok(fs.readFileSync(path.join(lib.agents, "b", "SKILL.md"), "utf8").includes("second edition"), "b in the working set follows, from partial");
  assert.deepEqual(changes(cli("refresh", "--json")), [], "settled");
});

test("a rename (tdd -> pstack-tdd) yields .agents/skills/pstack-tdd with name: pstack-tdd, an untouched snapshot, and the transform in the lock", () => {
  up.skill("tdd", "red, green");
  up.commit("tdd");
  manifest({ up: source(up, { skills: { tdd: "pstack-tdd", a: "a" } }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const working = fs.readFileSync(path.join(lib.agents, "pstack-tdd", "SKILL.md"), "utf8");
  assert.equal(working, "---\nname: pstack-tdd\ndescription: tdd skill\n---\nred, green\n");
  assert.ok(!lexists(path.join(lib.agents, "tdd")));
  const snapshot = fs.readFileSync(path.join(lib.upstream, "up", "skills", "tdd", "SKILL.md"), "utf8");
  assert.equal(snapshot, fs.readFileSync(path.join(up.dir, "skills", "tdd", "SKILL.md"), "utf8"), "the snapshot holds the bytes of upstream");
  const lock = json(lib.sourcesLockFile);
  assert.deepEqual(lock.sources.up.skills.tdd.transforms, [{ kind: "rename", to: "pstack-tdd" }]);
  assert.equal(lock.sources.up.skills.tdd.hash, recipeHash(path.join(up.dir, "skills", "tdd")), "the hash is the upstream one, not the renamed copy");
  assert.equal(lock.sources.up.skills.a.transforms, undefined);
  const compat = json(lib.lockFile);
  assert.equal(compat.skills["pstack-tdd"].skillPath, "skills/tdd/SKILL.md");
  assert.ok(!("tdd" in compat.skills));
  assert.deepEqual(changes(cli("refresh", "--json")), [], "settled");
});

test("skills-lock.json for a GitHub source: source owner/repo, sourceType github, skillPath, computedHash, ref only for a branch or tag", async () => {
  const { compatLock } = await import("../src/sources.js");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const hash = "c78e3210c4a86e23088a3f88abf61e3fd7f4dabcd0d58daa5166799022e2eef3";
  const m = {
    version: 1 as const,
    sources: {
      mp: { repo: "mattpocock/skills", ref: "main", policy: "follow" as const, root: "skills", skills: ["tdd"] },
      held: { repo: "https://github.com/cursor/plugins.git", ref: sha, policy: "pin" as const, skills: { teach: "pstack-teach" } },
    },
  };
  const lock = {
    version: 1 as const,
    generated: { manifest: hash },
    releases: {},
    sources: {
      mp: { commit: sha, date: "2026-09-30T00:00:00Z", skills: { tdd: { path: "skills/engineering/tdd", hash } } },
      held: { commit: sha, date: "2026-09-30T00:00:00Z", skills: { teach: { path: "pstack/skills/teach", hash, transforms: [{ kind: "rename" as const, to: "pstack-teach" }] } } },
    },
  };
  const compat = JSON.parse(compatLock(m, lock));
  assert.deepEqual(compat, {
    version: 1,
    skills: {
      "pstack-teach": { source: "cursor/plugins", sourceType: "github", skillPath: "pstack/skills/teach/SKILL.md", computedHash: hash },
      tdd: { source: "mattpocock/skills", ref: "main", sourceType: "github", skillPath: "skills/engineering/tdd/SKILL.md", computedHash: hash },
    },
  });
  assert.deepEqual(Object.keys(compat.skills.tdd), ["source", "ref", "sourceType", "skillPath", "computedHash"], "keys in the order npx skills writes them");
});

test("the hash equals what npx skills 1.7.0 wrote for the same files (a literal taken from its lock): localeCompare order, path then bytes", () => {
  // fixture and value from a run of skills@1.7.0 `add ./fixture`; Zebra.md and alpha.md sort right only under localeCompare
  const d = path.join(up.dir, "skills", "probe");
  fs.mkdirSync(path.join(d, "agents"), { recursive: true });
  fs.mkdirSync(path.join(d, "references"), { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), "---\nname: probe\ndescription: a probe skill\n---\nThe body.\n");
  fs.writeFileSync(path.join(d, "agents", "openai.yaml"), "interface:\n  display_name: probe\n");
  fs.writeFileSync(path.join(d, "references", "notes.md"), "notes here\n");
  fs.writeFileSync(path.join(d, "Zebra.md"), "Zed file\n");
  fs.writeFileSync(path.join(d, "alpha.md"), "lower\n");
  up.commit("probe");
  manifest({ up: source(up, { skills: ["probe"] }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const known = "c78e3210c4a86e23088a3f88abf61e3fd7f4dabcd0d58daa5166799022e2eef3";
  assert.equal(json(lib.sourcesLockFile).sources.up.skills.probe.hash, known);
  assert.equal(json(lib.lockFile).skills.probe.computedHash, known);
  assert.equal(recipeHash(d), known, "the recipe in this test agrees with npx skills");
});

test("the manifest and the lock validate against the shipped schemas; an invalid manifest stops refresh naming the path of each problem", async () => {
  const { shippedSchema, validate } = await import("../src/schema.js");
  manifest({ up: source(up, { skills: { a: "a", b: "renamed-b" }, pins: { a: up.head() } }) });
  const full = { ...json(lib.configFile), library: { name: "skills", owner: "oneezy" }, plugins: { up: { displayName: "Up", source: "up" }, oneezy: { displayName: "Oneezy", description: "mine", group: "oneezy" } } };
  fs.writeFileSync(lib.configFile, JSON.stringify(full, null, 2));
  assert.deepEqual(validate(shippedSchema("skills-sync"), json(lib.configFile)), []);
  assert.equal(cli("refresh", "--quiet").status, 0);
  assert.deepEqual(validate(shippedSchema("skills-sources-lock"), json(lib.sourcesLockFile)), []);

  const bad = json(lib.configFile);
  bad.sources.up.policy = "sometimes";
  bad.sources.up.extra = true;
  bad.plugins.up.group = "oneezy";
  fs.writeFileSync(lib.configFile, JSON.stringify(bad));
  const r = cli("refresh", "--quiet");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\$\.sources\.up\.policy: must be one of "follow", "pin"/);
  assert.match(r.stderr, /\$\.sources\.up\.extra: not allowed/);
  assert.match(r.stderr, /\$\.plugins\.up: must match exactly one of 2 shapes/);
  assert.equal(json(lib.sourcesLockFile).sources.up.commit, up.head(), "the lock was left alone");
});

test("a selected skill missing upstream is reported once, remembered in skills-sync.local.json, and skipped until --retry; a deselected skill loses its working-set copy and snapshot on the next refresh", () => {
  manifest({ up: source(up, { skills: ["a", "b", "zzz"] }) });
  const first = cli("refresh");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /gone upstream: up:zzz/);
  assert.deepEqual(json(lib.localFile).unavailable, ["zzz"]);
  assert.deepEqual(Object.keys(json(lib.sourcesLockFile).sources.up.skills), ["a", "b"]);

  const second = cli("refresh");
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /gone upstream: up:zzz/, "not reported again");
  assert.match(second.stderr, /1 selected skill is gone upstream \(zzz\); --retry/);

  up.skill("zzz", "back");
  up.commit("zzz returns");
  cli("refresh", "--quiet");
  assert.ok(!("zzz" in json(lib.sourcesLockFile).sources.up.skills), "remembered as gone: not looked for without --retry");
  const retry = cli("refresh", "--retry", "--quiet");
  assert.equal(retry.status, 0, retry.stderr);
  assert.ok("zzz" in json(lib.sourcesLockFile).sources.up.skills);
  assert.ok(fs.existsSync(path.join(lib.agents, "zzz", "SKILL.md")));
  assert.equal(json(lib.localFile).unavailable, undefined);

  manifest({ up: source(up, { skills: ["a", "zzz"] }) });
  const r = cli("refresh", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(changes(r).some((a) => a.kind === "delete" && a.path.endsWith(path.join(".agents", "skills", "b"))), "working-set copy of b deleted");
  assert.ok(!lexists(path.join(lib.agents, "b")));
  assert.ok(!lexists(path.join(lib.upstream, "up", "skills", "b")), "snapshot of b deleted");
  assert.ok(fs.existsSync(path.join(lib.agents, "a", "SKILL.md")));
  assert.ok(isLink(path.join(lib.agents, "own-one")) || !lexists(path.join(lib.agents, "own-one")), "own skills are not the business of refresh");
  assert.deepEqual(Object.keys(json(lib.lockFile).skills), ["a", "zzz"]);
});

/** Temp clones this tool makes are named skills-sync-src-*; none may outlive the command. */
function stagedClones(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("skills-sync-src-"));
}

test("add <path to the upstream> writes the manifest entry (default branch, follow, all skills) and snapshots; --id, --root, --skills and --as are honoured; nothing lands outside the library and the temp clone is gone", () => {
  const clonesBefore = stagedClones();
  const all = cli("add", up.dir, "--quiet");
  assert.equal(all.status, 0, all.stderr);
  const m = json(lib.configFile);
  assert.deepEqual(m, { version: 1, sources: { up: { repo: up.dir, ref: "main", policy: "follow", root: "skills", skills: ["a", "b", "c"], attribution: ["LICENSE"] } }, plugins: {} });
  for (const n of ["a", "b", "c"]) assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", n, "SKILL.md")), `${n} snapshotted`);
  assert.deepEqual(Object.keys(json(lib.sourcesLockFile).sources.up.skills), ["a", "b", "c"]);

  const again = cli("add", up.dir, "--quiet");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /up is already declared/);

  const picked = cli("add", up.dir, "--id", "picked", "--root", "skills", "--skills", "a,b", "--as", "b=x-b", "--quiet");
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(json(lib.configFile).sources.picked, { repo: up.dir, ref: "main", policy: "follow", root: "skills", skills: { a: "a", b: "x-b" }, attribution: ["LICENSE"] });
  assert.ok(fs.existsSync(path.join(lib.upstream, "picked", "skills", "b", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(lib.upstream, "picked", "skills", "c")));
  assert.ok(fs.readFileSync(path.join(lib.agents, "x-b", "SKILL.md"), "utf8").startsWith("---\nname: x-b\n"));

  const unknown = cli("add", up.dir, "--id", "nope", "--skills", "a,zzz", "--quiet");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /zzz/);
  assert.ok(!("nope" in json(lib.configFile).sources), "nothing written for a failed add");

  assert.deepEqual(fs.readdirSync(homeDir), [], "add writes nothing into the home folder or any harness");
  assert.deepEqual(stagedClones(), clonesBefore, "temp clones deleted");
});

test("sync on a manifest library restores from the lock with a frozen refresh (the commit in the lock, not the tip), then links; a second sync changes nothing", async () => {
  const { harnessTable } = await import("../src/harnesses.js");
  const table = harnessTable(homeDir, {});
  for (const h of table) if (h.id === "claude-code" || h.id === "codex") fs.mkdirSync(h.configDir, { recursive: true });
  manifest({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  up.skill("a", "a, newer than the lock");
  up.commit("later");
  // what a fresh clone of the library has: the manifest and both locks, no generated folders
  fs.rmSync(lib.upstream, { recursive: true });
  fs.rmSync(lib.agents, { recursive: true });
  fs.rmSync(lib.localFile, { force: true });

  const sync = () => cli("--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl", "--agents", "claude-code,codex");
  const first = sync();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(!fs.readFileSync(path.join(lib.agents, "a", "SKILL.md"), "utf8").includes("newer"), "restored at the commit in the lock");
  assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", "a", "SKILL.md")));
  const claude = table.find((h) => h.id === "claude-code")!;
  for (const n of ["a", "b", "own-one"]) assert.ok(isLink(path.join(claude.userSkills, n)), `${n} linked into the user folder`);
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "a")), "a in the Claude layer");
  assert.deepEqual(changes(sync()), [], "second sync changes nothing");
});
