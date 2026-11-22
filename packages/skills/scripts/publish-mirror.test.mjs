import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mirrorDeletions, mirrorPlan, publishMirror } from "./publish-mirror.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "mirror-test-"));
  git(dir, "init", "--quiet", "-b", "dev");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "test");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("the plan keeps tools-only files home and lifts mirror/ to the root", () => {
  const plan = mirrorPlan([
    "skills/oneezy/a/SKILL.md",
    "package.json",
    "vite.config.ts",
    "README.md",
    "DEVELOPMENT.md",
    ".github/workflows/land.yml",
    "mirror/README.md",
    "docs/adr/0021.md",
  ]);
  assert.deepEqual([...plan.keys()].sort(), ["README.md", "docs/adr/0021.md", "skills/oneezy/a/SKILL.md"]);
  assert.equal(plan.get("README.md"), "mirror/README.md");
});

test("deletions spare the mirror's own files and the build's output", () => {
  const plan = mirrorPlan(["skills/oneezy/a/SKILL.md"]);
  const gone = mirrorDeletions(
    [
      "skills/oneezy/a/SKILL.md",
      "skills/oneezy/old/SKILL.md",
      ".github/workflows/library.yml",
      ".legacy/x/SKILL.md",
      ".gitignore",
      "plugins/oneezy/NOTICE.md",
      "dist/hermes/oneezy/NOTICE.md",
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
    ],
    plan,
  );
  assert.deepEqual(gone, ["skills/oneezy/old/SKILL.md"]);
});

test("a run copies, deletes and commits one land/mirror branch, and a second run finds nothing", () => {
  const source = repo({
    "skills-sync.json": JSON.stringify({ library: { version: "1.2.3" } }),
    "skills/oneezy/a/SKILL.md": "new",
    "package.json": "{}",
    "mirror/README.md": "generated",
  });
  const skills = repo({
    "skills/oneezy/a/SKILL.md": "old",
    "skills/oneezy/gone/SKILL.md": "x",
    "plugins/oneezy/NOTICE.md": "built",
    ".github/workflows/land.yml": "ci",
    "README.md": "hand-written",
  });
  const sha = git(source, "rev-parse", "--short=7", "HEAD");
  const result = publishMirror({ source, skills, build: false, log: () => {} });
  assert.equal(result.branch, `land/mirror-${sha}`);
  assert.equal(readFileSync(join(skills, "skills/oneezy/a/SKILL.md"), "utf8"), "new");
  assert.equal(readFileSync(join(skills, "README.md"), "utf8"), "generated");
  assert.ok(!existsSync(join(skills, "skills/oneezy/gone/SKILL.md")));
  assert.ok(!existsSync(join(skills, "package.json")));
  assert.ok(existsSync(join(skills, "plugins/oneezy/NOTICE.md")));
  assert.ok(existsSync(join(skills, ".github/workflows/land.yml")));
  assert.match(git(skills, "log", "-1", "--format=%s"), /publish oneezy\/tools \w{7} \(library 1\.2\.3\)/);

  const again = publishMirror({ source, skills, build: false, log: () => {} });
  assert.equal(again.branch, null);
});

test("an uncommitted package is refused", () => {
  const source = repo({ "skills-sync.json": "{}" });
  writeFileSync(join(source, "skills-sync.json"), '{"x":1}');
  const skills = repo({ "a.md": "a" });
  assert.throws(() => publishMirror({ source, skills, build: false, log: () => {} }), /uncommitted/);
});
