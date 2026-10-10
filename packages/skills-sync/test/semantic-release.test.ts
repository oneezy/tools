import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vite-plus/test";

const script = path.resolve(import.meta.dirname, "..", "scripts", "release-version.mjs");
const run = (version: string, ...messages: string[]) =>
  spawnSync(process.execPath, [script, version, ...messages], { encoding: "utf8" });

test("emoji-first titles choose a semantic bump once for the whole release", () => {
  for (const [title, version, bump] of [
    ["🐛 fix(sync): preserve upstream versions (#135)", "0.43.1", "patch"],
    ["✨ feat(brain): add capture", "0.44.0", "minor"],
    ["💥 feat(skills)!: change invocation", "1.0.0", "major"],
    ["📝 docs(skills): explain versions", "0.43.0", "none"],
    ["♻️ refactor(sync): preserve behavior\n\nBREAKING CHANGE: changed API", "1.0.0", "major"],
  ]) {
    const result = run("0.43.0", title, "--require-emoji");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version, bump });
  }
  const release = run("1.2.9", "🐛 fix: one", "✨ feat: two", "🐛 fix: three");
  assert.deepEqual(JSON.parse(release.stdout), { version: "1.3.0", bump: "minor" });
});

test("invalid versions and titles fail without inventing a version", () => {
  for (const version of ["01.2.3", "1.2", "v1.2.3", "1.2.3+abcdef", "1.2.3-rc.1"])
    assert.equal(run(version, "🐛 fix: x").status, 1);
  assert.equal(run("1.2.3", "garbage").status, 1);
  assert.equal(run("1.2.3", "fix: x", "--require-emoji").status, 1);
  assert.deepEqual(JSON.parse(run("1.2.3").stdout), { version: "1.2.3", bump: "none" });
});
