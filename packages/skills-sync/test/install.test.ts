// The plugin form: sync installs a library's built plugins on Claude Code and Codex through their own commands,
// verifies them, and only then drops the loose links of their skills; --links rolls back; unlink removes both forms;
// status says which form each harness has. The harnesses are fake CLIs on PATH (fixtures/fake-harness), never the machine's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test, vi } from "vite-plus/test";
import { isLink, linkTarget, under, makeLink } from "../src/fs.js";
import { withInternal } from "../src/build.js";
import { ENTRYPOINTS_NAME } from "../src/entrypoints.js";
import { Library } from "../src/library.js";
import { harnessTable } from "../src/harnesses.js";
import { pluginDependency } from "../src/install.js";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const FAKE = path.resolve(import.meta.dirname, "fixtures", "fake-harness", "fake-harness.mjs");

let base: string;
let root: string;
let homeDir: string;
let claudeHome: string;
let codexHome: string;
let bin: string;
let log: string;

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function skill(dir: string, name: string): void {
  write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`);
}

/** A built package as build writes it, as far as the harnesses read it: both manifests and the skill copies. */
function plugin(id: string, skills: string[], version = "0.1.0+aaaaaaaaaaaa"): void {
  const dir = path.join(root, "plugins", id);
  write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: id }));
  write(path.join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: id, version, skills: "./skills/" }));
  for (const s of skills) skill(path.join(dir, "skills"), s);
}

function catalogs(ids: string[]): void {
  const plugins = ids.map((id) => ({ name: id, source: `./plugins/${id}` }));
  write(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "oneezy-skills", plugins }));
  write(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "oneezy-skills", plugins }));
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-install-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "skills");
  homeDir = path.join(base, "home");
  claudeHome = path.join(homeDir, ".claude");
  codexHome = path.join(homeDir, ".codex");
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  // the library: an own group (oneezy), a third-party copy (grilling, matt-pocock's) and a flat own skill in no plugin
  skill(path.join(root, "skills", "oneezy"), "oneezy-status");
  skill(path.join(root, "skills", "oneezy"), "oneezy-merge");
  skill(path.join(root, "skills"), "solo");
  skill(path.join(root, ".agents", "skills"), "grilling");
  write(
    path.join(root, "skills-lock.json"),
    JSON.stringify({ version: 1, skills: { grilling: { source: "mattpocock/skills", sourceType: "github" } } }),
  );
  plugin("oneezy", ["oneezy-merge", "oneezy-status"]);
  plugin("matt-pocock", ["grilling"]);
  catalogs(["oneezy", "matt-pocock"]);
  // the fake harnesses, on PATH ahead of anything real
  bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  for (const h of ["claude", "codex"]) {
    if (process.platform === "win32") write(path.join(bin, `${h}.cmd`), `@"${process.execPath}" "${FAKE}" ${h} %*\r\n`);
    else {
      write(path.join(bin, h), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" ${h} "$@"\n`);
      fs.chmodSync(path.join(bin, h), 0o755);
    }
  }
  log = path.join(base, "calls.log");
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  json: {
    actions: Array<{
      kind: string;
      path: string;
      note?: string;
      diagnostic?: { command: string[]; exitCode: number | null; stderr: string; stdout: string };
    }>;
    harnesses?: Record<string, HarnessJson>;
    user?: Record<string, { linked: number; plugin: number; missing: string[] }>;
  };
  calls: string[][];
}
interface HarnessJson {
  form: string;
  plugins: Array<{ name: string; installed: string | null; built: string | null; match: boolean; owned: boolean }>;
}

function cli(args: string[], extra: Record<string, string> = {}, entrypoints = false): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = bin + path.delimiter + (env[pathKey] ?? "");
  delete env.CLAUDE_CODE_REMOTE;
  Object.assign(env, {
    HOME: homeDir,
    USERPROFILE: homeDir,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    FAKE_HARNESS_LOG: log,
    ...extra,
  });
  if (fs.existsSync(log)) fs.rmSync(log);
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      ...args,
      "--repo",
      root,
      "--agents",
      "claude-code,codex",
      "--no-projects",
      "--no-pull",
      "--no-restore",
      "--no-wsl",
      "--no-remember",
      ...(entrypoints ? [] : ["--no-entrypoints"]),
      "--json",
      "-y",
    ],
    { encoding: "utf8", env, cwd: base },
  );
  const calls = fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];
  let json: Run["json"] = { actions: [] };
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* the assertion on status says why */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, calls };
}

