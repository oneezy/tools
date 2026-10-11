// Links are directory symlinks first, junctions when Windows refuses one (EPERM: no Developer Mode, not elevated) or
// when the mode asks for one; POSIX has only symlinks. The link mode is a library command's (--symlinks, --junctions)
// for the links it makes inside a checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vite-plus/test";
import { isLink, linkDeps, linkTarget, makeLink, samePath, setLinkMode } from "../src/fs.js";

let base: string;
let target: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-links-"));
  target = path.join(base, "target");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "SKILL.md"), "---\nname: t\ndescription: t\n---\n");
  setLinkMode("auto");
});
afterEach(() => {
  setLinkMode("auto");
  fs.rmSync(base, { recursive: true, force: true });
});

/** What the file system says a link is, independently of this tool: Windows' reparse tag through fsutil; POSIX has only symlinks. */
function kindOnDisk(p: string): "symlink" | "junction" {
  if (process.platform !== "win32") return "symlink";
  const r = spawnSync("fsutil", ["reparsepoint", "query", p], { encoding: "utf8" });
  const m = /Reparse Tag Value\s*:\s*0x([0-9a-f]+)/i.exec(r.stdout);
  assert.ok(m, `fsutil on ${p}: ${r.stdout}${r.stderr}`);
  const tag = m[1].toLowerCase();
  if (tag === "a000000c") return "symlink";
  if (tag === "a0000003") return "junction";
  assert.fail(`unknown reparse tag 0x${tag} on ${p}`);
}

/** Whether this machine lets a non-elevated process create directory symlinks (Developer Mode on Windows). */
function canSymlink(): boolean {
  const d = fs.mkdtempSync(path.join(base, "probe-"));
  fs.mkdirSync(path.join(d, "t"));
  try {
    fs.symlinkSync(path.join(d, "t"), path.join(d, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

const eperm = () => Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });

test("a directory symlink is tried first; when Windows refuses it with EPERM the link becomes a junction; --symlinks (mode symlink) refuses instead", (t) => {
  if (process.platform !== "win32")
    return t.skip("junction fallback is a Windows behavior; POSIX always uses symlinks");
  const real = linkDeps.symlink;
  linkDeps.symlink = (to, link, type) => {
    if (type !== "junction") throw eperm();
    return real(to, link, type);
  };
  try {
    const link = path.join(base, "fallback");
    assert.equal(makeLink(target, link), "junction");
    assert.ok(isLink(link));
    assert.equal(kindOnDisk(link), "junction");
    assert.ok(samePath(linkTarget(link)!, target));
    setLinkMode("symlink");
    assert.throws(() => makeLink(target, path.join(base, "refused")), /EPERM/);
    assert.ok(!fs.existsSync(path.join(base, "refused")));
  } finally {
    linkDeps.symlink = real;
  }
});

test("where the symlink succeeds the link is a symlink; --junctions (mode junction) makes a junction without trying one, on Windows", (t) => {
  if (!canSymlink()) return t.skip("this machine refuses directory symlinks (no Developer Mode, not elevated)");
  const link = path.join(base, "made");
  assert.equal(makeLink(target, link), "symlink");
  assert.equal(kindOnDisk(link), "symlink");
  assert.ok(samePath(linkTarget(link)!, target));
  setLinkMode("junction");
  const forced = path.join(base, "forced");
  const kind = makeLink(target, forced);
  assert.equal(kind, process.platform === "win32" ? "junction" : "symlink");
  assert.equal(kindOnDisk(forced), kind);
  assert.ok(samePath(linkTarget(forced)!, target));
});
