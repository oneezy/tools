// How a global file is written, at the unit level (block.ts plans, plan.ts applies): the backup beside it before the
// file changes, its name when one is already taken that second, the backup checked against the file as planned, no
// backup left behind when the write fails, the lock two runs at once share, the temp file named per process, and a
// byte order mark before the start marker.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { BLOCK_BODY, BLOCK_SOURCE, blockAction, leftoverTemps, readBlock, withBlock } from "../src/block.js";
import { toHash } from "../src/fs.js";
import { apply, Report, writeInstruction } from "../src/plan.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-write-"));
  dirs.push(d);
  return d;
}

const NOW = new Date("2026-10-11T12:00:00.123Z");
const SOURCE = BLOCK_SOURCE;
const run = (file: string) => {
  const report = new Report();
  const a = blockAction(file, SOURCE, NOW)!;
  report.add(a);
  apply(report, false);
  return a;
};
/** Everything in the folder but the file itself. */
const others = (dir: string, file: string) =>
  fs
    .readdirSync(dir)
    .filter((n) => n !== path.basename(file))
    .sort();

test("a backup name taken that second gets -2, and the note names the copy that was made; the first stays as it was", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "mine\n");
  const taken = path.join(dir, "CLAUDE-backup-20261011-120000.md");
  fs.writeFileSync(taken, "an earlier backup\n");
  const a = run(file);
  assert.equal(a.kind, "write", a.note);
  assert.equal(a.backup, path.join(dir, "CLAUDE-backup-20261011-120000-2.md"));
  assert.ok(a.note?.endsWith(`backup ${a.backup}`), a.note);
  assert.equal(fs.readFileSync(taken, "utf8"), "an earlier backup\n");
  assert.equal(fs.readFileSync(a.backup!, "utf8"), "mine\n");
  assert.deepEqual(others(dir, file), ["CLAUDE-backup-20261011-120000-2.md", "CLAUDE-backup-20261011-120000.md"]);
});

test("another run's fresh lock skips the file silently: nothing written, no backup; a lock older than a minute is stale and taken", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "mine\n");
  const lock = `${file}.skills-sync.lock`;
  fs.writeFileSync(lock, "4242\n");
  const a = run(file);
  assert.equal(a.kind, "skip");
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  assert.deepEqual(others(dir, file), ["CLAUDE.md.skills-sync.lock"]);
  // the other run died two minutes ago: its lock is stale
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const b = run(file);
  assert.equal(b.kind, "write", b.note);
  assert.ok(fs.readFileSync(file, "utf8").startsWith("mine\n\n<!-- skills-sync:skills:start built-in"));
  // the lock went with the write, and no temp file is left
  assert.deepEqual(others(dir, file), ["CLAUDE-backup-20261011-120000.md"]);
});

test("a backup that does not match the file as planned aborts that file: the file, no backup and no temp file left", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "changed since planning\n");
  assert.throws(
    () => writeInstruction(file, "new body\n", path.join(dir, "CLAUDE-backup-x.md"), toHash(Buffer.from("planned\n"))),
    /backup does not match the file as planned/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), "changed since planning\n");
  assert.deepEqual(others(dir, file), []);
});

test("a write whose rename fails leaves the file as it was, and no backup and no temp file behind", () => {
  const dir = folder();
  const file = path.join(dir, "AGENTS.md");
  fs.writeFileSync(file, "mine\n");
  const backup = path.join(dir, "AGENTS-backup-y.md");
  // the rename into place fails (Windows answers EBUSY when another program holds the file)
  const rename = fs.renameSync;
  fs.renameSync = () => {
    throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  };
  try {
    assert.throws(() => writeInstruction(file, "new body\n", backup, toHash(Buffer.from("mine\n"))), /busy/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  assert.deepEqual(others(dir, file), []);
});

test("a byte order mark before the start marker on line 1: the block is found, replaced in place, the mark kept", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "﻿<!-- skills-sync:skills:start -->\nold\n<!-- skills-sync:skills:end -->\nmine\n");
  assert.equal(readBlock(file).present, true);
  run(file);
  assert.equal(fs.readFileSync(file, "utf8"), `﻿${withBlock("", SOURCE).trimEnd()}\nmine\n`);
  assert.equal(readBlock(file).handEdited, false);
});

