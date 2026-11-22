// node --test .github/scripts/: the release record (release.mjs) against a library laid out in a temp folder the way
// `build --artifacts` leaves one: plugins/<id>/, artifacts/<id>-<version>.zip and artifacts/releases.json.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { compare, contentDigest, inventory, minor, plan } from "./release.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const TOOL_VERSION = "0.7.6";

/** A library holding one package per entry: id -> { version, files: rel -> text }. */
function library(packages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
  const record = { plugins: {} };
  fs.mkdirSync(path.join(root, "artifacts"));
  fs.writeFileSync(path.join(root, "skills-sync.json"), "{}\n");
  fs.writeFileSync(path.join(root, "skills-sync.lock.json"), '{"version":2}\n');
  for (const [id, p] of Object.entries(packages)) {
    for (const [rel, text] of Object.entries(p.files)) {
      fs.mkdirSync(path.dirname(path.join(root, "plugins", id, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, "plugins", id, rel), text);
    }
    const archive = `artifacts/${id}-${p.version}.zip`;
    const bytes = Buffer.from(`zip of ${id} ${p.version} ${JSON.stringify(p.files)}`);
    fs.writeFileSync(path.join(root, archive), bytes);
    record.plugins[id] = { archive, sha256: sha256(bytes), version: p.version, versionScheme: p.versionScheme ?? "authored", commit: COMMIT, files: Object.keys(p.files).map((f) => `${id}/${f}`).sort(), release: null };
  }
  fs.writeFileSync(path.join(root, "artifacts", "releases.json"), JSON.stringify(record, null, 2));
  return root;
}

const v = (n) => `0.${n}.0`;
const run = (lib, previous, commit = COMMIT) => plan({ library: lib, previous, toolVersion: TOOL_VERSION, repo: "oneezy/skills", commit, tree: TREE });

test("the first release is release-1: every plugin new, its version, archive sha256 and every file with its sha256, plus the source commit and tree, the config and lock digests and the tool's npm version", () => {
  const lib = library({ oneezy: { version: v(25), files: { "plugin.json": "{}", "skills/a/SKILL.md": "a" } }, pstack: { version: v(15), files: { "plugin.json": "{}" } } });
  const r = run(lib, null);
  assert.equal(r.release, true);
  assert.equal(r.tag, "release-1");
  const rec = r.record;
  assert.deepEqual(Object.keys(rec.plugins), ["oneezy", "pstack"]);
  assert.deepEqual(rec.source, { repo: "oneezy/skills", commit: COMMIT, tree: TREE });
  assert.deepEqual(rec.tool, { repo: "oneezy/tools", package: "@oneezy/skills-sync", version: TOOL_VERSION });
  assert.equal(rec.digests["skills-sync.json"], sha256("{}\n"));
  assert.equal(rec.digests["skills-sync.lock.json"], sha256('{"version":2}\n'));
  assert.deepEqual(rec.plugins.oneezy.files, { "plugin.json": sha256("{}"), "skills/a/SKILL.md": sha256("a") });
  assert.equal(rec.plugins.oneezy.version, v(25));
  assert.match(rec.plugins.oneezy.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(rec.changes, { added: ["oneezy", "pstack"], changed: [], removed: [] });
  assert.equal(rec.previous, null);
  assert.match(r.notes, /\| oneezy \| `0\.25\.0` \| new \|/);
});

test("the tool is named by its npm version alone: without one, or with an empty one, the record says null, and no tool commit is recorded", () => {
  const lib = library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } } });
  for (const toolVersion of [undefined, ""]) {
    const rec = plan({ library: lib, previous: null, toolVersion, repo: "oneezy/skills", commit: COMMIT, tree: TREE }).record;
    assert.equal(rec.schema, 3);
    assert.deepEqual(rec.tool, { repo: "oneezy/tools", package: "@oneezy/skills-sync", version: null });
  }
});

test("nothing is released for a replay of the same commit or for a commit that changes no package (a promotion merge)", () => {
  const lib = library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } } });
  const first = run(lib, null).record;
  const replay = run(lib, first);
  assert.equal(replay.release, false);
  assert.match(replay.reason, /already release-1/);
  const promotion = run(lib, first, "e".repeat(40));
  assert.equal(promotion.release, false);
  assert.match(promotion.reason, /no package changed since release-1/);
});

