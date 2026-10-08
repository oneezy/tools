import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { pullLibrary } from "../src/library.js";

test("frozen sync never discards a dirty generated lock when the remote can fast-forward", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-pull-preserve-")),
    origin = path.join(base, "origin"),
    root = path.join(base, "library");
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        dir,
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  try {
    fs.mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(origin, "skills-lock.json"), "committed lock\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "first");
    git(base, "clone", "-q", origin, root);
    const before = git(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(origin, "README.md"), "remote change");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "second");
    fs.writeFileSync(path.join(root, "skills-lock.json"), "Justin's dirty lock bytes\n");
    const result = pullLibrary(root, 0, () => {}, ["skills-lock.json"]);
    assert.equal(fs.readFileSync(path.join(root, "skills-lock.json"), "utf8"), "Justin's dirty lock bytes\n");
    assert.equal(git(root, "rev-parse", "HEAD"), before);
    assert.equal(result, "dirty");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