/** What a fake harness has installed: plugin id -> its record. */
function installed(home: string): Record<string, { version: string; enabled: boolean }> {
  const f = path.join(home, "fake-harness.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).plugins : {};
}
function marketplaces(home: string): Record<string, string> {
  const f = path.join(home, "fake-harness.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).marketplaces : {};
}

const claudeSkills = () => path.join(claudeHome, "skills");
const codexSkills = () => path.join(homeDir, ".agents", "skills");
function linked(dir: string, name: string): boolean {
  const p = path.join(dir, name);
  return isLink(p) && under(linkTarget(p)!, root);
}
const PLUGIN_SKILLS = ["oneezy-merge", "oneezy-status", "grilling"];
test("Claude write commands negotiate --json through help before registering or installing", () => {
  const result = cli(["--plugins"], { FAKE_HARNESS_NO_WRITE_JSON: "claude" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(call(result, "claude", "plugin", "marketplace", "add", "--help"));
  const writes = result.calls.filter(
    (c) =>
      c[0] === "claude" && !c.includes("--help") && (c[2] === "install" || (c[2] === "marketplace" && c[3] === "add")),
  );
  assert.equal(writes.length, 3);
  assert.ok(writes.every((c) => !c.includes("--json")));
  assert.equal(Object.keys(installed(claudeHome)).length, 2);
});

test("plugin failures retain structured command, exit status and original stdout/stderr", () => {
  const result = cli(["--plugins"], { FAKE_HARNESS_FAIL_MARKETPLACE: "claude" });
  const failed = result.json.actions.find(
    (a) => a.kind === "conflict" && a.path === "Claude Code: marketplace oneezy-skills",
  );
  assert.equal(failed?.diagnostic?.exitCode, 1);
  assert.match(failed?.diagnostic?.stderr ?? "", /fixture registry registration denied/);
  assert.match(failed?.diagnostic?.stdout ?? "", /registry provider context/);
  assert.ok(failed?.diagnostic?.command.includes(root));
  assert.deepEqual(installed(claudeHome), {});
  assert.equal(Object.keys(installed(codexHome)).length, 2, "independent Codex installation continues");
});

for (const failedIds of ["oneezy@oneezy-skills", "oneezy@oneezy-skills,matt-pocock@oneezy-skills"])
  test(`Claude resolution retains each original diagnostic after later checks: ${failedIds}`, () => {
    const result = cli(["--plugins"], { FAKE_HARNESS_FAIL_DETAILS: failedIds });
    for (const id of failedIds.split(",")) {
      const failure = result.json.actions.find((a) => a.kind === "conflict" && a.path === `Claude Code: plugin ${id}`);
      assert.equal(failure?.diagnostic?.exitCode, 1);
      assert.deepEqual(failure?.diagnostic?.command.slice(-3), ["plugin", "details", id]);
      assert.match(failure?.diagnostic?.stderr ?? "", new RegExp(`fixture details failed: ${id}`));
    }
  });

test("alias replacement verification bypasses only the exact approved foreign target and still checks enabled identity and every file", () => {
  const own = path.join(root, "skills", "oneezy", "oneezy-status");
  const built = path.join(root, "plugins", "oneezy", "skills", "oneezy-status");
  write(path.join(own, "references", "status.md"), "current report rules");
  write(path.join(built, "references", "status.md"), "current report rules");
  write(path.join(built, "SKILL.md"), withInternal(fs.readFileSync(path.join(own, "SKILL.md"), "utf8")));
  assert.equal(cli(["--plugins"]).status, 0);
  const old = path.join(base, "legacy", "oneezy-status");
  skill(path.dirname(old), "oneezy-status");
  makeLink(old, path.join(codexSkills(), "oneezy-status"));
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  vi.stubEnv(pathKey, bin + path.delimiter + (process.env[pathKey] ?? ""));
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
  vi.stubEnv("FAKE_HARNESS_LOG", log);
  try {
    const lib = new Library(root),
      host = harnessTable(homeDir).find((h) => h.id === "codex")!;
    assert.equal(pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false), null);
    assert.equal(
      pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false, path.join(base, "wrong")),
      null,
    );
    assert.equal(pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false, old), built);
    vi.stubEnv("FAKE_HARNESS_FAIL_PROMPT", "codex");
    const failures: NonNullable<import("../src/plan.js").Action["diagnostic"]>[] = [];
    assert.equal(
      pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false, old, (d) => failures.push(d)),
      null,
    );
    assert.equal(failures[0]?.exitCode, 1);
    assert.deepEqual(failures[0]?.command.slice(-2), ["debug", "prompt-input"]);
    assert.match(failures[0]?.stderr ?? "", /fixture prompt inventory failed/);
    vi.stubEnv("FAKE_HARNESS_FAIL_PROMPT", "");
    write(path.join(built, "references", "status.md"), "wrong cache");
    assert.equal(pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false, old), null);
    write(path.join(built, "references", "status.md"), "current report rules");
    const state = JSON.parse(fs.readFileSync(path.join(codexHome, "fake-harness.json"), "utf8"));
    state.plugins["oneezy@oneezy-skills"].enabled = false;
    fs.writeFileSync(path.join(codexHome, "fake-harness.json"), JSON.stringify(state));
    assert.equal(pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false, old), null);
  } finally {
    vi.unstubAllEnvs();
  }
});
test("sync preserves a newer installed Codex plugin instead of reinstalling the older built version", () => {
  assert.equal(cli(["--plugins"]).status, 0);
  const file = path.join(codexHome, "fake-harness.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.plugins["oneezy@oneezy-skills"].version = "0.99.0+newer";
  fs.writeFileSync(file, JSON.stringify(saved));
  const result = cli(["--plugins"]);
  assert.equal(installed(codexHome)["oneezy@oneezy-skills"].version, "0.99.0+newer");
  assert.ok(!call(result, "codex", "plugin", "add", "oneezy@oneezy-skills"));
  assert.ok(result.json.actions.some((a) => a.kind === "conflict" && a.note?.includes("newer installed version")));
});

const call = (r: Run, ...words: string[]) => r.calls.some((c) => words.every((w, i) => c[i] === w));

test("sync installs the built plugins on Claude Code and Codex, verifies them, then drops only their skills' loose links", () => {
  // an earlier links-only sync left a link per skill on both harnesses
  const before = cli(["--links"]);
  assert.equal(before.status, 0, before.stderr);
  for (const s of [...PLUGIN_SKILLS, "solo"]) assert.ok(linked(claudeSkills(), s) && linked(codexSkills(), s), s);
  assert.deepEqual(before.calls, [], "links form asks no harness anything when it installed nothing");

  const r = cli(["--plugins"]);
  assert.equal(r.status, 0, r.stderr);
  for (const home of [claudeHome, codexHome]) {
    assert.deepEqual(Object.keys(installed(home)).sort(), ["matt-pocock@oneezy-skills", "oneezy@oneezy-skills"]);
    assert.equal(marketplaces(home)["oneezy-skills"], root);
  }
  // installed through the harnesses' own commands, Claude at user scope; verified by the harnesses' listings without a session
  assert.ok(call(r, "claude", "plugin", "marketplace", "add", root));
  assert.ok(call(r, "claude", "plugin", "install", "oneezy@oneezy-skills", "--scope", "user"));
  assert.ok(call(r, "codex", "plugin", "add", "oneezy@oneezy-skills"));
  assert.ok(call(r, "claude", "plugin", "details", "oneezy@oneezy-skills"));
  assert.ok(call(r, "codex", "debug", "prompt-input"));
  // the settings files are the harnesses' business: the tool wrote none
  assert.equal(fs.existsSync(path.join(claudeHome, "settings.json")), false);
  assert.equal(fs.existsSync(path.join(codexHome, "config.toml")), false);
  for (const s of PLUGIN_SKILLS) {
    assert.equal(fs.existsSync(path.join(claudeSkills(), s)), false, `claude ${s}`);
    assert.equal(fs.existsSync(path.join(codexSkills(), s)), false, `codex ${s}`);
  }
  assert.ok(linked(claudeSkills(), "solo") && linked(codexSkills(), "solo"), "a skill in no plugin keeps its link");
  const removed = r.json.actions.filter((a) => a.kind === "remove");
  assert.equal(removed.length, 6);
  assert.ok(removed.every((a) => /carried by plugin (oneezy|matt-pocock)@oneezy-skills/.test(a.note ?? "")));
  // the tool remembers what it installed, per harness config folder, and the form --plugins chose
  const local = JSON.parse(fs.readFileSync(path.join(root, "skills-sync.local.json"), "utf8"));
  assert.equal(local.form, "plugin");
  assert.deepEqual(local.plugins[claudeHome], {
    harness: "claude-code",
    marketplace: "oneezy-skills",
    plugins: ["oneezy@oneezy-skills", "matt-pocock@oneezy-skills"],
  });
  assert.equal(local.plugins[codexHome].harness, "codex");

  // again: nothing to install, no loose link left to drop, so nothing is asked to resolve and nothing changes
  const again = cli([]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.actions.filter((a) => !["skip", "note"].includes(a.kind)).length, 0);
  assert.ok(!call(again, "claude", "plugin", "install") && !call(again, "codex", "plugin", "add"));
  assert.ok(!call(again, "claude", "plugin", "details") && !call(again, "codex", "debug"));
});

test("a harness whose plugins do not verify keeps its loose links and is named in the report; the other harness proceeds", () => {
  cli(["--links"]);
  const r = cli(["--plugins"], { FAKE_HARNESS_BROKEN: "codex" });
  assert.equal(r.status, 0, r.stderr);
  for (const s of PLUGIN_SKILLS) {
    assert.equal(fs.existsSync(path.join(claudeSkills(), s)), false, `claude ${s}`);
    assert.ok(linked(codexSkills(), s), `codex keeps ${s}`);
  }
  const failed = r.json.actions.filter((a) => a.kind === "conflict");
  assert.deepEqual(failed.map((a) => a.path).sort(), [
    "Codex: plugin matt-pocock@oneezy-skills",
    "Codex: plugin oneezy@oneezy-skills",
  ]);
  assert.ok(failed.every((a) => /not verified .*loose links kept/.test(a.note!)));
  // fixed: the next run verifies them (their skills still have links to drop) and the links go
  const fixed = cli([]);
  assert.equal(fixed.status, 0, fixed.stderr);
  for (const s of PLUGIN_SKILLS) assert.equal(fs.existsSync(path.join(codexSkills(), s)), false, `codex ${s}`);
});

test("sync --links uninstalls the plugins the tool installed and restores the loose links; a second --links changes nothing", () => {
  assert.equal(cli([]).status, 0);
  const r = cli(["--links"]);
  assert.equal(r.status, 0, r.stderr);
  for (const home of [claudeHome, codexHome]) {
    assert.deepEqual(installed(home), {});
    assert.equal(marketplaces(home)["oneezy-skills"], root, "the marketplace registration is kept");
  }
  assert.ok(call(r, "claude", "plugin", "uninstall", "oneezy@oneezy-skills", "--scope", "user"));
  assert.ok(call(r, "codex", "plugin", "remove", "oneezy@oneezy-skills"));
  for (const s of [...PLUGIN_SKILLS, "solo"]) assert.ok(linked(claudeSkills(), s) && linked(codexSkills(), s), s);
  const local = JSON.parse(fs.readFileSync(path.join(root, "skills-sync.local.json"), "utf8"));
  assert.equal(local.form, "links");
  assert.equal(local.plugins[claudeHome].plugins.length, 0);

  const again = cli([]); // remembered: links
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.json.actions.filter((a) => !["skip", "note"].includes(a.kind)).length, 0);
  assert.deepEqual(again.calls, []);
});