test("only the skills and brain ids are the tool's: a user's example markers are text like any other", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  const mine = "```\n<!-- skills-sync:example:start -->\nmine\n<!-- skills-sync:example:end -->\n```\n";
  fs.writeFileSync(file, mine);
  assert.deepEqual(readBlock(file).ids, []);
  run(file);
  assert.equal(fs.readFileSync(file, "utf8"), `${mine}\n${withBlock("", SOURCE)}`);
  // the default text is the pointer, stamped built-in
  const fresh = path.join(dir, "AGENTS.md");
  const report = new Report();
  report.add(blockAction(fresh, undefined, NOW));
  apply(report, false);
  assert.equal(fs.readFileSync(fresh, "utf8"), withBlock("", BLOCK_SOURCE));
  assert.ok(fs.readFileSync(fresh, "utf8").startsWith("<!-- skills-sync:skills:start built-in sha256:"));
  assert.ok(fs.readFileSync(fresh, "utf8").includes(BLOCK_BODY));
});

/** Make a stale lock (its run died two minutes ago) beside `file`; returns its path. */
function staleLock(file: string): string {
  const lock = `${file}.skills-sync.lock`;
  fs.writeFileSync(lock, "4242\n");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  return lock;
}

/** Run `body` with fs.renameSync of the lock (and only the lock) going through `onLock` first. */
function onLockRename(lock: string, onLock: (rename: typeof fs.renameSync) => void, body: () => void): void {
  const rename = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === lock) onLock(rename);
    return rename(from, to);
  }) as typeof fs.renameSync;
  try {
    body();
  } finally {
    fs.renameSync = rename;
  }
}

test("a stale lock another run moves aside first: this run's rename of it fails, so this run skips the file and never takes a lock of its own", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "mine\n");
  const lock = staleLock(file);
  let a: ReturnType<typeof run> | undefined;
  // the other run renames the stale lock away just before this run does
  onLockRename(
    lock,
    (rename) => rename(lock, path.join(dir, "elsewhere.stale")),
    () => (a = run(file)),
  );
  assert.equal(a!.kind, "skip", a!.note);
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  assert.ok(!fs.existsSync(lock), "no lock of this run's own");
  assert.deepEqual(others(dir, file), ["elsewhere.stale"]);
});

test("a stale lock replaced by another run's fresh one just before this run moves it aside: the fresh lock is put back and the file skipped", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "mine\n");
  const lock = staleLock(file);
  let a: ReturnType<typeof run> | undefined;
  // between this run's look at the lock and its rename, the other run took the stale lock over: a fresh one is there
  onLockRename(
    lock,
    () => {
      fs.rmSync(lock);
      fs.writeFileSync(lock, "other\n");
    },
    () => (a = run(file)),
  );
  assert.equal(a!.kind, "skip", a!.note);
  assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  assert.equal(fs.readFileSync(lock, "utf8"), "other\n");
  assert.deepEqual(others(dir, file), ["CLAUDE.md.skills-sync.lock"]);
});

test("temp files a run left behind beside the file: those older than a minute are deleted, a fresh one (a run writing now) and other files stay", () => {
  const dir = folder();
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "mine\n");
  const old = path.join(dir, "CLAUDE.md.skills-sync.4242.0a1b2c3d.tmp");
  const fresh = path.join(dir, "CLAUDE.md.skills-sync.4343.0a1b2c3e.tmp");
  for (const p of [old, fresh, path.join(dir, "notes.tmp"), path.join(dir, "AGENTS.md.skills-sync.1.2.tmp")])
    fs.writeFileSync(p, "half\n");
  const twoMinutes = new Date(Date.now() - 120_000);
  fs.utimesSync(old, twoMinutes, twoMinutes);
  fs.utimesSync(path.join(dir, "notes.tmp"), twoMinutes, twoMinutes);
  const actions = leftoverTemps(file);
  assert.deepEqual(
    actions.map((a) => [a.kind, a.path]),
    [["delete", old]],
  );
  const report = new Report();
  for (const a of actions) report.add(a);
  apply(report, false);
  assert.deepEqual(others(dir, file), [
    "AGENTS.md.skills-sync.1.2.tmp",
    "CLAUDE.md.skills-sync.4343.0a1b2c3e.tmp",
    "notes.tmp",
  ]);
  // no folder, no file: nothing to delete
  assert.deepEqual(leftoverTemps(path.join(dir, "nothere", "CLAUDE.md")), []);
});
