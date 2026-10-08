import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vite-plus/test";
import { linkDeps, removeLink } from "../src/fs.js";
import { spawnSync } from "node:child_process";
import { makeLink, linkTarget, samePath, lexists } from "../src/fs.js";
import { Library } from "../src/library.js";
import { Report } from "../src/plan.js";
import { adoptBrain, rollbackBrain, brainLinks } from "../src/adoption.js";

test("explicit Brain adoption backs up only selected links, is idempotent and rolls back", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "brain-adopt-"));
  try {
    const lib = new Library(path.join(base, "reviewed"));
    const old = path.join(base, "legacy", "skills", "oneezy", "oneezy-brain");
    const target = path.join(lib.own, "oneezy", "oneezy-brain");
    for (const dir of [old, target]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "reviewed Brain");
    }
    const allowed = [".agents", ".claude"].map((name) => ({
      path: path.join(base, "home", name, "skills", "oneezy-brain"),
      expectedTarget: old,
    }));
    for (const item of allowed) makeLink(old, item.path);
    const unrelated = path.join(base, "home", ".agents", "skills", "other");
    makeLink(old, unrelated);
    const receipt = path.join(base, "receipts", "adoption.json");
    const manifest = { version: 1, links: allowed };
    const preview = new Report();
    adoptBrain(lib, manifest, allowed, receipt, preview, true);
    assert.equal(fs.existsSync(receipt), false);
    const first = new Report();
    adoptBrain(lib, manifest, allowed, receipt, first, false);
    assert.equal(first.conflicts().length, 0);
    for (const item of allowed) assert.ok(samePath(linkTarget(item.path)!, target));
    assert.ok(samePath(linkTarget(unrelated)!, old));
    const saved = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(saved.links.length, 2);
    for (const item of saved.links) assert.ok(lexists(item.backup));
    const repeat = new Report();
    adoptBrain(lib, manifest, allowed, receipt, repeat, false);
    assert.equal(repeat.changes().length, 0);
    rollbackBrain(receipt, allowed, new Report(), false);
    for (const item of allowed) assert.ok(samePath(linkTarget(item.path)!, old));
    rollbackBrain(receipt, allowed, new Report(), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("CLI advertises scoped adoption rather than requiring a broad unlink", () => {
  const cli = path.resolve(import.meta.dirname, "../dist/src/cli.js");
  const r = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /adopt-brain/);
  assert.match(r.stdout, /rollback-brain/);
  assert.match(r.stdout, /--adoption-file/);
  assert.match(r.stdout, /--receipt/);
});

for (const failure of ["changed-target", "link-failure", "later-rollback-edit", "outside-allowlist"])
  test(`adoption ${failure} preserves unexpected work`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "brain-adopt-guard-"));
    const original = linkDeps.symlink;
    try {
      const lib = new Library(path.join(base, "reviewed"));
      const target = path.join(lib.own, "oneezy", "oneezy-brain"),
        old = path.join(base, "old"),
        other = path.join(base, "other");
      for (const dir of [target, old, other]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), "Brain");
      }
      const link = path.join(base, "home", ".agents", "skills", "oneezy-brain");
      makeLink(old, link);
      const allowed = [{ path: link, expectedTarget: old }],
        manifest = { version: 1, links: allowed };
      const receipt = path.join(base, "receipt.json"),
        report = new Report();
      if (failure === "outside-allowlist") {
        assert.throws(
          () =>
            adoptBrain(
              lib,
              { version: 1, links: [{ path: path.join(base, "other-link"), expectedTarget: old }] },
              allowed,
              receipt,
              report,
              false,
            ),
          /limited/,
        );
        assert.ok(samePath(linkTarget(link)!, old));
        return;
      }
      if (failure === "changed-target") {
        removeLink(link);
        makeLink(other, link);
      }
      if (failure === "link-failure")
        linkDeps.symlink = () => {
          throw new Error("fixture refused link");
        };
      adoptBrain(lib, manifest, allowed, receipt, report, false);
      linkDeps.symlink = original;
      if (failure === "later-rollback-edit") {
        removeLink(link);
        makeLink(other, link);
        const rolled = new Report();
        rollbackBrain(receipt, allowed, rolled, false);
        assert.equal(rolled.conflicts().length, 1);
        assert.ok(samePath(linkTarget(link)!, other));
      } else {
        assert.equal(report.conflicts().length, 1);
        assert.ok(samePath(linkTarget(link)!, failure === "changed-target" ? other : old));
      }
    } finally {
      linkDeps.symlink = original;
      vi.restoreAllMocks();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

test("the production allowlist contains exactly the four literal Brain links", () => {
  assert.deepEqual(brainLinks("win32"), [
    {
      path: "C:\\Users\\Justin\\.agents\\skills\\oneezy-brain",
      expectedTarget: "V:\\dev\\skills\\skills\\oneezy\\oneezy-brain",
    },
    {
      path: "C:\\Users\\Justin\\.claude\\skills\\oneezy-brain",
      expectedTarget: "V:\\dev\\skills\\skills\\oneezy\\oneezy-brain",
    },
  ]);
  assert.deepEqual(brainLinks("linux"), [
    {
      path: "/home/justin/.agents/skills/oneezy-brain",
      expectedTarget: "/mnt/v/dev/skills/skills/oneezy/oneezy-brain",
    },
    {
      path: "/home/justin/.claude/skills/oneezy-brain",
      expectedTarget: "/mnt/v/dev/skills/skills/oneezy/oneezy-brain",
    },
  ]);
});
