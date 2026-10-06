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
import { after, before, beforeEach, test } from "node:test";

let base: string;
let root: string;
let homeDir: string;
let tmpDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
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
  date(commit = "HEAD"): string {
    return this.git("log", "-1", "--format=%cI", commit);
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
  fs.writeFileSync(path.join(root, "skills-sync.json"), JSON.stringify({ version: 1, sources, plugins: {} }, null, 2) + "\n");
}

function source(u: Upstream, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: u.dir, ref: "main", root: "skills", skills: ["a", "b"], ...extra };
}

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-lock-"));
});
after(() => {
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
