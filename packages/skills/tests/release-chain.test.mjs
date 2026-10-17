// node --test tests/: the publication half of the library's automation, end to end in a temp folder and offline. The
// release job of .github/workflows/library.yml runs the tool's `build --artifacts`, then .github/scripts/release.mjs
// writes release.json, which `gh release create` uploads and every machine's sync reads back (parseRelease in
// @oneezy/skills-sync's release.ts). Here the workspace's own @oneezy/skills-sync builds a one-plugin library, the
// release script records it, and the tool's reader reads that record. Nothing is uploaded and no tag is made: the
// GitHub release itself, and the Git merge and promotion before it (land.test.mjs), are not part of this chain.
//
// Needs the workspace @oneezy/skills-sync built (dist/); `vp run test` builds it first (packages/skills/vite.config.ts).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = fileURLToPath(new URL("../node_modules/@oneezy/skills-sync/", import.meta.url));
const CLI = path.join(PACKAGE, "dist", "src", "cli.js");
const READER = path.join(PACKAGE, "dist", "src", "release.js");
const RELEASE = fileURLToPath(new URL("../.github/scripts/release.mjs", import.meta.url));
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

const config = (version) => ({
  version: 1,
  library: { version, name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" },
  sources: {},
  plugins: { oneezy: { displayName: "Oneezy", description: "Justin's own skills.", group: "oneezy" } },
});

/** A one-plugin library in a temp git repository, with a home of its own so no harness on this machine is read. */
function library() {
  assert.ok(fs.existsSync(CLI), `${CLI} is missing: build @oneezy/skills-sync first (vp run test does)`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-chain-"));
  process.on("exit", () => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "skills");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(root, "skills", "oneezy", "own-one"), { recursive: true });
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, ".gitignore"), "upstream/\nartifacts/\n.agents/skills/\n.claude/skills/\n");
  fs.writeFileSync(path.join(root, "skills", "oneezy", "own-one", "SKILL.md"), "---\nname: own-one\ndescription: own-one skill\n---\nbody\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME", "GITHUB_OUTPUT"]) delete env[k];
  const git = (...args) => execFileSync("git", [...GIT, "-C", root, ...args], { encoding: "utf8" }).trim();
  const run = (file, ...args) => {
    const r = spawnSync(process.execPath, [file, ...args], { cwd: root, encoding: "utf8", env });
    return { ...r, out: `${r.stdout}${r.stderr}` };
  };
  const tool = (...args) => {
    const r = run(CLI, ...args, "--repo", root);
    assert.equal(r.status, 0, `skills-sync ${args.join(" ")}: ${r.out}`);
  };
  git("init", "-q", "-b", "main");
  /**
   * main as the standalone library keeps it: the source change committed, then the packages built from it committed
   * (a package's NOTICE names the source commit it was built from). Nothing changed is a promotion's empty commit.
   */
  const commit = (version) => {
    fs.writeFileSync(path.join(root, "skills-sync.json"), JSON.stringify(config(version), null, 2) + "\n");
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", `library ${version}`);
    tool("refresh", "--quiet");
    tool("build", "--plugins", "--catalogs", "--quiet");
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", `build ${version}`);
    return git("rev-parse", "HEAD");
  };
  /** The release job after the checkout: `build --artifacts`, then the release record against the previous one. */
  const release = (previous) => {
    fs.rmSync(path.join(root, "artifacts"), { recursive: true, force: true });
    tool("build", "--artifacts", "--quiet");
    const output = path.join(base, "output");
    fs.writeFileSync(output, "");
    const prev = previous ? path.join(base, "previous.json") : null;
    if (prev) fs.writeFileSync(prev, previous);
    const r = spawnSync(process.execPath, [RELEASE, root, ...(prev ? ["--previous", prev] : []), "--tool-version", "0.17.0", "--repo", "oneezy/skills"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GITHUB_OUTPUT: output },
    });
    const outputs = Object.fromEntries(fs.readFileSync(output, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    const record = path.join(root, "artifacts", "release.json");
    return { status: r.status, out: `${r.stdout}${r.stderr}`, outputs, bytes: outputs.release === "true" ? fs.readFileSync(record) : null };
  };
  return { root, commit, release };
}

/** Every file of a built package, path -> sha256, read from disk independently of either script. */
function packageFiles(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out[r] = sha256(fs.readFileSync(path.join(dir, r)));
    }
  };
  walk("");
  return out;
}

test("build --artifacts, then release.mjs, then the tool's own reader: release-1 names the plugin, its version, its skill and every file's sha256 as they are on disk, and the tool that built it", async () => {
  const { parseRelease } = await import(pathToFileURL(READER).href);
  const lib = library();
  const commit = lib.commit("0.1.0");
  const r = lib.release(null);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.outputs, { release: "true", tag: "release-1", number: "1", reason: "" });
  const read = parseRelease("oneezy/skills", r.outputs.tag, "", r.bytes);
  assert.equal(read.tag, "release-1");
  assert.equal(read.number, 1);
  assert.equal(read.commit, commit);
  assert.equal(read.tool, "0.17.0");
  assert.deepEqual(Object.keys(read.plugins), ["oneezy"]);
  assert.equal(read.plugins.oneezy.version, "0.1.0");
  assert.deepEqual(read.plugins.oneezy.skills, ["own-one"]);
  assert.deepEqual(read.plugins.oneezy.files, packageFiles(path.join(lib.root, "plugins", "oneezy")));
  assert.ok(fs.existsSync(path.join(lib.root, "artifacts", "oneezy-0.1.0.zip")), "the archive the release uploads");
});

test("the next main commit: a promotion that changes no package releases nothing; changed files at the same authored version fail; a version bump is release-2 with the plugin changed", async () => {
  const { parseRelease } = await import(pathToFileURL(READER).href);
  const lib = library();
  lib.commit("0.1.0");
  const first = lib.release(null).bytes.toString("utf8");

  lib.commit("0.1.0");
  const same = lib.release(first);
  assert.equal(same.status, 0, same.out);
  assert.equal(same.outputs.release, "false");
  assert.match(same.outputs.reason, /no package changed since release-1/);

  fs.appendFileSync(path.join(lib.root, "skills", "oneezy", "own-one", "SKILL.md"), "more\n");
  lib.commit("0.1.0");
  const stale = lib.release(first);
  assert.equal(stale.status, 1, "a changed package at an unchanged authored version releases nothing");
  assert.equal(stale.outputs.release, "false");

  lib.commit("0.2.0");
  const next = lib.release(first);
  assert.equal(next.status, 0, next.out);
  assert.equal(next.outputs.tag, "release-2");
  const record = JSON.parse(next.bytes.toString("utf8"));
  assert.deepEqual(record.changes, { added: [], changed: ["oneezy"], removed: [] });
  assert.equal(parseRelease("oneezy/skills", "release-2", "", next.bytes).plugins.oneezy.version, "0.2.0");
});