test("a harness that could only take plugins through a settings edit is reported blocked, with that file, and keeps its links", () => {
  const r = cli([], { FAKE_HARNESS_OLD: "claude" });
  assert.equal(r.status, 0, r.stderr);
  const blocked = r.json.actions.find((a) => a.kind === "conflict");
  assert.equal(blocked?.path, path.join(claudeHome, "settings.json"));
  assert.match(
    blocked!.note!,
    /Claude Code blocked: .*settings\.json, which skills-sync never makes; loose links kept/,
  );
  assert.ok(!call(r, "claude", "plugin", "marketplace"), "nothing but --help was asked of the old CLI");
  for (const s of PLUGIN_SKILLS) assert.ok(linked(claudeSkills(), s), `claude keeps ${s}`);
  assert.equal(Object.keys(installed(codexHome)).length, 2);
  for (const s of PLUGIN_SKILLS) assert.equal(fs.existsSync(path.join(codexSkills(), s)), false, `codex ${s}`);
});

test("status --json names each harness's form and whether each installed plugin is the built version; sync re-adds a rebuilt Codex plugin", () => {
  const none = cli(["status"]);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.json.harnesses!["claude-code"].form, "links");
  assert.equal(none.json.harnesses!.codex.form, "links");

  cli([]);
  const s = cli(["status"]);
  assert.equal(s.status, 0, s.stderr);
  for (const id of ["claude-code", "codex"]) {
    assert.equal(s.json.harnesses![id].form, "plugin");
    assert.ok(
      s.json.harnesses![id].plugins.every((p) => p.match && p.owned && p.installed !== null),
      id,
    );
  }
  assert.equal(s.json.harnesses!.codex.plugins.find((p) => p.name === "oneezy")!.built, "0.1.0+aaaaaaaaaaaa");
  // a skill a plugin carries is not missing from the user folder
  assert.deepEqual(s.json.user![codexSkills()], { linked: 1, plugin: 3, missing: [] });

  // a rebuild that took the next version: Codex runs its cached copy until the plugin is added again
  plugin("oneezy", ["oneezy-merge", "oneezy-status"], "0.2.0+bbbbbbbbbbbb");
  const stale = cli(["status"]).json.harnesses!.codex.plugins.find((p) => p.name === "oneezy")!;
  assert.deepEqual([stale.installed, stale.built, stale.match], ["0.1.0+aaaaaaaaaaaa", "0.2.0+bbbbbbbbbbbb", false]);
  const r = cli([]);
  assert.ok(call(r, "codex", "plugin", "add", "oneezy@oneezy-skills"));
  assert.ok(!call(r, "claude", "plugin", "install"), "Claude reads the package in place");
  assert.ok(cli(["status"]).json.harnesses!.codex.plugins.every((p) => p.match));
});

