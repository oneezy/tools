// The lock, skills-sync.lock.json (version 2): per source as in skills-sync.json, its upstream version (plain semver
// from a release tag, else from the nearest plugin or package manifest, else null), commit, date and skills. Output
// shows the version and how far past it the commit is; the lock stores only the version and the commit. A version 1
// skills-lock.json is migrated once by the commands that write the lock. Upstream is a temp git repository.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";

let base: string;
let root: string;
let homeDir: string;
let tmpDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const LOCK = "skills-sync.lock.json";
const OLD_LOCK = "skills-lock.json";

/** Run the CLI against the temp library, home and temp folder redirected, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
}

/** A temp git repository standing in for a source. */
class Upstream {
  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  skill(name: string, body = "do the thing", at = "skills"): void {
    this.file(`${at}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }
  file(rel: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(this.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, rel), text);
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", msg);
    return this.head();
  }
  head(): string {
    return this.git("rev-parse", "HEAD");
  }
  /** The commit's date as the lock spells it: UTC as Z, whichever git printed it. */
  date(commit = "HEAD"): string {
    return this.git("log", "-1", "--format=%cI", commit).replace(/[+-]00:?00$/, "Z");
  }
  tag(name: string, annotated = false): void {
    if (annotated) this.git("tag", "-a", name, "-m", name);
    else this.git("tag", name);
  }
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

function json(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function config(sources: Record<string, unknown>): void {
  fs.writeFileSync(path.join(root, "skills-sync.json"), JSON.stringify({ version: 1, generate: { skills: true, plugins: false }, sources, plugins: {} }, null, 2) + "\n");
}

function source(u: Upstream, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: u.dir, ref: "main", root: "skills", skills: ["a", "b"], ...extra };
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-lock-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  fs.mkdirSync(path.join(root, "skills", "oneezy", "own-one"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "oneezy", "own-one", "SKILL.md"), "---\nname: own-one\ndescription: mine\n---\nmine\n");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  tmpDir = path.join(base, "tmp");
  fs.mkdirSync(tmpDir);
  up = new Upstream(path.join(base, "up"));
  up.skill("a");
  up.skill("b");
  up.skill("c");
  up.commit("one");
});

test("refresh writes skills-sync.lock.json, version 2, grouped per source: repo, ref, version, commit, date and the skills with their upstream path and recipe hash, keys in that order; no skills-lock.json; a source with no tag and no manifest has version null and shows its date and short commit", () => {
  config({ up: source(up) });
  const r = cli("refresh");
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(path.join(root, LOCK), "utf8");
  const expected = {
    version: 2,
    sources: {
      up: {
        repo: up.dir,
        ref: "main",
        version: null,
        commit: up.head(),
        date: up.date(),
        skills: {
          a: { path: "skills/a", hash: recipeHash(path.join(up.dir, "skills", "a")) },
          b: { path: "skills/b", hash: recipeHash(path.join(up.dir, "skills", "b")) },
        },
      },
    },
  };
  assert.equal(text, JSON.stringify(expected, null, 2) + "\n", "exact shape, key order, two spaces, trailing newline");
  assert.ok(!fs.existsSync(path.join(root, OLD_LOCK)), "no npx skills lock is written");
  assert.match(r.stderr, new RegExp(`^up: ${up.date().slice(0, 10)} ${up.head().slice(0, 7)}(, moved)?$`, "m"));
});

test("the version is the nearest release tag at or before the commit, as plain semver: v1.2.0 and skills@1.3.0 (annotated) give 1.2.0 and 1.3.0; a pre-release tag is ignored while a stable one is reachable; commits past the tag show as +N commits in output and ahead in --json, while the lock stores only version and commit; a source with only pre-release tags takes the nearest", () => {
  up.tag("v1.2.0");
  up.skill("a", "two");
  up.commit("two");
  up.tag("skills@1.3.0", true);
  up.skill("a", "three");
  up.commit("three");
  up.tag("v2.0.0-rc.1");
  up.skill("b", "four");
  const head = up.commit("four");
  const pre = new Upstream(path.join(base, "pre"));
  pre.skill("a");
  pre.commit("one");
  pre.tag("v0.1.0-alpha.1");
  pre.skill("a", "two");
  pre.commit("two");
  pre.tag("v0.1.0-alpha.2");
  config({ up: source(up), pre: source(pre, { skills: { a: "pre-a" } }) });

  const r = cli("refresh");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^up: 1\.3\.0 \(\+2 commits\)(, moved)?$/m);
  assert.match(r.stderr, /^pre: 0\.1\.0-alpha\.2(, moved)?$/m);
  const lock = json(LOCK);
  assert.equal(lock.sources.up.version, "1.3.0");
  assert.equal(lock.sources.up.commit, head);
  assert.equal(lock.sources.pre.version, "0.1.0-alpha.2");
  assert.ok(!fs.readFileSync(path.join(root, LOCK), "utf8").includes("+2"), "the lock never stores +N");

  const j = cli("refresh", "--json");
  assert.equal(j.status, 0, j.stderr);
  const sources = JSON.parse(j.stdout).sources;
  assert.equal(sources.up.version, "1.3.0");
  assert.equal(sources.up.ahead, 2, "known without a clone on a refresh that moved nothing");
  assert.equal(sources.pre.ahead, 0);

  up.tag("v1.3.1");
  up.skill("c", "five");
  up.commit("five");
  up.tag("v1.3.2");
  const moved = cli("refresh");
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stderr, /^up: 1\.3\.2, moved$/m, "exactly on a tag: no +N");
  assert.equal(json(LOCK).sources.up.version, "1.3.2");
});

test("a source without tags takes the version of the nearest plugin or package manifest at or above its root (pstack/.cursor-plugin/plugin.json over the repo's package.json), counting commits since the one that set that version, edits to the manifest that keep it included", () => {
  const ps = new Upstream(path.join(base, "plugins"));
  const manifest = (version: string, description = "pstack") => ps.file("pstack/.cursor-plugin/plugin.json", JSON.stringify({ name: "pstack", description, version }, null, 2) + "\n");
  ps.skill("a", "one", "pstack/skills");
  ps.skill("b", "one", "pstack/skills");
  ps.file("package.json", JSON.stringify({ name: "plugins", version: "9.9.9" }) + "\n");
  manifest("0.15.8");
  ps.commit("one");
  manifest("0.15.9");
  ps.commit("release 0.15.9");
  ps.skill("a", "two", "pstack/skills");
  ps.commit("a two");
  manifest("0.15.9", "pstack, better described");
  ps.commit("describe");
  ps.skill("b", "two", "pstack/skills");
  ps.commit("b two");
  config({ pstack: { repo: ps.dir, ref: "main", root: "pstack/skills", skills: ["a", "b"] } });

  const r = cli("refresh", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).sources.pstack.version, JSON.parse(r.stdout).sources.pstack.ahead], ["0.15.9", 3]);
  assert.equal(json(LOCK).sources.pstack.version, "0.15.9");

  manifest("v0.15.10");
  ps.commit("release 0.15.10");
  const moved = cli("refresh");
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stderr, /^pstack: 0\.15\.10, moved$/m, "a leading v in the manifest is stripped too");
  assert.equal(json(LOCK).sources.pstack.version, "0.15.10");
});

test("a version 1 skills-lock.json (what 0.4.0 wrote) is read in memory by a frozen sync, which writes no lock; check reports it as one problem; refresh migrates it once (pin and rename kept, version resolved), removes it and says so in one line; a second refresh reports nothing; an npx skills lock without commits is never touched", () => {
  const hashes = () => ({ a: recipeHash(path.join(up.dir, "skills", "a")), b: recipeHash(path.join(up.dir, "skills", "b")) });
  const zero = up.head();
  const atZero = hashes();
  up.skill("a", "one");
  up.skill("b", "one");
  const one = up.commit("one");
  up.tag("v1.0.0");
  const atOne = hashes();
  config({ up: source(up, { skills: { a: "a", b: "up-b" }, pins: { a: zero } }) });
  const entry = (dir: string, hash: string, commit: string) => ({ source: up.dir, sourceUrl: up.dir, ref: "main", sourceType: "git", skillPath: `skills/${dir}/SKILL.md`, computedHash: hash, commit });
  const v1 = JSON.stringify({ version: 1, skills: { a: entry("a", atZero.a, zero), "up-b": entry("b", atOne.b, one) } }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, OLD_LOCK), v1);

  const sync = cli("--quiet", "--json", "--no-pull", "--no-projects", "--no-wsl", "--no-global", "--agents", "claude-code");
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(fs.readFileSync(path.join(root, ".agents", "skills", "a", "SKILL.md"), "utf8").includes("do the thing"), "a at its pin, read from the version 1 lock");
  assert.ok(fs.readFileSync(path.join(root, ".agents", "skills", "up-b", "SKILL.md"), "utf8").includes("one"));
  assert.ok(!fs.existsSync(path.join(root, LOCK)), "a frozen sync writes no lock");
  assert.equal(fs.readFileSync(path.join(root, OLD_LOCK), "utf8"), v1, "and leaves the old one as it is");

  const checked = cli("check");
  assert.equal(checked.status, 1);
  assert.deepEqual(checked.stdout.split("\n").filter((l) => l && !l.startsWith("check:")), ["skills-lock.json: old lock format; refresh migrates it to skills-sync.lock.json"]);

  // the snapshot as 0.4.0 left it: no version recorded
  const metaFile = path.join(root, "upstream", "up", ".snapshot.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  delete meta.version;
  delete meta.ahead;
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");

  const r = cli("refresh");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split("\n").filter((l) => l.includes(OLD_LOCK)).map((l) => l.replace(/\s+/g, " ")), [`- delete ${path.join(root, OLD_LOCK)} (old lock format, migrated to skills-sync.lock.json)`]);
  assert.ok(!fs.existsSync(path.join(root, OLD_LOCK)), "removed");
  assert.deepEqual(json(LOCK), {
    version: 2,
    sources: { up: { repo: up.dir, ref: "main", version: "1.0.0", commit: one, date: up.date(), skills: { a: { path: "skills/a", hash: atZero.a, commit: zero }, "up-b": { path: "skills/b", hash: atOne.b } } } },
  });
  assert.equal(cli("check").status, 0, "the migrated lock is what the snapshots give");

  const again = cli("refresh", "--json");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).actions.filter((a: { kind: string }) => a.kind !== "skip"), [], "nothing to migrate the second time");

  // a config library holding npx skills' own lock (entries without a commit): not this tool's, never migrated or removed
  const npx = JSON.stringify({ version: 1, skills: { other: { source: "someone/else", sourceType: "github", skillPath: "skills/other/SKILL.md", computedHash: "x" } } }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, OLD_LOCK), npx);
  assert.equal(cli("refresh", "--quiet").status, 0);
  assert.equal(fs.readFileSync(path.join(root, OLD_LOCK), "utf8"), npx);
  assert.equal(cli("check").status, 0, "and not a problem");
});

test("skills-lock.json counts as a version 1 lock only when it parses, has an entry and every entry has a commit: an npx skills lock with no skills, or a file with merge-conflict markers, in a config library is neither a check problem nor removed by update or refresh", () => {
  config({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const empty = JSON.stringify({ version: 1, skills: {} }, null, 2) + "\n";
  const conflicted = `{\n<<<<<<< HEAD\n  "version": 1,\n=======\n  "version": 2,\n>>>>>>> other\n  "skills": {}\n}\n`;
  for (const body of [empty, conflicted]) {
    fs.writeFileSync(path.join(root, OLD_LOCK), body);
    const checked = cli("check");
    assert.equal(checked.status, 0, checked.stdout);
    for (const cmd of ["refresh", "update"]) {
      const r = cli(cmd, "--quiet");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.readFileSync(path.join(root, OLD_LOCK), "utf8"), body, `${cmd} leaves it`);
    }
  }
});

test("a lock checked out with CRLF line endings (core.autocrlf=true) that says what an update would write is not rewritten: its bytes stay, no write is reported, and check passes", () => {
  config({ up: source(up) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const file = path.join(root, LOCK);
  const crlf = fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n");
  fs.writeFileSync(file, crlf);
  for (const cmd of ["update", "refresh"]) {
    const r = cli(cmd, "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).actions.filter((a: { kind: string; path: string }) => a.kind !== "skip" && a.path === file), [], `${cmd} reports no write`);
    assert.equal(fs.readFileSync(file, "utf8"), crlf, `${cmd} leaves the bytes`);
  }
  assert.equal(cli("check").status, 0);

  up.skill("a", "two");
  const two = up.commit("two");
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.up.commit, two, "a real change is still written");
});
