// Third-party sources: skills-sync.json declares them, refresh snapshots them under upstream/, rebuilds the working set
// and writes skills-sync.lock.json, the one record of what is installed. Upstream is a temp git repository. Latest is the
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
let tmpDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;

/**
 * Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. Its
 * temp folder is this file's own, so what it stages there can be counted while other test files run beside this one.
 */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir };
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
  tmpDir = path.join(base, "tmp");
  fs.mkdirSync(tmpDir);
  up = upstream("up");
  up.skill("a");
  up.skill("b");
  up.skill("c");
  fs.writeFileSync(path.join(up.dir, "LICENSE"), "MIT\n");
  up.commit("one");
});

test("refresh snapshots the selected skills and the attribution file, writes .snapshot.json and skills-sync.lock.json with the recipe hashes and the commit, copies the working set; a second refresh is a no-op; there is no skills-lock.json or skills-sources-lock.json", () => {
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
  assert.equal(lock.version, 2);
  assert.equal(lock.sources.up.commit, up.head());
  assert.deepEqual(Object.keys(lock.sources.up.skills), ["a", "b"]);
  for (const n of ["a", "b"]) {
    assert.equal(lock.sources.up.skills[n].path, `skills/${n}`);
    assert.equal(lock.sources.up.skills[n].commit, undefined, "no commit of its own: it is at the source's");
    assert.equal(lock.sources.up.skills[n].hash, recipeHash(path.join(up.dir, "skills", n)), `${n} hash is the recipe's`);
    assert.equal(lock.sources.up.skills[n].hash, recipeHash(path.join(snap, "skills", n)), `${n} snapshot matches`);
  }
  assert.ok(!fs.existsSync(path.join(lib.root, "skills-sources-lock.json")), "one lock only");
  assert.deepEqual(fs.readdirSync(lib.root).sort(), [".agents", "skills", "skills-sync.json", "skills-sync.lock.json", "upstream"], "refresh writes nothing else into the library");

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
  assert.equal(json(lib.lockFile).sources.up.commit, first);
  assert.ok(!body("a").includes("second edition"));

  const moved = cli("refresh", "--json");
  assert.equal(moved.status, 0, moved.stderr);
  const lock = json(lib.lockFile);
  assert.equal(lock.sources.up.commit, second, "unpinned a and b moved with their source");
  assert.equal(lock.sources.held.commit, second, "the held source is at the tip");
  assert.equal(lock.sources.held.skills["held-a"].commit, first, "the pinned skill is held at its pin, which the lock shows on the skill");
  assert.equal(lock.sources.held.skills["held-b"].commit, undefined, "its sibling in the same source moved with the source");
  assert.equal(lock.sources.held.skills["held-a"].hash, recipeHash(path.join(lib.upstream, "held", "skills", "a")));
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
  assert.equal(json(lib.lockFile).sources.held.skills["held-a"].commit, undefined, "pinned at the source's own commit: nothing to show");
  assert.ok(body("held-a").includes("second edition"));
  assert.ok(changes(edited).every((a) => /held|skills-sync\.lock\.json$/.test(a.path)), `only the held source changed: ${JSON.stringify(changes(edited))}`);
});