test("unlink removes both forms the tool owns: its links, its plugins, then its marketplace", () => {
  cli([]);
  const r = cli(["unlink"]);
  assert.equal(r.status, 0, r.stderr);
  for (const home of [claudeHome, codexHome]) {
    assert.deepEqual(installed(home), {});
    assert.deepEqual(marketplaces(home), {});
  }
  assert.equal(fs.existsSync(path.join(claudeSkills(), "solo")), false);
  // Codex's marketplace remove does not cascade: its plugins went first
  const codexCalls = r.calls.filter((c) => c[0] === "codex").map((c) => c.slice(1, 3).join(" "));
  assert.ok(codexCalls.indexOf("plugin remove") < codexCalls.indexOf("plugin marketplace"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "skills-sync.local.json"), "utf8")).plugins, undefined);
});

test("a plugin of the same name from another marketplace is left alone and its skills keep their links", () => {
  // the user installed oneezy themselves, from somewhere else
  write(
    path.join(claudeHome, "fake-harness.json"),
    JSON.stringify({
      marketplaces: { elsewhere: root },
      plugins: { "oneezy@elsewhere": { version: "x", enabled: true, dir: path.join(root, "plugins", "oneezy") } },
    }),
  );
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.json.actions.some((a) => a.kind === "conflict" && a.path === "Claude Code: plugin oneezy"));
  assert.ok(linked(claudeSkills(), "oneezy-status"));
  assert.equal(fs.existsSync(path.join(claudeSkills(), "grilling")), false);
  assert.deepEqual(Object.keys(installed(claudeHome)).sort(), ["matt-pocock@oneezy-skills", "oneezy@elsewhere"]);
});

