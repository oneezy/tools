// check: what is committed is consistent. Every own skill's frontmatter, every flow.yaml beside one against the shipped
// flow schema, and generated-file drift (the plugin form, the catalogs, the lock the snapshots give). One line per
// problem with its path and reason; exit 1 on any, 0 when clean. The library is a temp git repository; so is upstream.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let base: string;
let root: string;
let homeDir: string;
let up: Repo;
let library: Repo;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
/** The eight flow.yaml files of oneezy/skills (feature/skills-sync-migration at 69c0434), copied as they are. */
const FLOWS = path.resolve(import.meta.dirname, "..", "..", "test", "fixtures", "flows");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
}

/** A temp git repository: the library itself, or a source standing in for upstream. */
class Repo {
  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", msg);
    return this.git("rev-parse", "HEAD");
  }
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function skillMd(name: string, description = `${name} skill`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
}

/** Every file under a folder, relative path with / separators -> bytes as base64, so a binary file compares too. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split("\\").join("/")] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(dir);
  return out;
}

/** The problem lines of a check run: everything on stdout but the summary. */
function problems(r: { stdout: string }): string[] {
  return r.stdout.split("\n").filter((l) => l && !l.startsWith("check:"));
}

const FLOW = (skill: string, steps: string) => `skill: ${skill}\npurpose: Do one thing.\nruntime: [git]\nrefs: []\nunresolved: []\nagents:\n  max: 0\nsteps:\n${steps}`;

const CONFIG = () => ({
  version: 1,
  library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" },
  sources: { up: { repo: up.dir, ref: "main", root: "skills", skills: ["a", "b"], attribution: ["LICENSE"] } },
  plugins: {
    oneezy: { displayName: "Oneezy", description: "Justin's own skills.", group: "oneezy" },
    up: { displayName: "Up", description: "Up's skills, following main.", source: "up" },
  },
});

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-check-"));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  up = new Repo(path.join(base, "up"));
  for (const n of ["a", "b"]) {
    fs.mkdirSync(path.join(up.dir, "skills", n), { recursive: true });
    fs.writeFileSync(path.join(up.dir, "skills", n, "SKILL.md"), skillMd(n));
  }
  fs.writeFileSync(path.join(up.dir, "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person\n");
  up.commit("one");

  // a clean library: a group of two own skills (one with a flow), a flat one, a refreshed source, the plugin form built
  library = new Repo(root);
  write(".gitignore", ".agents/skills/\n.claude/skills/\nupstream/\nartifacts/\nskills-sync.local.json\n");
  write("skills/oneezy/own-one/SKILL.md", skillMd("own-one"));
  write("skills/oneezy/own-one/flow.yaml", FLOW("own-one", "  - id: first\n    does: the first thing\n    outcome: { done: it is done }\n  - id: second\n    after: first\n    does: the second thing\n"));
  write("skills/oneezy/own-two/SKILL.md", skillMd("own-two"));
  write("skills/flat-one/SKILL.md", skillMd("flat-one"));
  write("skills-sync.json", JSON.stringify(CONFIG(), null, 2) + "\n");
  assert.equal(cli("refresh", "--quiet").status, 0);
  library.commit("library");
  assert.equal(cli("build", "--quiet").status, 0);
  library.commit("built");
});

