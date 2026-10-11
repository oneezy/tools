// How a global file is written, at the unit level (block.ts plans, plan.ts applies): the backup beside it before the
// file changes, its name when one is already taken that second, the backup checked against the file as planned, no
// backup left behind when the write fails, the lock two runs at once share, the temp file named per process, and a
// byte order mark before the start marker.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { BLOCK_BODY, blockAction, blockSource, readBlock, withBlock } from "../src/block.js";
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
const SOURCE = blockSource("release-26", "# How Justin works\n");
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
  assert.ok(fs.readFileSync(file, "utf8").startsWith("mine\n\n<!-- skills-sync:skills:start release-26"));
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
  // and the built-in text is what an unreadable release leaves a file without a block
  const fresh = path.join(dir, "AGENTS.md");
  const report = new Report();
  report.add(blockAction(fresh, null, NOW)!);
  apply(report, false);
  assert.equal(fs.readFileSync(fresh, "utf8"), withBlock("", blockSource("built-in", null)));
  assert.ok(fs.readFileSync(fresh, "utf8").startsWith("<!-- skills-sync:skills:start built-in sha256:"));
  assert.ok(fs.readFileSync(fresh, "utf8").includes(BLOCK_BODY));
});
