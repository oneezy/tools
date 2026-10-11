// pluginDependency, the resolver migrate-aliases uses (aliases.ts) to accept a plugin's copy of a skill in place of a
// historical alias: the built copy must match the own skill file for file, the plugin must be installed from the
// library's own catalog, enabled, at the built version, and the harness must show it loading the skill; the one approved
// foreign alias target is bypassed, nothing else. The fake codex or claude on PATH stands in for the harness; the library
// is a temp folder with its plugin form laid down by hand.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test, vi } from "vite-plus/test";
import { withInternal } from "../src/build.js";
import { makeLink } from "../src/fs.js";
import { harnessTable } from "../src/harnesses.js";
import { pluginDependency } from "../src/install.js";
import { Library } from "../src/library.js";
import type { Action } from "../src/plan.js";
import { codexPluginEnabled, destroy, pretendMachine, skillMd, write, type PretendMachine } from "./machine.js";

const machines: PretendMachine[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const m of machines.splice(0)) destroy(m);
});

const BUILT_VERSION = "0.1.0+aaaaaaaaaaaa";
const SKILLS = ["oneezy-merge", "oneezy-status"];

/** A library under the machine: one own group (oneezy) built into the plugin form by hand, both catalogs naming it. */
function library(m: PretendMachine): Library {
  const root = path.join(m.base, "skills");
  for (const s of SKILLS) write(path.join(root, "skills", "oneezy", s, "SKILL.md"), skillMd(s));
  write(
    path.join(root, "skills-sync.json"),
    JSON.stringify({ version: 1, library: { owner: "oneezy", name: "skills" } }),
  );
  write(path.join(root, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }));
  const dir = path.join(root, "plugins", "oneezy");
  write(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "oneezy" }));
  write(
    path.join(dir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "oneezy", version: BUILT_VERSION, skills: "./skills/" }),
  );
  for (const s of SKILLS) write(path.join(dir, "skills", s, "SKILL.md"), withInternal(skillMd(s)));
  const plugins = [{ name: "oneezy", source: "./plugins/oneezy" }];
  write(path.join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "oneezy-skills", plugins }));
  write(path.join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "oneezy-skills", plugins }));
  return new Library(root);
}

/** The fake codex with the library's marketplace registered from the checkout itself and its plugin installed, enabled. */
function installedFromLibrary(m: PretendMachine, lib: Library): void {
  write(
    path.join(m.codexHome, "fake-harness.json"),
    JSON.stringify(
      {
        marketplaces: { "oneezy-skills": lib.root },
        plugins: {
          "oneezy@oneezy-skills": {
            version: BUILT_VERSION,
            enabled: true,
            dir: path.join(lib.root, "plugins", "oneezy"),
            skills: SKILLS,
          },
        },
      },
      null,
      2,
    ),
  );
}

test("the resolver behind migrate-aliases accepts a plugin's copy of a skill only when every file matches, the plugin is the library's, enabled and shown loading the skill; the one approved foreign alias target is bypassed, nothing else", () => {
  const m = pretendMachine({ harnesses: ["codex"], clis: ["codex"] });
  machines.push(m);
  const lib = library(m);
  const own = path.join(lib.root, "skills", "oneezy", "oneezy-status");
  const built = path.join(lib.root, "plugins", "oneezy", "skills", "oneezy-status");
  write(path.join(own, "references", "status.md"), "current report rules");
  write(path.join(built, "references", "status.md"), "current report rules");
  installedFromLibrary(m, lib);
  // the fake codex on PATH and the machine's folders, as the resolver reads them from the process environment
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  vi.stubEnv(pathKey, m.bin + path.delimiter + (process.env[pathKey] ?? ""));
  for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "FAKE_HARNESS_LOG"]) vi.stubEnv(k, m.env[k]);
  const host = harnessTable(m.home, m.env).find((h) => h.id === "codex")!;
  // the historical alias: a link in Codex's user skills folder to a folder outside any library
  const old = path.join(m.base, "legacy", "oneezy-status");
  write(path.join(old, "SKILL.md"), skillMd("oneezy-status"));
  makeLink(old, path.join(host.userSkills, "oneezy-status"));
  const required = ["references/status.md"];
  const resolve = (expected?: string, onFailure?: (d: NonNullable<Action["diagnostic"]>) => void) =>
    pluginDependency(lib, host, "oneezy-status", required, false, expected, onFailure);
  // a loose link that is not the approved target blocks the plugin route; so does a wrong approved target
  assert.equal(resolve(), null);
  assert.equal(resolve(path.join(m.base, "wrong")), null);
  // the approved one is bypassed: the plugin's copy is accepted, at the built folder codex shows loading
  assert.equal(resolve(old), built);
  // codex cannot show the skill loading: null, with the CLI's own diagnostic
  vi.stubEnv("FAKE_HARNESS_FAIL_PROMPT", "codex");
  const failures: NonNullable<Action["diagnostic"]>[] = [];
  assert.equal(
    resolve(old, (d) => failures.push(d)),
    null,
  );
  assert.equal(failures[0]?.exitCode, 1);
  assert.deepEqual(failures[0]?.command.slice(-2), ["debug", "prompt-input"]);
  assert.match(failures[0]?.stderr ?? "", /fixture prompt inventory failed/);
  vi.stubEnv("FAKE_HARNESS_FAIL_PROMPT", "");
  // one file of the copy differs from the own skill's: null
  write(path.join(built, "references", "status.md"), "wrong cache");
  assert.equal(resolve(old), null);
  write(path.join(built, "references", "status.md"), "current report rules");
  assert.equal(resolve(old), built);
  // the plugin disabled: null
  codexPluginEnabled(m, "oneezy@oneezy-skills", false);
  assert.equal(resolve(old), null);
});