test("check exits 0 on a clean library and says what it looked at, writing nothing; a frontmatter name that differs from its folder, a name that is not a valid id, a missing description and a SKILL.md without frontmatter each fail with the file and the reason, exit 1", () => {
  const before = tree(root);
  const clean = cli("check");
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.deepEqual(problems(clean), []);
  assert.match(clean.stdout, /^check: clean, 3 own skills, 1 flow\b/m);
  assert.deepEqual(tree(root), before, "check wrote nothing");
  assert.deepEqual(fs.readdirSync(homeDir), [], "and nothing outside the library");

  write("skills/oneezy/own-one/SKILL.md", skillMd("own-1"));
  write("skills/oneezy/own-two/SKILL.md", "---\nname: own-two\n---\nno description\n");
  write("skills/flat-one/SKILL.md", "no frontmatter at all\n");
  write("skills/oneezy/Bad_Name/SKILL.md", skillMd("Bad_Name"));
  write("skills/oneezy/quoted/SKILL.md", '---\nname: quoted\ndescription: "never closed\n---\nbody\n');
  const bad = cli("check");
  assert.equal(bad.status, 1);
  const lines = problems(bad).filter((l) => l.startsWith("skills/"));
  assert.deepEqual(lines.slice(0, 4), [
    "skills/oneezy/Bad_Name/SKILL.md: name: Bad_Name is not a valid skill id (lowercase letters, digits and single hyphens, at most 64 characters)",
    "skills/flat-one/SKILL.md: no frontmatter: name and description are required",
    "skills/oneezy/own-one/SKILL.md: name: own-1 is not the folder's name, own-one",
    "skills/oneezy/own-two/SKILL.md: description: missing",
  ]);
  assert.equal(lines.length, 5);
  assert.match(lines[4], /^skills\/oneezy\/quoted\/SKILL\.md: frontmatter is not YAML \([^)]+\)$/);
  assert.match(bad.stdout, /^check: \d+ problems?\b/m);
});

test("the eight real flow.yaml files of oneezy/skills (six under skills/oneezy, two under skills/trident) pass the shipped flow schema and the id rules as they are", () => {
  const groups = fs.readdirSync(FLOWS);
  assert.deepEqual(groups.sort(), ["oneezy", "trident"]);
  let copied = 0;
  for (const g of groups) {
    for (const skill of fs.readdirSync(path.join(FLOWS, g))) {
      write(`skills/${g}/${skill}/SKILL.md`, skillMd(skill));
      write(`skills/${g}/${skill}/flow.yaml`, fs.readFileSync(path.join(FLOWS, g, skill, "flow.yaml"), "utf8"));
      copied++;
    }
  }
  assert.equal(copied, 8);
  assert.equal(cli("build", "--quiet").status, 0, "the plugin form follows the new skills");
  const r = cli("check");
  assert.deepEqual(problems(r), []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^check: clean, 11 own skills, 9 flows\b/m);
});