test("sync with a config never moves a source upstream: after an upstream commit, sync with --no-pull, --pull or a due pull installs every source at the lock's commit and never rewrites the lock; without a config it behaves as 0.2.0", async () => {
  const { harnessTable } = await import("../src/harnesses.js");
  const table = harnessTable(homeDir, {});
  for (const h of table) if (h.id === "claude-code" || h.id === "codex") fs.mkdirSync(h.configDir, { recursive: true });
  const claude = table.find((h) => h.id === "claude-code")!;
  config({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const lockText = fs.readFileSync(lib.lockFile, "utf8");
  up.skill("a", "a, newer than the lock");
  up.commit("later");
  // what a fresh clone of the library has: the config and the lock, no generated folders, no answers
  fs.rmSync(lib.upstream, { recursive: true });
  fs.rmSync(lib.agents, { recursive: true });
  fs.rmSync(lib.localFile, { force: true });

  const sync = (...extra: string[]) => cli("--quiet", "--json", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", ...extra);
  const frozen = sync("--no-pull");
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.ok(!body("a").includes("newer"), "--no-pull: restored at the commit in the lock, not the tip");
  assert.equal(fs.readFileSync(lib.lockFile, "utf8"), lockText, "the lock was not rewritten");
  assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", "a", "SKILL.md")));
  for (const n of ["a", "b", "own-one"]) assert.ok(isLink(path.join(claude.userSkills, n)), `${n} linked into the user folder`);
  assert.ok(isLink(path.join(lib.root, claude.projectSkills, "a")), "a in the Claude layer");
  assert.deepEqual(changes(sync("--no-pull")), [], "a second frozen sync changes nothing");

  // --pull forces the library pull, never an upstream move; a plain run (the pull due, this library no clone) the same
  for (const extra of [["--pull"], []]) {
    const how = extra.join(" ") || "plain";
    const r = sync(...extra);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!body("a").includes("newer"), `${how}: still at the lock's commit`);
    assert.equal(fs.readFileSync(lib.lockFile, "utf8"), lockText, `${how}: the lock was not rewritten`);
    assert.deepEqual(changes(r), [], `${how}: nothing moved`);
  }

  // a library with only skills-lock.json: no config, no refresh, no snapshot; the lock is restored as 0.2.0 did and left alone
  const legacy = new Library(path.join(base, "dev", "legacy"));
  fs.mkdirSync(path.join(legacy.own, "mine"), { recursive: true });
  fs.writeFileSync(path.join(legacy.own, "mine", "SKILL.md"), "---\nname: mine\ndescription: mine\n---\nmine\n");
  const legacyText = JSON.stringify({ version: 1, skills: { c: { source: up.dir, sourceUrl: up.dir, sourceType: "git", skillPath: "skills/c/SKILL.md", computedHash: "x" } } }, null, 2) + "\n";
  fs.writeFileSync(legacy.npxLockFile, legacyText);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  const r = spawnSync(process.execPath, [CLI, "--quiet", "--json", "--pull", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", "--repo", legacy.root], { encoding: "utf8", cwd: legacy.root, env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(legacy.agents, "c", "SKILL.md")), "restored from the lock");
  assert.ok(!isLink(path.join(legacy.agents, "c")));
  assert.ok(!fs.existsSync(legacy.upstream), "no snapshot without a config");
  assert.equal(fs.readFileSync(legacy.npxLockFile, "utf8"), legacyText, "the lock is left exactly as it was");
  assert.ok(!fs.existsSync(legacy.lockFile), "and no skills-sync.lock.json is written beside it");
  assert.ok(!fs.existsSync(legacy.configFile), "no config was written");
});

test("sync on a clone of the library installs the committed lock: an upstream commit moves nothing and leaves the tree clean; a lock moved on this machine never blocks the pull, which puts it back; a library commit that moves the lock arrives on the next due sync and is installed; own skills committed to the origin arrive; a failed pull leaves the lock as it was; any other change still blocks", async () => {
  const { harnessTable } = await import("../src/harnesses.js");
  const table = harnessTable(homeDir, {});
  for (const h of table) if (h.id === "claude-code" || h.id === "codex") fs.mkdirSync(h.configDir, { recursive: true });
  const claude = table.find((h) => h.id === "claude-code")!;
  // the library's origin, committed as oneezy/skills is: config, lock and own skills tracked, generated folders ignored
  const originLib = lib;
  const origin = new Upstream(lib.root);
  origin.git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(lib.root, ".gitignore"), ".agents/\n.claude/\n.goose/\n.hermes/\nupstream/\nskills-sync.local.json\n");
  config({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  origin.commit("library");
  const ownSkill = (name: string) => {
    fs.mkdirSync(path.join(origin.dir, "skills", "oneezy", name), { recursive: true });
    fs.writeFileSync(path.join(origin.dir, "skills", "oneezy", name, "SKILL.md"), `---\nname: ${name}\ndescription: mine\n---\nmine\n`);
    origin.commit(name);
  };
  // another machine: a clone of the origin; from here on the CLI runs against the clone
  const cloned = spawnSync("git", [...GIT, "clone", "-q", origin.dir, path.join(base, "dev", "clone")], { encoding: "utf8" });
  assert.equal(cloned.status, 0, cloned.stderr);
  lib = new Library(path.join(base, "dev", "clone"));
  const cloneLib = lib;
  const clone = new Upstream(lib.root);
  const lockName = path.basename(lib.lockFile);
  const originLock = () => fs.readFileSync(path.join(origin.dir, lockName), "utf8");
  const cloneLock = () => fs.readFileSync(lib.lockFile, "utf8");
  const sync = (...extra: string[]) => cli("--quiet", "--json", "--no-projects", "--no-wsl", "--agents", "claude-code,codex", ...extra);
  // porcelain lines kept whole: the leading space is the unstaged column, which Upstream.git would trim away
  const dirty = () => spawnSync("git", ["-C", lib.root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  const due = () => fs.rmSync(path.join(lib.root, ".git", "skills-sync-pulled"), { force: true });

  const first = sync("--pull");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(cloneLock(), originLock(), "nothing moved: the clone's lock says what the origin's says");

  up.skill("a", "a, newer than the committed lock");
  up.commit("two");
  const moved = sync("--pull");
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(cloneLock(), originLock(), "an upstream commit moves nothing: the lock is the committed one");
  assert.ok(!body("a").includes("newer"), "and a is installed at the lock's commit");
  assert.deepEqual(dirty(), [], "the sync left the tree clean");

  // a lock moved on this machine (an explicit refresh here, or an older version's sync) is no local change that blocks the pull
  assert.equal(cli("refresh", "--quiet").status, 0);
  assert.deepEqual(dirty(), [` M ${lockName}`]);
  ownSkill("own-two");
  const pulled = sync("--pull");
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(clone.head(), origin.head(), "the clone pulled despite its moved lock");
  assert.ok(fs.existsSync(path.join(lib.own, "oneezy", "own-two", "SKILL.md")), "own-two arrived");
  assert.ok(isLink(path.join(claude.userSkills, "own-two")), "and is linked into the user folder");
  assert.equal(cloneLock(), originLock(), "the pull put the lock back at the library's");
  assert.ok(!body("a").includes("newer"), "and the working set with it");
  assert.deepEqual(dirty(), []);

  // the library moves its lock (an update landed on the origin): the next plain run once the 30-minute window has passed installs it
  lib = originLib;
  assert.equal(cli("refresh", "--quiet").status, 0);
  lib = cloneLib;
  origin.commit("update up");
  ownSkill("own-three");
  due();
  const plain = sync();
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(clone.head(), origin.head(), "pulled on the plain run");
  assert.equal(cloneLock(), originLock(), "the library's new lock arrived");
  assert.ok(body("a").includes("newer"), "and is installed");
  assert.ok(isLink(path.join(claude.userSkills, "own-three")));
  assert.deepEqual(dirty(), [], "still nothing written to the lock");

  // a pull that fails leaves the lock exactly as it was, and the frozen refresh that follows reads it
  clone.git("remote", "set-url", "origin", path.join(base, "nowhere"));
  const before = cloneLock();
  due();
  const failed = sync();
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(cloneLock(), before, "the lock is as it was before the pull");
  assert.ok(body("a").includes("newer"), "and the working set with it");
  clone.git("remote", "set-url", "origin", origin.dir);

  // any other local change still blocks the pull, as before
  fs.appendFileSync(path.join(lib.own, "oneezy", "own-one", "SKILL.md"), "edited on this machine\n");
  ownSkill("own-four");
  due();
  const blocked = sync("--pull");
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.notEqual(clone.head(), origin.head(), "not pulled over a local edit");
  assert.ok(!fs.existsSync(path.join(lib.own, "oneezy", "own-four")));
  assert.deepEqual(dirty(), [" M skills/oneezy/own-one/SKILL.md"], "nothing of the user's was touched");
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
  assert.equal(lock.sources.up.skills["pstack-tdd"].path, "skills/tdd");
  assert.equal(lock.sources.up.skills["pstack-tdd"].hash, recipeHash(path.join(up.dir, "skills", "tdd")), "the hash is the upstream one, not the renamed copy");
  assert.ok(!("tdd" in lock.sources.up.skills));
  assert.deepEqual(changes(cli("refresh", "--json")), [], "settled");
  // frozen restores the renamed copy from the lock's path under the new name
  fs.rmSync(lib.agents, { recursive: true });
  assert.equal(cli("refresh", "--frozen", "--quiet").status, 0);
  assert.equal(body("pstack-tdd"), "---\nname: pstack-tdd\ndescription: tdd skill\n---\nred, green\n");
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
  assert.equal(json(lib.lockFile).sources.up.skills.probe.hash, known);
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
  assert.equal(json(lib.lockFile).sources.up.commit, up.head(), "the lock was left alone");
});

test("a selected skill missing upstream is reported once, remembered in skills-sync.local.json, and skipped until --retry; a deselected skill loses its working-set copy and snapshot on the next refresh", () => {
  config({ up: source(up, { skills: ["a", "b", "zzz"] }) });
  const first = cli("refresh");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /gone upstream: up:zzz/);
  assert.deepEqual(json(lib.localFile).unavailable, ["zzz"]);
  assert.deepEqual(Object.keys(json(lib.lockFile).sources.up.skills), ["a", "b"]);

  const second = cli("refresh");
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /gone upstream: up:zzz/, "not reported again");
  assert.match(second.stderr, /1 selected skill is gone upstream \(zzz\); --retry/);

  up.skill("zzz", "back");
  up.commit("zzz returns");
  cli("refresh", "--quiet");
  assert.ok(!("zzz" in json(lib.lockFile).sources.up.skills), "remembered as gone: not looked for without --retry");
  const retry = cli("refresh", "--retry", "--quiet");
  assert.equal(retry.status, 0, retry.stderr);
  assert.ok("zzz" in json(lib.lockFile).sources.up.skills);
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
  assert.deepEqual(Object.keys(json(lib.lockFile).sources.up.skills), ["a", "zzz"]);
});

/** Temp clones this tool makes are named skills-sync-src-*, in the temp folder the CLI was given; none may outlive the command. */
function stagedClones(): string[] {
  return fs.readdirSync(tmpDir).filter((n) => n.startsWith("skills-sync-src-"));
}

test("add <path to the upstream> writes the config entry (default branch, all skills, no policy) and the plugin entry that packages it, and snapshots; --id, --root, --skills, --as, --plugin and --no-plugin are honoured; a plugin id already declared is refused before anything is written; nothing lands outside the library and the temp clone is gone", () => {
  const all = cli("add", up.dir, "--quiet");
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(json(lib.configFile), { version: 1, sources: { up: { repo: up.dir, ref: "main", root: "skills", skills: ["a", "b", "c"], attribution: ["LICENSE"] } }, plugins: { up: { displayName: "Up", source: "up" } } });
  for (const n of ["a", "b", "c"]) assert.ok(fs.existsSync(path.join(lib.upstream, "up", "skills", n, "SKILL.md")), `${n} snapshotted`);
  assert.deepEqual(Object.keys(json(lib.lockFile).sources.up.skills), ["a", "b", "c"]);
  assert.equal(json(lib.lockFile).sources.up.commit, up.head());

  const again = cli("add", up.dir, "--quiet");
  assert.equal(again.status, 1);
  assert.match(again.stderr, /up is already declared/);

  const picked = cli("add", up.dir, "--id", "picked", "--root", "skills", "--skills", "a,b", "--as", "b=x-b", "--quiet");
  assert.equal(picked.status, 0, picked.stderr);
  assert.deepEqual(json(lib.configFile).sources.picked, { repo: up.dir, ref: "main", root: "skills", skills: { a: "a", b: "x-b" }, attribution: ["LICENSE"] });
  assert.deepEqual(json(lib.configFile).plugins.picked, { displayName: "Picked", source: "picked" }, "the plugin id defaults to the source id");
  assert.ok(fs.existsSync(path.join(lib.upstream, "picked", "skills", "b", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(lib.upstream, "picked", "skills", "c")));
  assert.ok(body("x-b").startsWith("---\nname: x-b\n"));

  const unknown = cli("add", up.dir, "--id", "nope", "--skills", "a,zzz", "--quiet");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /zzz/);
  assert.ok(!("nope" in json(lib.configFile).sources), "nothing written for a failed add");

  const named = cli("add", up.dir, "--id", "named-src", "--skills", "a", "--plugin", "my-plugin", "--quiet");
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(json(lib.configFile).plugins["my-plugin"], { displayName: "My Plugin", source: "named-src" });
  assert.ok(!("named-src" in json(lib.configFile).plugins));

  const taken = cli("add", up.dir, "--id", "taken", "--skills", "a", "--plugin", "up", "--quiet");
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /plugin up is already declared/);
  assert.ok(!("taken" in json(lib.configFile).sources), "a refused plugin id writes no source either");

  const bare = cli("add", up.dir, "--id", "bare", "--skills", "a", "--no-plugin", "--quiet");
  assert.equal(bare.status, 0, bare.stderr);
  assert.ok("bare" in json(lib.configFile).sources);
  assert.ok(!Object.values(json(lib.configFile).plugins as Record<string, { source?: string }>).some((p) => p.source === "bare"), "--no-plugin declares none");

  assert.deepEqual(fs.readdirSync(homeDir), [], "add writes nothing into the home folder or any harness");
  assert.deepEqual(stagedClones(), [], "temp clones deleted");
});