test("a changed package with a higher version is release-2, listing it as changed, the untouched one not, and a dropped plugin as removed", () => {
  const first = run(library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } }, trident: { version: v(23), files: { "plugin.json": "{}" } }, old: { version: v(3), files: { "x": "x" } } }), null).record;
  const lib = library({ oneezy: { version: v(26), files: { "plugin.json": "{ }" } }, trident: { version: v(23), files: { "plugin.json": "{}" } }, fresh: { version: v(1), files: { "y": "y" } } });
  const r = run(lib, first, "f".repeat(40));
  assert.equal(r.release, true, r.reason);
  assert.equal(r.tag, "release-2");
  assert.equal(r.record.previous, "release-1");
  assert.deepEqual(r.record.changes, { added: ["fresh"], changed: ["oneezy"], removed: ["old"] });
  assert.match(r.notes, /Removed: old\./);
});

test("a plugin may not go backwards: different files at the same version or a lower version refuse the release with a reason naming the plugin", () => {
  const first = run(library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } }, pstack: { version: v(15), files: { "plugin.json": "{}" } } }), null).record;
  const same = run(library({ oneezy: { version: v(25), files: { "plugin.json": "{ }" } }, pstack: { version: v(15), files: { "plugin.json": "{}" } } }), first, "1".repeat(40));
  assert.equal(same.release, false);
  assert.match(same.problems.join("\n"), /oneezy: files changed since release-1 but the version is still/);
  const lower = run(library({ oneezy: { version: v(18), files: { "plugin.json": "{ }" } }, pstack: { version: v(15), files: { "plugin.json": "{}" } } }), first, "2".repeat(40));
  assert.equal(lower.release, false);
  assert.match(lower.problems.join("\n"), /oneezy: version 0\.18\.0 is lower than 0\.25\.0/);
  // a version alone cannot move: plugin.json carries it, so a new version is always new files
  assert.match(compare(first, { pstack: { ...first.plugins.pstack, version: v(16) } }).problems.join("\n"), /pstack: same files as release-1 but version/);
});

test("an archive whose bytes are not the ones releases.json records, or a committed package holding other files than its archive, stops the run", () => {
  const lib = library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } } });
  fs.appendFileSync(path.join(lib, "artifacts", `oneezy-${v(25)}.zip`), "tampered");
  assert.throws(() => run(lib, null), /sha256 differs/);
  const lib2 = library({ oneezy: { version: v(25), files: { "plugin.json": "{}" } } });
  fs.writeFileSync(path.join(lib2, "plugins", "oneezy", "stray.md"), "x");
  assert.throws(() => run(lib2, null), /hold different files/);
});

test("helpers: inventory is sorted with / paths, the content digest depends on paths and bytes, minor reads the rule", () => {
  const lib = library({ p: { version: v(1), files: { "b/z.md": "z", "a.md": "a" } } });
  assert.deepEqual(Object.keys(inventory(path.join(lib, "plugins", "p"))), ["a.md", "b/z.md"]);
  assert.notEqual(contentDigest({ "a.md": "1" }), contentDigest({ "b.md": "1" }));
  assert.equal(minor("0.26.0+abcdefabcdef"), 26);
  assert.equal(minor("1.0.0"), null);
  assert.deepEqual(compare(null, {}), { problems: [], changed: [], added: [], removed: [] });
});


test("legacy wrapper versions migrate to official upstream versions, including a numerically lower upstream minor", () => {
  const previous = { release: "release-9", plugins: { pstack: { version: "0.17.0+abcdefabcdef", content: "old" } } };
  assert.deepEqual(compare(previous, { pstack: { version: "0.15.15", versionScheme: "upstream", content: "new" } }).problems, []);
});

test("upstream snapshots keep their source version across changed files and intentional downgrades; unversioned sources remain null", () => {
  const previous = { release: "release-1", plugins: { matt: { version: "1.3.1", versionScheme: "upstream", content: "old" } } };
  for (const version of ["1.3.1", "1.2.9", null]) {
    const diff = compare(previous, { matt: { version, versionScheme: "upstream", content: "new" } });
    assert.deepEqual(diff.problems, []);
    assert.deepEqual(diff.changed, ["matt"]);
  }
});

test("authored patch and major releases use semantic precedence rather than only the minor component", () => {
  const previous = { release: "release-1", plugins: { own: { version: "0.43.0+abcdefabcdef", content: "old" } } };
  for (const version of ["0.43.1", "1.0.0"]) assert.deepEqual(compare(previous, { own: { version, versionScheme: "authored", content: "new" } }).problems, []);
  for (const version of [null, "01.2.3", "0.43.1+abcdef", "0.43.1-rc.1"]) assert.match(compare(null, { own: { version, versionScheme: "authored", content: "new" } }).problems.join("\n"), /invalid authored semantic version/);
});