test("a flow.yaml that breaks a rule fails with its path and the rule: a duplicate step id, an after naming an unknown step (alone or in a list), a loop without until, skill not the folder's name, an outcome key other than done, fail, input, a need or kind outside the taxonomy, parallel without join or naming unknown steps, an unknown key, a missing purpose, a file that is not YAML; need: mention, a parallel group with its join, and a loop with until and every pass", () => {
  const flow = (rel: string, text: string) => {
    write(`skills/oneezy/${rel}/SKILL.md`, skillMd(rel));
    write(`skills/oneezy/${rel}/flow.yaml`, text);
  };
  const step = (id: string, rest = "") => `  - id: ${id}\n    does: ${id}\n${rest}`;
  flow("dup", FLOW("dup", step("one") + step("two", "    after: one\n") + step("one", "    after: two\n")));
  flow("after", FLOW("after", step("one") + step("two", "    after: nope\n") + step("three", "    after: [one, gone]\n")));
  flow("loop", FLOW("loop", step("one", "    loop: { every: 90s }\n")));
  flow("folder", FLOW("another", step("one")));
  flow("outcome", FLOW("outcome", step("one", "    outcome: { done: yes it is, maybe: who knows }\n")));
  flow("refs", FLOW("refs", step("one")).replace("refs: []", "refs:\n  - { token: /x, kind: skill, id: x, need: sometimes }\n  - { token: y, kind: thing, id: y, need: required }\n  - { token: /z, kind: skill, need: optional }"));
  flow("fan", FLOW("fan", step("one", "    parallel: [two, three]\n") + step("two") + step("four", "    parallel: [two, nope]\n    join: gone\n")));
  flow("extra", FLOW("extra", step("one", "    retries: 3\n")).replace("purpose: Do one thing.\n", "") + "notes: free\n");
  flow("broken", "skill: broken\nsteps: [\n");
  flow("good", FLOW("good", step("fan", "    parallel: [left, right]\n    join: meet\n") + step("left", "    after: fan\n") + step("right", "    after: fan\n") + step("meet", "    after: [left, right]\n    loop: { until: both are in, every: 90s }\n    calls: { skill: own-one }\n    returns: the two results\n    needs: [git]\n    if: there is something to wait for\n    outcome: { done: met, fail: one never came → stop, input: a human picks one }\n")).replace("refs: []", "refs:\n  - { token: /own-one, kind: skill, id: own-one, need: mention, when: named only }"));

  const r = cli("check");
  assert.equal(r.status, 1);
  const lines = problems(r).filter((l) => l.startsWith("skills/"));
  assert.deepEqual(lines, [
    "skills/oneezy/after/flow.yaml: $.steps[1].after: no step has the id nope",
    "skills/oneezy/after/flow.yaml: $.steps[2].after[1]: no step has the id gone",
    "skills/oneezy/broken/flow.yaml: not YAML (Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1)",
    "skills/oneezy/dup/flow.yaml: $.steps[2].id: one is already the id of steps[0]",
    "skills/oneezy/extra/flow.yaml: $: missing purpose",
    "skills/oneezy/extra/flow.yaml: $.steps[0].retries: not allowed",
    "skills/oneezy/extra/flow.yaml: $.notes: not allowed",
    "skills/oneezy/fan/flow.yaml: $.steps[0]: parallel needs join",
    "skills/oneezy/fan/flow.yaml: $.steps[0].parallel[1]: no step has the id three",
    "skills/oneezy/fan/flow.yaml: $.steps[2].parallel[1]: no step has the id nope",
    "skills/oneezy/fan/flow.yaml: $.steps[2].join: no step has the id gone",
    "skills/oneezy/folder/flow.yaml: $.skill: another is not the folder's name, folder",
    "skills/oneezy/loop/flow.yaml: $.steps[0].loop: missing until",
    "skills/oneezy/outcome/flow.yaml: $.steps[0].outcome.maybe: not allowed",
    'skills/oneezy/refs/flow.yaml: $.refs[0].need: must be one of "required", "optional", "conditional", "example", "mention"',
    'skills/oneezy/refs/flow.yaml: $.refs[1].kind: must be one of "skill", "plugin", "app", "file", "url"',
    "skills/oneezy/refs/flow.yaml: $.refs[2]: missing id",
  ]);
  assert.ok(!r.stdout.includes("skills/oneezy/good/flow.yaml"), "the good flow has no line");
  const asJson = JSON.parse(cli("check", "--json").stdout);
  assert.equal(asJson.flows, 11);
  assert.ok(asJson.problems.some((p: { path: string; reason: string }) => p.path === "skills/oneezy/loop/flow.yaml" && p.reason === "$.steps[0].loop: missing until"), "--json carries the same problems as path and reason");
});

