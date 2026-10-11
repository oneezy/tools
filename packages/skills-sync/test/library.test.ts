// A library is skills/ beside a marker file, and a library command finds one from $SKILLS_REPO or by walking up from the
// current folder, never through a dot-folder. ~/.skills-sync is no longer looked at: nothing keeps a clone there any
// more, and a machine command needs no library at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vite-plus/test";
import { makeLink } from "../src/fs.js";
import { findLibrary, looksLikeLibrary } from "../src/library.js";

let base: string;
let homeDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-library-"));
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function mk(name: string, marker: string | null, withSkills = true): string {
  const d = path.join(base, name);
  fs.mkdirSync(withSkills ? path.join(d, "skills") : d, { recursive: true });
  if (marker) fs.writeFileSync(path.join(d, marker), JSON.stringify({ version: 1, sources: {} }));
  return d;
}

test("a library is skills/ beside skills-sync.json, skills-lock.json or skills-sync.lock.json; nothing else is one", () => {
  assert.ok(looksLikeLibrary(mk("config-only", "skills-sync.json")), "config, no lock");
  assert.ok(looksLikeLibrary(mk("lock-only", "skills-lock.json")), "lock, no config");
  assert.ok(looksLikeLibrary(mk("v2-lock-only", "skills-sync.lock.json")), "the skills-sync lock, no config");
  assert.ok(!looksLikeLibrary(mk("bare", null)), "skills/ alone is not a library");
  assert.ok(!looksLikeLibrary(mk("no-skills", "skills-sync.json", false)), "a config without skills/ is not a library");
  assert.ok(!looksLikeLibrary(mk("old-manifest", "skills-sources.json")), "the old manifest name is not a marker");
  assert.ok(
    !looksLikeLibrary(mk("old-sources-lock", "skills-sources-lock.json")),
    "the old sources lock is not a marker",
  );
});

test("findLibrary takes $SKILLS_REPO, else walks up past a dot-folder that looks like a library; ~/.skills-sync is never looked at", () => {
  const lib = mk(path.join("dev", "skills"), "skills-sync.json");
  // the walk-up skips a dot-folder that looks like a library and finds the real one above it
  const dot = mk(path.join("dev", "skills", ".claude"), "skills-sync.json");
  assert.equal(findLibrary(path.join(dot, "skills"), {}), lib);
  // ~/.skills-sync pointing at another library changes nothing: nothing keeps a clone there any more
  const other = mk("other", "skills-sync.json");
  makeLink(other, path.join(homeDir, ".skills-sync"));
  assert.equal(findLibrary(path.join(lib, "skills"), {}), lib);
  assert.equal(findLibrary(homeDir, {}), null, "from the home, with only ~/.skills-sync: no library");
  // $SKILLS_REPO beats the walk-up
  const third = mk("third", "skills-lock.json");
  assert.equal(findLibrary(path.join(lib, "skills"), { SKILLS_REPO: third }), path.resolve(third));
  assert.equal(findLibrary(path.join(lib, "skills"), { SKILLS_REPO: path.join(base, "nowhere") }), lib);
});
