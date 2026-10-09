import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "vite-plus/test";
import { aliasLinks, migrateAliases, rollbackAliases, type AliasLink } from "../src/aliases.js";
import { harnessTable } from "../src/harnesses.js";
import { isLink, lexists, linkTarget, makeLink, removeLink, samePath } from "../src/fs.js";
import { Library } from "../src/library.js";
import { Report } from "../src/plan.js";
import { withInternal } from "../src/build.js";

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-alias-"));
  const lib = new Library(path.join(base, "reviewed"));
  const hosts = harnessTable()
    .filter((h) => ["codex", "claude-code"].includes(h.id))
    .map((h) => ({
      ...h,
      configDir: path.join(base, "home", h.id),
      userSkills: path.join(base, "home", h.id, "skills"),
    }));
  const allowed: AliasLink[] = hosts.flatMap((h) =>
    ["oneezy-skills", "oneezy-status"].map((skill) => ({
      agent: h.id,
      skill,
      path: path.join(h.userSkills, skill),
      expectedTarget: path.join(base, "legacy", "skills", "oneezy", skill),
    })),
  );
  for (const skill of ["oneezy-skills", "oneezy-status"]) {
    const dir = path.join(lib.own, "oneezy", skill),
      replacement = path.join(base, "cache", skill);
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: skill\n---\nreviewed instructions\n`,
    );
    fs.writeFileSync(path.join(dir, "references", "detail.md"), "reviewed detail");
    fs.cpSync(dir, replacement, { recursive: true });
    fs.writeFileSync(
      path.join(replacement, "SKILL.md"),
      withInternal(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")),
    );
  }
  for (const item of allowed) {
    fs.mkdirSync(item.expectedTarget, { recursive: true });
    makeLink(item.expectedTarget, item.path);
  }
  const manifest = { version: 1, links: allowed.map(({ path, expectedTarget }) => ({ path, expectedTarget })) };
  const receipt = path.join(base, "receipts", "aliases.json");
  const resolve = (_lib: Library, _host: (typeof hosts)[number], skill: string) => path.join(base, "cache", skill);
  return {
    base,
    lib,
    hosts,
    allowed,
    manifest,
    receipt,
    resolve,
    dispose: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test("alias migration previews, preserves links outside discovery, repeats and restores exact originals", () => {
  const f = fixture();
  try {
    const unrelated = path.join(f.hosts[0].userSkills, "other");
    makeLink(f.allowed[0].expectedTarget, unrelated);
    const plan = new Report();
    migrateAliases(f.lib, f.manifest, f.allowed, f.hosts, f.receipt, plan, true, f.resolve);
    assert.equal(plan.conflicts().length, 0);
    assert.equal(plan.changes().length, 4);
    assert.equal(lexists(f.receipt), false);
    const applied = new Report();
    migrateAliases(f.lib, f.manifest, f.allowed, f.hosts, f.receipt, applied, false, f.resolve);
    assert.equal(applied.conflicts().length, 0);
    assert.equal(applied.changes().length, 4);
    const saved = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    for (const item of saved.links) {
      assert.equal(lexists(item.path), false);
      assert.ok(samePath(linkTarget(item.backup)!, item.expectedTarget));
      assert.ok(!samePath(path.dirname(item.backup), path.dirname(item.path)), "backup outside skill discovery");
      assert.equal(item.files.length, 2);
    }
    assert.ok(isLink(unrelated));
    const repeated = new Report();
    migrateAliases(f.lib, f.manifest, f.allowed, f.hosts, f.receipt, repeated, false, f.resolve);
    assert.equal(repeated.conflicts().length, 0);
    assert.equal(repeated.changes().length, 0);
    const rollbackPlan = new Report();
    rollbackAliases(f.receipt, f.allowed, rollbackPlan, true);
    assert.equal(rollbackPlan.conflicts().length, 0);
    assert.equal(rollbackPlan.changes().length, 4);
    const rollback = new Report();
    rollbackAliases(f.receipt, f.allowed, rollback, false);
    assert.equal(rollback.conflicts().length, 0);
    for (const item of f.allowed) assert.ok(samePath(linkTarget(item.path)!, item.expectedTarget));
    const repeatRollback = new Report();
    rollbackAliases(f.receipt, f.allowed, repeatRollback, false);
    assert.equal(repeatRollback.changes().length, 0);
  } finally {
    f.dispose();
  }
});

test("missing Status replacement holds both aliases on its host while independent host migrates", () => {
  const f = fixture();
  try {
    const report = new Report();
    migrateAliases(f.lib, f.manifest, f.allowed, f.hosts, f.receipt, report, false, (lib, host, skill) =>
      host.id === "claude-code" && skill === "oneezy-status" ? null : f.resolve(lib, host, skill),
    );
    assert.equal(report.conflicts().length, 2);
    assert.equal(report.changes().length, 2);
    for (const item of f.allowed) assert.equal(isLink(item.path), item.agent === "claude-code");
    assert.equal(JSON.parse(fs.readFileSync(f.receipt, "utf8")).links.length, 2);
  } finally {
    f.dispose();
  }
});

for (const failure of [
  "changed-target",
  "missing-backup",
  "changed-backup",
  "later-destination",
  "replacement-changed",
])
  test(`alias ${failure} preserves later work and receipt`, () => {
    const f = fixture();
    try {
      const selected = f.allowed.filter((a) => a.agent === "codex"),
        manifest = { version: 1, links: selected };
      if (failure === "changed-target") {
        removeLink(selected[0].path);
        makeLink(f.lib.root, selected[0].path);
      } else {
        migrateAliases(f.lib, manifest, f.allowed, f.hosts, f.receipt, new Report(), false, f.resolve);
        const saved = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
        if (failure === "missing-backup" || failure === "changed-backup") {
          removeLink(saved.links[0].backup);
          if (failure === "changed-backup") makeLink(f.lib.root, saved.links[0].backup);
        }
        if (failure === "later-destination") {
          fs.mkdirSync(selected[0].path);
          fs.writeFileSync(path.join(selected[0].path, "user.txt"), "later work");
        }
        if (failure === "replacement-changed")
          fs.writeFileSync(path.join(f.base, "cache", "oneezy-status", "references", "detail.md"), "changed cache");
      }
      const before = lexists(f.receipt) ? fs.readFileSync(f.receipt) : null;
      const report = new Report();
      migrateAliases(f.lib, manifest, f.allowed, f.hosts, f.receipt, report, false, f.resolve);
      assert.ok(report.conflicts().length > 0);
      assert.equal(report.changes().length, 0);
      if (before) assert.deepEqual(fs.readFileSync(f.receipt), before);
      else assert.equal(lexists(f.receipt), false);
      if (failure === "later-destination") {
        const rollback = new Report();
        rollbackAliases(f.receipt, f.allowed, rollback, false);
        assert.ok(rollback.conflicts().length > 0);
        assert.equal(fs.readFileSync(path.join(selected[0].path, "user.txt"), "utf8"), "later work");
      }
    } finally {
      f.dispose();
    }
  });

test("midflight replacement change retains the alias and supports recovery of the prepared receipt", () => {
  const f = fixture();
  try {
    const selected = [f.allowed[0]],
      report = new Report();
    let calls = 0;
    migrateAliases(
      f.lib,
      { version: 1, links: selected },
      f.allowed,
      f.hosts,
      f.receipt,
      report,
      false,
      (lib, host, skill) => {
        if (++calls === 2) return null;
        return f.resolve(lib, host, skill);
      },
    );
    assert.equal(report.conflicts().length, 1);
    assert.ok(samePath(linkTarget(selected[0].path)!, selected[0].expectedTarget));
    const rollback = new Report();
    rollbackAliases(f.receipt, f.allowed, rollback, false);
    assert.equal(rollback.conflicts().length, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.receipt, "utf8")).links[0].state, "rolled-back");
  } finally {
    f.dispose();
  }
});

test("allowlist rejects arbitrary skills, targets and duplicate aliases before writing", () => {
  const f = fixture();
  try {
    for (const links of [
      [{ ...f.allowed[0], path: path.join(f.base, "other") }],
      [{ ...f.allowed[0], expectedTarget: f.lib.root }],
      [f.allowed[0], f.allowed[0]],
    ])
      assert.throws(
        () =>
          migrateAliases(f.lib, { version: 1, links }, f.allowed, f.hosts, f.receipt, new Report(), false, f.resolve),
        /limited/,
      );
    assert.equal(lexists(f.receipt), false);
    assert.equal(aliasLinks("win32").length, 4);
    assert.equal(aliasLinks("linux").length, 4);
    assert.ok(
      [...aliasLinks("win32"), ...aliasLinks("linux")].every((a) =>
        ["oneezy-skills", "oneezy-status"].includes(a.skill),
      ),
    );
  } finally {
    f.dispose();
  }
});

for (const command of ["migrate-aliases", "rollback-aliases"])
  test(`${command} requires an explicit existing library before cloning`, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "aliases-no-clone-"));
    try {
      const r = spawnSync(
        process.execPath,
        [
          path.resolve(import.meta.dirname, "../dist/src/cli.js"),
          command,
          "--receipt",
          path.join(base, "receipt.json"),
          "--json",
        ],
        { encoding: "utf8", cwd: base, env: { ...process.env, HOME: base, USERPROFILE: base, SKILLS_REPO: "" } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /existing reviewed library/);
      assert.deepEqual(fs.readdirSync(base), []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

test("failed native prerequisite retains diagnostics for both held host aliases", () => {
  const f = fixture();
  try {
    const report = new Report();
    const diagnostic = {
      command: ["claude", "plugin", "details", "oneezy@oneezy-skills"],
      exitCode: 1,
      stdout: "context",
      stderr: "actual native error",
    };
    migrateAliases(
      f.lib,
      f.manifest,
      f.allowed,
      f.hosts,
      f.receipt,
      report,
      false,
      (lib, host, skill, _files, _plan, _target, onFailure) => {
        if (host.id === "claude-code") {
          onFailure?.(diagnostic);
          return null;
        }
        return f.resolve(lib, host, skill);
      },
    );
    assert.equal(report.conflicts().length, 2);
    for (const conflict of report.conflicts()) assert.deepEqual(conflict.diagnostic, diagnostic);
    for (const item of f.allowed.filter((a) => a.agent === "claude-code")) assert.ok(isLink(item.path));
  } finally {
    f.dispose();
  }
});

test("a later ownership conflict does not erase another alias's native diagnostic", () => {
  const f = fixture();
  try {
    const diagnostic = {
      command: ["claude", "plugin", "details", "oneezy@oneezy-skills"],
      exitCode: 1,
      stdout: "context",
      stderr: "native error",
    };
    const status = f.allowed.find((a) => a.agent === "claude-code" && a.skill === "oneezy-status")!;
    removeLink(status.path);
    makeLink(f.allowed[0].expectedTarget, status.path);
    const report = new Report();
    migrateAliases(
      f.lib,
      f.manifest,
      f.allowed,
      f.hosts,
      f.receipt,
      report,
      false,
      (lib, host, skill, _files, _plan, _target, onFailure) => {
        if (host.id === "claude-code" && skill === "oneezy-skills") {
          onFailure?.(diagnostic);
          return null;
        }
        return f.resolve(lib, host, skill);
      },
    );
    assert.equal(report.conflicts().length, 2);
    assert.deepEqual(report.conflicts().find((a) => a.path.endsWith("oneezy-skills"))?.diagnostic, diagnostic);
    assert.match(report.conflicts().find((a) => a.path === status.path)?.note ?? "", /historical alias target changed/);
    for (const item of f.allowed.filter((a) => a.agent === "claude-code")) assert.ok(isLink(item.path));
  } finally {
    f.dispose();
  }
});

test("distinct native errors survive host-wide paired alias gating", () => {
  const f = fixture();
  try {
    const report = new Report();
    migrateAliases(
      f.lib,
      f.manifest,
      f.allowed,
      f.hosts,
      f.receipt,
      report,
      false,
      (lib, host, skill, _files, _plan, _target, onFailure) => {
        if (host.id === "claude-code") {
          onFailure?.({
            command: ["claude", "plugin", "details", skill],
            exitCode: 1,
            stdout: "",
            stderr: `failure for ${skill}`,
          });
          return null;
        }
        return f.resolve(lib, host, skill);
      },
    );
    for (const skill of ["oneezy-skills", "oneezy-status"]) {
      const failure = report.conflicts().find((a) => a.path.endsWith(skill));
      assert.equal(failure?.diagnostic?.stderr, `failure for ${skill}`);
      assert.equal(failure?.diagnostic?.command.at(-1), skill);
    }
  } finally {
    f.dispose();
  }
});