test("check fails on generated-file drift, the computation of build --check: a hand-edited plugin copy, a missing catalog, a stale package, a package that cannot be built, each with its path and reason; artifacts/ is never drift; with generate.plugins false the plugin form is ignored", () => {
  write("artifacts/anything.zip", "not looked at");
  assert.equal(cli("check").status, 0, "artifacts/ is not part of the drift");
  assert.match(cli("check").stdout, /^check: clean, 3 own skills, 1 flow, 17 generated files as built$/m);

  write("plugins/up/skills/a/SKILL.md", "---\nname: a\ndescription: a skill\nmetadata:\n  internal: true\n---\nhand edited\n");
  fs.rmSync(path.join(root, ".agents", "plugins", "marketplace.json"));
  write("plugins/old/plugin.json", "{}\n");
  const config = CONFIG();
  write("skills-sync.json", JSON.stringify({ ...config, plugins: { ...config.plugins, ghost: { displayName: "Ghost", group: "nope" } } }, null, 2) + "\n");
  const before = tree(root);
  const r = cli("check");
  assert.equal(r.status, 1);
  assert.deepEqual(problems(r), [
    "plugins/up/.codex-plugin/plugin.json: differs from what build would write",
    "plugins/up/plugin.json: differs from what build would write",
    "plugins/up/skills/a/SKILL.md: differs from what build would write",
    "plugins/ghost: no own skills under skills/nope; package not built",
    "plugins/old: no longer in skills-sync.json; build would remove it",
    ".claude-plugin/marketplace.json: differs from what build would write",
    ".agents/plugins/marketplace.json: missing; build would write it",
  ]);
  assert.match(r.stdout, /^check: 7 problems; build --plugins --catalogs writes the plugin form$/m);
  assert.deepEqual(tree(root), before, "check wrote nothing");
  // the same paths build --check lists
  const drift = (JSON.parse(cli("build", "--check", "--json").stdout).drift as string[]).sort();
  assert.deepEqual(problems(r).map((l) => l.split(": ")[0]).sort(), drift);

  // the plugin form switched off: none of it is checked
  write("skills-sync.json", JSON.stringify({ ...config, generate: { skills: true, plugins: false } }, null, 2) + "\n");
  const off = cli("check");
  assert.equal(off.status, 0, off.stdout);
  assert.deepEqual(problems(off), []);

  // a config the schema refuses is one problem per rule, on the config
  write("skills-sync.json", JSON.stringify({ ...config, surprise: true }, null, 2) + "\n");
  const invalid = cli("check");
  assert.equal(invalid.status, 1);
  assert.deepEqual(problems(invalid), ["skills-sync.json: $.surprise: not allowed"]);
});

test("check fails when skills-lock.json is not what refresh would write from the snapshots under upstream/: a hand-edited hash, an entry no source selects, a missing lock; a snapshot edited after the refresh is caught the same way; without snapshots (a clone before refresh) the lock is not checked; no network either way", () => {
  const lockText = read("skills-lock.json");
  const lock = JSON.parse(lockText);
  lock.skills.a.computedHash = "0".repeat(64);
  lock.skills.stale = { source: "someone/else", sourceType: "github", skillPath: "skills/stale/SKILL.md", computedHash: "1".repeat(64) };
  write("skills-lock.json", JSON.stringify(lock, null, 2) + "\n");
  const before = tree(root);
  const r = cli("check");
  assert.equal(r.status, 1);
  assert.deepEqual(problems(r), ["skills-lock.json: differs from what refresh would write from the snapshots under upstream/ (a, stale)"]);
  assert.match(r.stdout, /^check: 1 problem; refresh writes skills-lock\.json$/m);
  assert.deepEqual(tree(root), before, "check wrote nothing");

  // without the lock nothing says which working-set copy is the source's, so its package cannot be built either
  fs.rmSync(path.join(root, "skills-lock.json"));
  assert.deepEqual(problems(cli("check")), [
    "plugins/up: none of up's skills is in the working set; run refresh; package not built",
    "skills-lock.json: missing; refresh would write it from the snapshots under upstream/ (a, b)",
  ]);

  // the committed lock back, a snapshot file edited: the lock no longer matches the snapshot it was written from
  write("skills-lock.json", lockText);
  assert.equal(cli("check").status, 0);
  write("upstream/up/skills/b/SKILL.md", skillMd("b", "edited in the snapshot"));
  assert.deepEqual(problems(cli("check")), ["skills-lock.json: differs from what refresh would write from the snapshots under upstream/ (b)"]);

  // no snapshot at all, the plugin form off (a clone before refresh, where build --check could not run): the lock is left unchecked
  fs.rmSync(path.join(root, "upstream"), { recursive: true });
  write("skills-lock.json", JSON.stringify(lock, null, 2) + "\n");
  write("skills-sync.json", JSON.stringify({ ...CONFIG(), generate: { skills: true, plugins: false } }, null, 2) + "\n");
  // an unreachable source proves nothing is fetched: check never resolves a ref
  fs.rmSync(up.dir, { recursive: true, force: true });
  const clone = cli("check");
  assert.equal(clone.status, 0, clone.stdout);
  assert.match(clone.stdout, /^check: clean, 3 own skills, 1 flow, 0 generated files as built$/m);
});