test("on Claude Code the resolver accepts the plugin's copy only when claude details the plugin with the skill and the folder claude reads it from matches file for file; a disabled plugin is refused though claude still details it", () => {
  const m = pretendMachine({ harnesses: ["claude-code"], clis: ["claude"] });
  machines.push(m);
  const lib = library(m);
  const own = path.join(lib.root, "skills", "oneezy", "oneezy-status");
  const pluginDir = path.join(lib.root, "plugins", "oneezy");
  const built = path.join(pluginDir, "skills", "oneezy-status");
  write(path.join(own, "references", "status.md"), "current report rules");
  write(path.join(built, "references", "status.md"), "current report rules");
  // a checkout: claude's cached copy of a directory marketplace's plugin counts at the checkout's HEAD only
  const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", lib.root];
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "library"],
  ])
    assert.equal(spawnSync("git", [...GIT, ...args]).status, 0, args.join(" "));
  const head = spawnSync("git", [...GIT, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).stdout.trim();
  /** The fake claude's state: the library's marketplace registered from the checkout, its plugin installed. */
  const claude = (plugin: { version: string; enabled: boolean; dir: string }) =>
    write(
      path.join(m.claudeHome, "fake-harness.json"),
      JSON.stringify(
        {
          marketplaces: { "oneezy-skills": lib.root },
          plugins: { "oneezy@oneezy-skills": { ...plugin, skills: SKILLS } },
        },
        null,
        2,
      ),
    );
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  vi.stubEnv(pathKey, m.bin + path.delimiter + (process.env[pathKey] ?? ""));
  for (const k of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "FAKE_HARNESS_LOG"]) vi.stubEnv(k, m.env[k]);
  const host = harnessTable(m.home, m.env).find((h) => h.id === "claude-code")!;
  const resolve = () => pluginDependency(lib, host, "oneezy-status", ["references/status.md"], false);
  // read in place from the library's built folder, enabled, claude details it with the skill: the built folder
  claude({ version: "unknown", enabled: true, dir: pluginDir });
  assert.equal(resolve(), built);
  // claude details the plugin without the skill: null
  vi.stubEnv("FAKE_HARNESS_BROKEN", "claude");
  assert.equal(resolve(), null);
  vi.stubEnv("FAKE_HARNESS_BROKEN", "");
  // disabled: null, though every file matches and claude details it all the same
  claude({ version: "unknown", enabled: false, dir: pluginDir });
  assert.equal(resolve(), null);
  // a cached copy at the checkout's HEAD: accepted at the copy's own folder, only while every file of it matches
  const cache = path.join(m.claudeHome, "plugins", "cache", "oneezy-skills", "oneezy", head);
  fs.cpSync(pluginDir, cache, { recursive: true });
  vi.stubEnv("FAKE_HARNESS_CACHE", "1");
  claude({ version: head, enabled: true, dir: cache });
  assert.equal(resolve(), path.join(cache, "skills", "oneezy-status"));
  write(path.join(cache, "skills", "oneezy-status", "references", "status.md"), "an older cache");
  assert.equal(resolve(), null);
});
