// Dry-run fixtures for the library's automation tests (run.test.mjs, land.test.mjs): a bare repository on disk standing
// in for GitHub, a clone of it, bash found the way scripts/run-sh.ps1 in oneezy/tools finds it, and a fake `gh` that
// records what it was asked instead of calling GitHub. Nothing here reaches the network or a real repository.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every temp folder made here, removed when the test process exits. */
const made = [];
process.on("exit", () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=dev"];

/** bash: plain bash off Windows; on Windows Git for Windows' bash beside git (System32\bash.exe would start WSL); null when none. */
export function findBash() {
  if (process.platform !== "win32") return spawnSync("bash", ["--version"]).status === 0 ? "bash" : null;
  const where = spawnSync("where", ["git"], { encoding: "utf8" });
  const git = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : "";
  if (!git) return null;
  const root = path.dirname(path.dirname(git));
  for (const c of [path.join(root, "usr", "bin", "bash.exe"), path.join(path.dirname(root), "usr", "bin", "bash.exe")])
    if (fs.existsSync(c)) return c;
  return null;
}

export const git = (dir, ...args) => execFileSync("git", [...GIT, "-C", dir, ...args], { encoding: "utf8" }).trim();

/** A temp folder holding origin.git (bare, branches dev and main at one commit of `files`) and library, a clone of dev. */
export function remote(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "library-dry-run-"));
  made.push(base);
  const seed = path.join(base, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "dev");
  write(seed, files);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "branch", "main");
  const origin = path.join(base, "origin.git");
  execFileSync("git", [...GIT, "clone", "-q", "--bare", seed, origin]);
  const library = path.join(base, "library");
  execFileSync("git", [...GIT, "clone", "-q", "-b", "dev", origin, library]);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"]]) git(library, "config", k, v);
  return { base, origin, library, ref: (name) => refOf(origin, name) };
}

/** The commit a branch of a bare repository points at; null when it has no such branch. */
export function refOf(origin, name) {
  const r = spawnSync("git", ["-C", origin, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function branches(origin) {
  return git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
}

export function tags(origin) {
  return git(origin, "tag", "--list").split("\n").filter(Boolean);
}

/** Write rel -> text under dir. */
export function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

/** A bin folder with a fake `gh` that appends its arguments, one call per line, to log; it prints nothing and succeeds. */
export function fakeGh(base) {
  const bin = path.join(base, "bin");
  const log = path.join(base, "gh.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log.split(path.sep).join("/")}"\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}
