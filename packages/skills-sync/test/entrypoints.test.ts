import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vite-plus/test";
import { ENTRYPOINTS_NAME, entrypointProblems, entrypoints } from "../src/entrypoints.js";
import { harnessTable } from "../src/harnesses.js";
import { makeLink } from "../src/fs.js";
import { Library } from "../src/library.js";
import { apply, Report } from "../src/plan.js";
import { check } from "../src/check.js";

let base: string;
let lib: Library;
let project: string;
let userDir: string;
const body = "## Brain\nLoad /oneezy-brain; its registry resolves Google Drive.";
const start = "<!-- skills-sync:brain:start -->";
const end = "<!-- skills-sync:brain:end -->";

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function plan(global = true): Report {
  const report = new Report();
  entrypoints(lib, harnessTable(userDir, {}), global, [project], report);
  return report;
}

function configure(
  source = "skills/oneezy/oneezy-skills/assets/brain-routing.md",
  requiredFiles = ["references/location.md"],
): void {
  write(
    path.join(lib.root, ENTRYPOINTS_NAME),
    JSON.stringify({
      version: 1,
      blocks: {
        brain: {
          source,
          skill: "oneezy-brain",
          agents: ["codex", "claude-code"],
          requiredFiles,
        },
      },
    }),
  );
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-entrypoints-"));
  lib = new Library(path.join(base, "library"));
  project = path.join(base, "dev", "app");
  userDir = path.join(base, "user");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  write(path.join(lib.root, "skills-sync.json"), JSON.stringify({ version: 1, generate: { plugins: false } }));
  write(
    path.join(lib.own, "oneezy", "oneezy-brain", "SKILL.md"),
    "---\nname: oneezy-brain\ndescription: Brain\n---\nDrive\n",
  );
  write(path.join(lib.own, "oneezy", "oneezy-brain", "references", "location.md"), "Read the current registry.");
  write(path.join(lib.own, "oneezy", "oneezy-skills", "assets", "brain-routing.md"), body);
  configure();
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

test("plan writes nothing; apply preserves text, CRLF, imports, overrides and nested instructions; repeat is silent", () => {
  const agents = path.join(project, "AGENTS.md");
  const override = path.join(project, "AGENTS.override.md");
  const nested = path.join(project, "src", "CLAUDE.local.md");
  const original = "# Rules\r\nPinned source: https://github.com/oneezy/brain\r\nKeep dirty work.\r\n";
  write(agents, original);
  write(override, "Existing override\n");
  write(nested, "@pinned.md\nNested rules\n");
  const report = plan();
  apply(report, true);
  assert.equal(read(agents), original);
  assert.equal(fs.existsSync(path.join(userDir, ".codex", "AGENTS.md")), false);
  apply(report, false);
  assert.ok(read(agents).startsWith(original));
  assert.ok(read(agents).includes(`${start}\r\n`));
  assert.ok(read(override).startsWith("Existing override\n"));
  assert.ok(read(nested).startsWith("@pinned.md\nNested rules\n"));
  assert.ok(read(path.join(project, "CLAUDE.md")).startsWith("@AGENTS.md\n"));
  assert.ok(read(path.join(userDir, ".codex", "AGENTS.md")).includes(body));
  assert.ok(read(path.join(userDir, ".claude", "CLAUDE.md")).includes(body));
  assert.equal(plan().changes().length, 0);
});

test("source updates replace only the marked block, including when global overrides are active", () => {
  const file = path.join(userDir, ".codex", "AGENTS.override.md");
  const outside = "Keep this rule.\n";
  write(file, outside + start + "\nOld Brain route\n" + end + "\n@pinned.md\n");
  apply(plan(), false);
  assert.equal(read(file), outside + start + "\n" + body + "\n" + end + "\n@pinned.md\n");
  write(path.join(lib.own, "oneezy", "oneezy-skills", "assets", "brain-routing.md"), "New delegation");
  apply(plan(), false);
  assert.equal(read(file), outside + start + "\nNew delegation\n" + end + "\n@pinned.md\n");
});

test("malformed or duplicate markers and linked parents are conflicts, with original bytes preserved", () => {
  const malformed = path.join(project, "AGENTS.md");
  const duplicate = path.join(project, "CLAUDE.md");
  write(malformed, "User notes\n" + start);
  write(duplicate, start + end + start + end);
  const external = path.join(base, "external");
  fs.mkdirSync(external);
  makeLink(external, path.join(userDir, ".codex"));
  const report = plan();
  apply(report, false);
  assert.ok(report.conflicts().length >= 3);
  assert.equal(read(malformed), "User notes\n" + start);
  assert.equal(read(duplicate), start + end + start + end);
  assert.equal(fs.existsSync(path.join(external, "AGENTS.md")), false);
});

test("writes refuse an edit made after planning, including a newly created target", () => {
  const file = path.join(project, "AGENTS.md");
  write(file, "Original user notes");
  const report = plan(false);
  write(file, "Concurrent edit");
  write(path.join(project, "CLAUDE.md"), "Concurrent new file");
  apply(report, false);
  assert.equal(read(file), "Concurrent edit");
  assert.equal(read(path.join(project, "CLAUDE.md")), "Concurrent new file");
  assert.equal(report.conflicts().length, 2);
});

test("unsafe sources and an older skill missing required files fail check and propagate nothing", () => {
  configure("../outside.md");
  assert.ok(entrypointProblems(lib).some((problem) => problem.includes("inside the library")));
  assert.ok(check(lib).problems.some((problem) => problem.path === ENTRYPOINTS_NAME));
  assert.equal(plan().changes().length, 0);
  configure();
  fs.rmSync(path.join(lib.own, "oneezy", "oneezy-brain", "references", "location.md"));
  assert.ok(entrypointProblems(lib).length > 0);
  assert.equal(plan().changes().length, 0);
});

test("unselected projects and generated folders stay untouched; status planning is read-only", () => {
  const file = path.join(project, "node_modules", "dependency", "AGENTS.md");
  write(file, "Dependency instructions");
  const unselected = path.join(base, "dev", "other", "CLAUDE.md");
  write(unselected, "Other project");
  apply(plan(false), false);
  assert.equal(read(file), "Dependency instructions");
  assert.equal(read(unselected), "Other project");
  const report = new Report();
  const statuses = entrypoints(lib, harnessTable(userDir, {}), false, [project], report);
  assert.ok(statuses.every((item) => item.state === "current"));
  assert.equal(report.changes().length, 0);
});

test("CLI plan/apply/status uses the same workflow and exits nonzero on an instruction conflict", () => {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
  const args = [
    "--repo",
    lib.root,
    "--agents",
    "codex,claude-code",
    "--no-global",
    "--no-remember",
    "--no-pull",
    "--no-restore",
    "--no-wsl",
    "--dev",
    path.dirname(project),
    "--projects",
    "app",
    "--json",
    "-y",
  ];
  const run = (...extra: string[]) => spawnSync(process.execPath, [cli, ...extra, ...args], { encoding: "utf8" });
  const preview = run("--plan");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(fs.existsSync(path.join(project, "AGENTS.md")), false);
  const applied = run();
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(JSON.parse(applied.stdout).entrypoints.every((item: { state: string }) => item.state === "current"));
  const repeated = run();
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(
    JSON.parse(repeated.stdout).actions.filter(
      (action: { note?: string; kind: string }) => action.kind === "write" && action.note?.includes("instructions"),
    ).length,
    0,
  );
  const status = run("status");
  assert.equal(status.status, 0, status.stderr);
  assert.ok(JSON.parse(status.stdout).entrypoints.every((item: { state: string }) => item.state === "current"));
  write(path.join(project, "AGENTS.md"), start);
  const conflict = run();
  assert.equal(conflict.status, 1);
  assert.equal(read(path.join(project, "AGENTS.md")), start);
});

test("an apply I/O failure leaves dependent actions blocked while an independent instruction destination completes", () => {
  const bad = path.join(base, "failed", "AGENTS.md");
  const good = path.join(base, "healthy", "CLAUDE.md");
  const report = new Report();
  report.add({ kind: "write", path: bad, payload: body, expectedHash: null });
  report.add({ kind: "copy", path: path.join(base, "dependent"), target: bad });
  report.add({ kind: "write", path: good, payload: body, expectedHash: null });
  write(path.dirname(bad), "a file now occupies the destination parent");
  apply(report, false);
  assert.equal(report.conflicts().length, 2);
  assert.equal(report.actions[0].failed, true);
  assert.match(report.actions[0].note!, /write failed/);
  assert.match(report.actions[1].note!, /dependent action blocked/);
  assert.equal(fs.existsSync(path.join(base, "dependent")), false);
  assert.equal(read(path.dirname(bad)), "a file now occupies the destination parent");
  assert.equal(read(good), body);
});

test("readback cannot claim a current route when installed Brain instructions are stale", () => {
  apply(plan(false), false);
  write(path.join(project, ".agents", "skills", "oneezy-brain", "SKILL.md"), "stale GitHub Brain");
  const statuses = entrypoints(
    lib,
    harnessTable(userDir, {}).filter((host) => host.id === "codex"),
    false,
    [project],
    new Report(),
    true,
  );
  assert.ok(
    statuses.some((item) => item.state === "conflict" && item.reason?.includes("installed instructions differ")),
  );
});

test("an unreadable project discovery reports its failure and still plans the independent project", () => {
  const unavailable = path.join(base, "unavailable-project");
  write(unavailable, "a file occupies this project path");
  const report = new Report();
  const statuses = entrypoints(lib, harnessTable(userDir, {}), false, [unavailable, project], report);
  assert.ok(statuses.some((item) => item.path === unavailable && item.state === "conflict"));
  assert.ok(report.conflicts().some((item) => item.note?.includes("instruction discovery failed")));
  apply(report, false);
  assert.equal(read(unavailable), "a file occupies this project path");
  assert.ok(read(path.join(project, "AGENTS.md")).includes(body));
  assert.ok(read(path.join(project, "CLAUDE.md")).includes(body));
});