test("without built plugins, and in a cloud session, sync is the links-only sync it always was and asks no harness anything", () => {
  const cloud = cli([], { CLAUDE_CODE_REMOTE: "true" });
  assert.equal(cloud.status, 0, cloud.stderr);
  assert.deepEqual(cloud.calls, []);
  for (const s of [...PLUGIN_SKILLS, "solo"]) assert.ok(linked(claudeSkills(), s), s);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "skills-sync.local.json"), "utf8")).form, undefined);

  fs.rmSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.rmSync(path.join(root, ".agents", "plugins"), { recursive: true });
  fs.rmSync(path.join(root, "plugins"), { recursive: true });
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  for (const s of [...PLUGIN_SKILLS, "solo"]) assert.ok(linked(claudeSkills(), s) && linked(codexSkills(), s), s);
});

for (const compatibility of ["in-place", "cache-aliases"])
  test(`plugin Brain references are checked before writes/unlink with ${compatibility} CLI inventory`, () => {
    const extra: Record<string, string> =
      compatibility === "cache-aliases" ? { FAKE_HARNESS_CACHE: "true", FAKE_HARNESS_ALIASES: "true" } : {};
    const own = path.join(root, "skills", "oneezy", "oneezy-brain");
    skill(path.dirname(own), "oneezy-brain");
    write(path.join(own, "references", "location.md"), "Observed Drive registry");
    const built = path.join(root, "plugins", "oneezy", "skills", "oneezy-brain");
    write(path.join(built, "SKILL.md"), withInternal(fs.readFileSync(path.join(own, "SKILL.md"), "utf8")));
    write(path.join(built, "references", "location.md"), "Observed Drive registry");
    write(path.join(root, "brain-routing.md"), "Load the current Brain registry.");
    write(
      path.join(root, ENTRYPOINTS_NAME),
      JSON.stringify({
        version: 1,
        blocks: {
          brain: {
            source: "brain-routing.md",
            skill: "oneezy-brain",
            agents: ["codex", "claude-code"],
            requiredFiles: ["references/location.md"],
          },
        },
      }),
    );
    if (compatibility === "cache-aliases") {
      const git = (args: string[]) => {
        const r = spawnSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-C",
            root,
            ...args,
          ],
          { encoding: "utf8" },
        );
        assert.equal(r.status, 0, r.stderr);
      };
      git(["init", "-q"]);
      git(["add", "."]);
      git(["commit", "-q", "-m", "fixture"]);
    }
    assert.equal(cli([], extra, true).status, 0);
    const cache = path.join(base, "codex-cache");
    fs.cpSync(path.join(root, "plugins", "oneezy"), cache, { recursive: true });
    write(path.join(cache, "skills", "oneezy-brain", "references", "location.md"), "Stale registry");
    const stateFile = path.join(codexHome, "fake-harness.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.plugins["oneezy@oneezy-skills"].dir = cache;
    write(stateFile, JSON.stringify(state));
    const affected = path.join(codexHome, "AGENTS.md");
    write(affected, "Keep Codex rules\r\n");
    write(path.join(claudeHome, "CLAUDE.md"), "Keep Claude rules\n");
    makeLink(own, path.join(codexSkills(), "oneezy-brain"));
    for (const args of [["--plan"], []]) {
      const result = cli(args, extra, true);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(fs.readFileSync(affected, "utf8"), "Keep Codex rules\r\n");
      assert.ok(linked(codexSkills(), "oneezy-brain"));
    }
    assert.ok(fs.readFileSync(path.join(claudeHome, "CLAUDE.md"), "utf8").includes("skills-sync:brain:start"));
    write(path.join(cache, "skills", "oneezy-brain", "references", "location.md"), "Observed Drive registry");
    assert.equal(cli([], extra, true).status, 0);
    assert.equal(fs.existsSync(path.join(codexSkills(), "oneezy-brain")), false);
  });
