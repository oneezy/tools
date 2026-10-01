// Third-party sources: skills-sync.json declares them, refresh snapshots them under upstream/, rebuilds the working set
// and writes skills-lock.json, the one record of what is installed. Upstream is a temp git repository. Latest is the
// default: every unpinned skill moves to the tip of its source's ref; a pin is the exception.
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

function config(sources: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(lib.configFile, JSON.stringify({ version: 1, sources, plugins: {}, ...extra }, null, 2) + "\n");
}

function source(u: Upstream, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: u.dir, ref: "main", root: "skills", skills: ["a", "b"], attribution: ["LICENSE"], ...extra };
}

/** The actions of a --json run that touch a file: neither a skip nor a reported conflict. */
function changes(r: { stdout: string }): Array<{ kind: string; path: string }> {
  return (JSON.parse(r.stdout).actions as Array<{ kind: string; path: string }>).filter((a) => a.kind !== "skip" && a.kind !== "conflict");
}

const body = (name: string) => fs.readFileSync(path.join(lib.agents, name, "SKILL.md"), "utf8");

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

test("refresh snapshots the selected skills and the attribution file, writes .snapshot.json and skills-lock.json with the recipe hashes and the commit, copies the working set; a second refresh is a no-op; there is no skills-sources-lock.json", () => {
  config({ up: source(up) });
  const r = cli("refresh", "--json");
  assert.equal(r.status, 0, r.stderr);
  const snap = path.join(lib.upstream, "up");
  for (const n of ["a", "b"]) assert.ok(fs.existsSync(path.join(snap, "skills", n, "SKILL.md")), `${n} snapshotted`);
  assert.ok(!fs.existsSync(path.join(snap, "skills", "c")), "c not selected, not snapshotted");
  assert.equal(fs.readFileSync(path.join(snap, "LICENSE"), "utf8"), "MIT\n");
  const meta = json(path.join(snap, ".snapshot.json"));
  assert.equal(meta.source, "up");
  assert.equal(meta.commit, up.head());
  assert.match(meta.date, /^\d{4}-\d{2}-\d{2}T/);

  const lock = json(lib.lockFile);
  assert.equal(lock.version, 1);
  assert.deepEqual(Object.keys(lock.skills), ["a", "b"]);
  for (const n of ["a", "b"]) {
    assert.equal(lock.skills[n].skillPath, `skills/${n}/SKILL.md`);
    assert.equal(lock.skills[n].commit, up.head());
    assert.equal(lock.skills[n].computedHash, recipeHash(path.join(up.dir, "skills", n)), `${n} hash is the recipe's`);
    assert.equal(lock.skills[n].computedHash, recipeHash(path.join(snap, "skills", n)), `${n} snapshot matches`);
  }
  assert.ok(!fs.existsSync(path.join(lib.root, "skills-sources-lock.json")), "one lock only");
  assert.deepEqual(fs.readdirSync(lib.root).sort(), [".agents", "skills", "skills-lock.json", "skills-sync.json", "upstream"], "refresh writes nothing else into the library");

  for (const n of ["a", "b"]) {
    const w = path.join(lib.agents, n);
    assert.ok(fs.existsSync(path.join(w, "SKILL.md")), `${n} in the working set`);
    assert.ok(!isLink(w), "a copy, not a link");
  }
  assert.ok(!lexists(path.join(lib.agents, "c")));

  const before = [lib.lockFile, path.join(snap, ".snapshot.json")].map((f) => fs.readFileSync(f, "utf8"));
  const again = cli("refresh", "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(changes(again), [], "second refresh changes nothing");
  assert.deepEqual([lib.lockFile, path.join(snap, ".snapshot.json")].map((f) => fs.readFileSync(f, "utf8")), before);
});

test("latest by default: a new upstream commit moves unpinned skills on refresh, not on refresh --frozen; a per-skill pin holds that skill at its commit while its sibling moves; editing the pin moves it", () => {
  const first = up.head();
  config({ up: source(up), held: source(up, { skills: { a: "held-a", b: "held-b" }, pins: { a: first } }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  up.skill("a", "a, second edition");
  up.skill("b", "b, second edition");
  const second = up.commit("two");

  const frozen = cli("refresh", "--frozen", "--json");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.deepEqual(changes(frozen), [], "frozen moves nothing");
  assert.equal(json(lib.lockFile).skills.a.commit, first);
  assert.ok(!body("a").includes("second edition"));

  const moved = cli("refresh", "--json");
  assert.equal(moved.status, 0, moved.stderr);
  const lock = json(lib.lockFile);
  assert.equal(lock.skills.a.commit, second, "unpinned a moved");
  assert.equal(lock.skills.b.commit, second, "unpinned b moved");
  assert.equal(lock.skills["held-a"].commit, first, "the pinned skill is held at its pin");
  assert.equal(lock.skills["held-b"].commit, second, "its sibling in the same source moved");
  assert.equal(lock.skills["held-a"].computedHash, recipeHash(path.join(lib.upstream, "held", "skills", "a")));
  assert.ok(body("a").includes("second edition"));
  assert.ok(!body("held-a").includes("second edition"), "the working-set copy of the pinned skill is the first edition");
  assert.ok(body("held-b").includes("second edition"));
  assert.ok(fs.readFileSync(path.join(lib.upstream, "up", "skills", "a", "SKILL.md"), "utf8").includes("second edition"));
  assert.ok(!fs.readFileSync(path.join(lib.upstream, "held", "skills", "a", "SKILL.md"), "utf8").includes("second edition"));
  assert.deepEqual(changes(cli("refresh", "--json")), [], "settled");

  // the pin is edited to the new commit: the held skill moves, and nothing else changes
  config({ up: source(up), held: source(up, { skills: { a: "held-a", b: "held-b" }, pins: { a: second } }) });
  const edited = cli("refresh", "--json");
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(json(lib.lockFile).skills["held-a"].commit, second);
  assert.ok(body("held-a").includes("second edition"));
  assert.ok(changes(edited).every((a) => /held|skills-lock\.json$/.test(a.path)), `only the held source changed: ${JSON.stringify(changes(edited))}`);
});

test("sync with a config refreshes to latest when the pull is due (--pull forces), and runs frozen with --no-pull; without a config it behaves as 0.2.0", async () => {
  const { harnessTable } = await import("../src/harnesses.js");
  const table = harnessTable(homeDir, {});
  for (const h of table) if (h.id === "claude-code" || h.id === "codex") fs.mkdirSync(h.configDir, { recursive: true });
  const claude = table.find((h) => h.id === "claude-code")!;
  config({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const first = up.head();
  up.skill("a", "a, newer than the lock");
  const second = up.commit("later");
  // what a fresh clone of the library has: the config and the lock, no generated folders, no answers
  fs.rmSync(lib.upstream, { recursive: true });
  fs.rmSync(lib.agents, { recursive: true });
  fs.rmSync(lib.localFile, { force: true });

  const sync = (...extra: string[]) => cli("--quiet", "--json", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", ...extra);
  const frozen = sync("--no-pull");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.ok(!body("a").includes("newer"), "--no-pull: restored at the commit in the lock, not the tip");
  assert.equal(json(lib.lockFile).skills.a.commit, first, "the lock was not rewritten");
  assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", "a", "SKILL.md")));
  for (const n of ["a", "b", "own-one"]) assert.ok(isLink(path.join(claude.userSkills, n)), `${n} linked into the user folder`);
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "a")), "a in the Claude layer");
  assert.deepEqual(changes(sync("--no-pull")), [], "a second frozen sync changes nothing");

  const latest = sync("--pull");
  assert.equal(latest.status, 0, latest.stderr);
  assert.ok(body("a").includes("newer"), "--pull: moved to the tip");
  assert.equal(json(lib.lockFile).skills.a.commit, second);
  assert.deepEqual(changes(sync("--no-pull")), [], "settled");

  // a library with only skills-lock.json: no config, no refresh, no snapshot; the lock is restored as 0.2.0 did and left alone
  const legacy = new Library(path.join(base, "dev", "legacy"));
  fs.mkdirSync(path.join(legacy.own, "mine"), { recursive: true });
  fs.writeFileSync(path.join(legacy.own, "mine", "SKILL.md"), "---\nname: mine\ndescription: mine\n---\nmine\n");
  const lockText = JSON.stringify({ version: 1, skills: { c: { source: up.dir, sourceUrl: up.dir, sourceType: "git", skillPath: "skills/c/SKILL.md", computedHash: "x" } } }, null, 2) + "\n";
  fs.writeFileSync(legacy.lockFile, lockText);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  const r = spawnSync(process.execPath, [CLI, "--quiet", "--json", "--pull", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", "--repo", legacy.root], { encoding: "utf8", cwd: legacy.root, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(legacy.agents, "c", "SKILL.md")), "restored from the lock");
  assert.ok(!isLink(path.join(legacy.agents, "c")));
  assert.ok(!fs.existsSync(legacy.upstream), "no snapshot without a config");
  assert.equal(fs.readFileSync(legacy.lockFile, "utf8"), lockText, "the lock is left exactly as it was");
  assert.ok(!fs.existsSync(legacy.configFile), "no config was written");
});

test("a rename (tdd -> pstack-tdd) yields .agents/skills/pstack-tdd with name: pstack-tdd, an untouched snapshot, and a lock entry under the new name recording the upstream path", () => {
  up.skill("tdd", "red, green");
  up.commit("tdd");
  config({ up: source(up, { skills: { tdd: "pstack-tdd", a: "a" } }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  assert.equal(body("pstack-tdd"), "---\nname: pstack-tdd\ndescription: tdd skill\n---\nred, green\n");
  assert.ok(!lexists(path.join(lib.agents, "tdd")));
  const snapshot = fs.readFileSync(path.join(lib.upstream, "up", "skills", "tdd", "SKILL.md"), "utf8");
  assert.equal(snapshot, fs.readFileSync(path.join(up.dir, "skills", "tdd", "SKILL.md"), "utf8"), "the snapshot holds the bytes of upstream");
  const lock = json(lib.lockFile);
  assert.equal(lock.skills["pstack-tdd"].skillPath, "skills/tdd/SKILL.md");
  assert.equal(lock.skills["pstack-tdd"].computedHash, recipeHash(path.join(up.dir, "skills", "tdd")), "the hash is the upstream one, not the renamed copy");
  assert.ok(!("tdd" in lock.skills));
  assert.deepEqual(changes(cli("refresh", "--json")), [], "settled");
  // frozen restores the renamed copy from the lock's path under the new name
  fs.rmSync(lib.agents, { recursive: true });
  assert.equal(cli("refresh", "--frozen", "--quiet").status, 0);
  assert.equal(body("pstack-tdd"), "---\nname: pstack-tdd\ndescription: tdd skill\n---\nred, green\n");
});

test("a lock entry for a GitHub source carries exactly the npx skills fields (source, ref for a branch or tag, sourceType github, skillPath, computedHash) plus commit, in that order", async () => {
  const { lockEntry, lockText } = await import("../src/sources.js");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const hash = "c78e3210c4a86e23088a3f88abf61e3fd7f4dabcd0d58daa5166799022e2eef3";
  const mp = { repo: "mattpocock/skills", ref: "main", root: "skills", skills: ["tdd"] };
  const held = { repo: "https://github.com/cursor/plugins.git", ref: sha, skills: { teach: "pstack-teach" } };
  const tdd = lockEntry(mp, "skills/engineering/tdd", hash, sha);
  assert.deepEqual(tdd, { source: "mattpocock/skills", ref: "main", sourceType: "github", skillPath: "skills/engineering/tdd/SKILL.md", computedHash: hash, commit: sha });
  assert.deepEqual(Object.keys(tdd), ["source", "ref", "sourceType", "skillPath", "computedHash", "commit"], "the npx skills keys in its order, commit last");
  const teach = lockEntry(held, "pstack/skills/teach", hash, sha);
  assert.deepEqual(teach, { source: "cursor/plugins", sourceType: "github", skillPath: "pstack/skills/teach/SKILL.md", computedHash: hash, commit: sha }, "a ref that is a commit is not written as ref");
  assert.equal(lockText({ tdd, "pstack-teach": teach }), JSON.stringify({ version: 1, skills: { "pstack-teach": teach, tdd } }, null, 2) + "\n", "sorted names, two spaces, trailing newline: what npx skills writes");
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
  config({ up: source(up, { skills: ["probe"] }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const known = "c78e3210c4a86e23088a3f88abf61e3fd7f4dabcd0d58daa5166799022e2eef3";
  assert.equal(json(lib.lockFile).skills.probe.computedHash, known);
  assert.equal(recipeHash(d), known, "the recipe in this test agrees with npx skills");
});

test("the config and the local file validate against the shipped schemas; the skills and plugins switches default to true; an invalid config stops refresh naming the path of each problem", async () => {
  const { shippedSchema, validate } = await import("../src/schema.js");
  const { readConfig } = await import("../src/sources.js");
  config({ up: source(up, { skills: { a: "a", b: "renamed-b" }, pins: { a: up.head() } }) }, { library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" }, plugins: { up: { displayName: "Up", source: "up" }, oneezy: { displayName: "Oneezy", description: "mine", group: "oneezy" } } });
  assert.deepEqual(validate(shippedSchema("skills-sync"), json(lib.configFile)), []);
  assert.deepEqual(readConfig(lib.configFile).generate, { skills: true, plugins: true }, "both switches default to true");
  assert.equal(cli("refresh", "--quiet").status, 0);
  const sync = cli("--quiet", "--no-pull", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", "--no-global");
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(validate(shippedSchema("skills-sync.local"), json(lib.localFile)), [], "the sync wrote a valid local file");

  const switched = { ...json(lib.configFile), generate: { skills: false, plugins: true } };
  fs.writeFileSync(lib.configFile, JSON.stringify(switched));
  assert.deepEqual(validate(shippedSchema("skills-sync"), switched), []);
  assert.deepEqual(readConfig(lib.configFile).generate, { skills: false, plugins: true });
  assert.equal(cli("refresh", "--quiet").status, 0, "the switches are parsed and validated only");

  const bad = json(lib.configFile);
  bad.sources.up.policy = "follow";
  bad.sources.up.extra = true;
  bad.plugins.up.group = "oneezy";
  bad.generate.skills = "yes";
  fs.writeFileSync(lib.configFile, JSON.stringify(bad));
  const r = cli("refresh", "--quiet");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\$\.sources\.up\.policy: not allowed/);
  assert.match(r.stderr, /\$\.sources\.up\.extra: not allowed/);
  assert.match(r.stderr, /\$\.plugins\.up: must match exactly one of 2 shapes/);
  assert.match(r.stderr, /\$\.generate\.skills: must be boolean/);
  assert.equal(json(lib.lockFile).skills.a.commit, up.head(), "the lock was left alone");
});

test("a selected skill missing upstream is reported once, remembered in skills-sync.local.json, and skipped until --retry; a deselected skill loses its working-set copy and snapshot on the next refresh", () => {
  config({ up: source(up, { skills: ["a", "b", "zzz"] }) });
  const first = cli("refresh");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /gone upstream: up:zzz/);
  assert.deepEqual(json(lib.localFile).unavailable, ["zzz"]);
  assert.deepEqual(Object.keys(json(lib.lockFile).skills), ["a", "b"]);

  const second = cli("refresh");
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /gone upstream: up:zzz/, "not reported again");
  assert.match(second.stderr, /1 selected skill is gone upstream \(zzz\); --retry/);

  up.skill("zzz", "back");
  up.commit("zzz returns");
  cli("refresh", "--quiet");
  assert.ok(!("zzz" in json(lib.lockFile).skills), "remembered as gone: not looked for without --retry");
  const retry = cli("refresh", "--retry", "--quiet");
  assert.equal(retry.status, 0, retry.stderr);
  assert.ok("zzz" in json(lib.lockFile).skills);
  assert.ok(fs.existsSync(path.join(lib.agents, "zzz", "SKILL.md")));
  assert.equal(json(lib.localFile).unavailable, undefined);

  config({ up: source(up, { skills: ["a", "zzz"] }) });
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

test("add <path to the upstream> writes the config entry (default branch, all skills, no policy) and snapshots; --id, --root, --skills and --as are honoured; nothing lands outside the library and the temp clone is gone", () => {
  const clonesBefore = stagedClones();
  const all = cli("add", up.dir, "--quiet");
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(json(lib.configFile), { version: 1, sources: { up: { repo: up.dir, ref: "main", root: "skills", skills: ["a", "b", "c"], attribution: ["LICENSE"] } }, plugins: {} });
  for (const n of ["a", "b", "c"]) assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", n, "SKILL.md")), `${n} snapshotted`);
  assert.deepEqual(Object.keys(json(lib.lockFile).skills), ["a", "b", "c"]);
  assert.equal(json(lib.lockFile).skills.a.commit, up.head());

  const again = cli("add", up.dir, "--quiet");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /up is already declared/);

  const picked = cli("add", up.dir, "--id", "picked", "--root", "skills", "--skills", "a,b", "--as", "b=x-b", "--quiet");
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(json(lib.configFile).sources.picked, { repo: up.dir, ref: "main", root: "skills", skills: { a: "a", b: "x-b" }, attribution: ["LICENSE"] });
  assert.ok(fs.existsSync(path.join(lib.upstream, "picked", "skills", "b", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(lib.upstream, "picked", "skills", "c")));
  assert.ok(body("x-b").startsWith("---\nname: x-b\n"));

  const unknown = cli("add", up.dir, "--id", "nope", "--skills", "a,zzz", "--quiet");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /zzz/);
  assert.ok(!("nope" in json(lib.configFile).sources), "nothing written for a failed add");

  assert.deepEqual(fs.readdirSync(homeDir), [], "add writes nothing into the home folder or any harness");
  assert.deepEqual(stagedClones(), clonesBefore, "temp clones deleted");
});
