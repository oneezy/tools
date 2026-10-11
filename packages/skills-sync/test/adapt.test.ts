// adapt: a source's find/replace rules, applied in order to the text files of its skills when build copies them into
// plugins/<id>/ (and so into every rendering made from the package), never to a script, never to the snapshot or the
// working set. What a forbid pattern still finds after the rules fails check and build --check; a rule that matches
// nothing is reported; update warns when new upstream text holds a forbidden term. Plain string rules, no model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";
import { adaptFiles, adaptProblems, compileAdapt, forbiddenIn, isAdapted } from "../src/adapt.js";
import { shippedSchema, validate } from "../src/schema.js";

let base: string;
let root: string;
let homeDir: string;
let up: Repo;
let library: Repo;

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  delete env.GITHUB_ACTIONS;
  return spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
}

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
  file(rel: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(this.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, rel), text);
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

/** Every file under a folder, relative path -> base64 bytes. */
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
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const MIT =
  'MIT License\n\nCopyright (c) 2026 Up\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction.\n';

const SKILL_A = [
  "---",
  "name: a",
  "description: Ask with AskQuestion in Cursor.",
  "---",
  "Spawn a subagent with the `Task` tool.",
  "Read .cursor/skills/foo/SKILL.md first.",
  "",
].join("\n");
const SCRIPT = "#!/bin/sh\n# Cursor only: AskQuestion\necho .cursor/skills/\n";

const RULES = [
  { find: "the `Task` tool", replace: "your subagent tool" },
  // runs after the rule above: it sees that rule's output, so order is part of the meaning
  { find: "your subagent tool", replace: "your harness's subagent tool" },
  { find: "AskQuestion", replace: "your question tool" },
  { find: "\\.cursor/skills/([a-z-]+)/", replace: "your skills folder ($1)/" },
  { find: " in cursor\\.", replace: ".", flags: "i" },
];

const CONFIG = (adapt?: Record<string, unknown>) => ({
  version: 1,
  library: { version: "0.1.0", name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" },
  renderings: { hermes: "dist/hermes" },
  sources: {
    up: {
      repo: up.dir,
      ref: "main",
      root: "skills",
      skills: "*",
      attribution: ["LICENSE"],
      ...(adapt ? { adapt } : {}),
    },
  },
  plugins: { up: { displayName: "Up", description: "Up's skills.", source: "up" } },
});

function config(adapt?: Record<string, unknown>): void {
  write("skills-sync.json", JSON.stringify(CONFIG(adapt), null, 2) + "\n");
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-adapt-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  up = new Repo(path.join(base, "up"));
  up.file("skills/a/SKILL.md", SKILL_A);
  up.file("skills/a/scripts/run.sh", SCRIPT);
  up.file("skills/a/scripts/run.py", "# AskQuestion in Cursor\n");
  up.file("skills/a/references/notes.md", "Never ask; use AskQuestion.\n");
  up.file("skills/b/SKILL.md", "---\nname: b\ndescription: b skill\n---\nplain\n");
  up.file("LICENSE", MIT);
  up.commit("one");
  library = new Repo(root);
  write(".gitignore", ".agents/skills/\nupstream/\nskills-sync.local.json\n");
  write("skills/.gitkeep", ""); // a library has a skills/ folder, here with no own skill
  config({ rules: RULES });
  const r = cli("update", "--quiet");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  library.commit("library");
});

test("rules apply in order to every text file of the source's skills as build copies them: each rule sees the one before it, $1 and flags work, the frontmatter description too; the Hermes rendering carries the same text; NOTICE.md says the copies are adapted", () => {
  const r = cli("build");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(
    read("plugins/up/skills/a/SKILL.md"),
    [
      "---",
      "name: a",
      "description: Ask with your question tool.",
      "metadata:",
      "  internal: true",
      "---",
      "Spawn a subagent with your harness's subagent tool.",
      "Read your skills folder (foo)/SKILL.md first.",
      "",
    ].join("\n"),
  );
  assert.equal(read("plugins/up/skills/a/references/notes.md"), "Never ask; use your question tool.\n");
  assert.match(read("dist/hermes/up/skills/a/SKILL.md"), /Spawn a subagent with your harness's subagent tool\./);
  assert.match(read("plugins/up/NOTICE.md"), /^- Adapted: .*5 find\/replace rules.*sources\.up\.adapt/m);
  assert.equal(
    read("plugins/up/skills/b/SKILL.md"),
    "---\nname: b\ndescription: b skill\nmetadata:\n  internal: true\n---\nplain\n",
  );
});

test("scripts, the snapshot under upstream/ and the working set are never adapted: only Markdown and text files are", () => {
  const snapshot = tree(path.join(root, "upstream"));
  const working = tree(path.join(root, ".agents", "skills"));
  assert.equal(cli("build").status, 0);
  assert.equal(read("plugins/up/skills/a/scripts/run.sh"), SCRIPT);
  assert.equal(read("plugins/up/skills/a/scripts/run.py"), "# AskQuestion in Cursor\n");
  assert.deepEqual(tree(path.join(root, "upstream")), snapshot);
  assert.deepEqual(tree(path.join(root, ".agents", "skills")), working);
  assert.equal(read("upstream/up/skills/a/SKILL.md"), SKILL_A);
  for (const rel of ["a/SKILL.md", "a/notes.md", "a/x.mdc", "a/x.markdown", "a/x.txt", "a/X.MD"])
    assert.ok(isAdapted(rel), rel);
  for (const rel of ["a/run.sh", "a/run.py", "a/run.js", "a/run.ps1", "a/x.json", "a/x.yaml", "a/LICENSE"])
    assert.ok(!isAdapted(rel), rel);
});

test("a forbid match left after the rules fails check and build --check, naming the file, the line and the term; a line an allow pattern accepts passes; plain build still writes and names it", () => {
  config({ rules: RULES, forbid: ["Cursor", "\\bTask\\b", "\\.cursor/", "AskQuestion"] });
  const built = cli("build");
  assert.equal(built.status, 0, built.stderr + built.stdout);
  assert.doesNotMatch(
    built.stdout,
    /forbidden/,
    "the rules leave none; the scripts that still say it are not looked at",
  );
  assert.equal(cli("check").status, 0);

  up.file("skills/a/SKILL.md", SKILL_A + "Cursor's docs say so (in Cursor: ~/.cursor/projects/x).\n");
  up.commit("factual line");
  assert.equal(cli("update", "--quiet").status, 0);
  const rebuilt = cli("build", "--quiet");
  assert.equal(rebuilt.status, 0, rebuilt.stdout);
  // line 7 upstream is line 9 in the package, whose SKILL.md gained metadata.internal: lines count in the file named
  assert.match(rebuilt.stdout, /forbidden +plugins\/up\/skills\/a\/SKILL\.md:9: "Cursor"/);
  const check = cli("check");
  assert.equal(check.status, 1, check.stdout);
  assert.match(check.stdout, /^plugins\/up\/skills\/a\/SKILL\.md: line 9: forbidden term "Cursor" /m);
  assert.match(check.stdout, /^plugins\/up\/skills\/a\/SKILL\.md: line 9: forbidden term "\.cursor\/" /m);
  const drift = cli("build", "--check");
  assert.equal(drift.status, 1, drift.stdout);
  assert.match(drift.stdout, /forbidden +plugins\/up\/skills\/a\/SKILL\.md:9: "Cursor"/);
  const asJson = JSON.parse(cli("build", "--check", "--json").stdout);
  assert.deepEqual(asJson.drift, []);
  assert.ok(
    asJson.forbidden.some((f: any) => f.path === "plugins/up/skills/a/SKILL.md" && f.line === 9 && f.term === "Cursor"),
  );

  // an allow pattern accepts the factual line as a whole
  config({
    rules: RULES,
    forbid: ["Cursor", "\\bTask\\b", "\\.cursor/", "AskQuestion"],
    allow: ["^Cursor's docs say so \\(in Cursor: ~/\\.cursor/projects/"],
  });
  const clean = cli("check");
  assert.equal(clean.status, 0, clean.stdout);
  assert.equal(cli("build", "--check").status, 0);
});

test("a rule that matches nothing in any file of the source is reported by build, build --check and check, as a note that never fails the run", () => {
  config({ rules: [...RULES, { find: "Cursor rules engine", replace: "rules" }] });
  const built = cli("build");
  assert.equal(built.status, 0);
  assert.match(
    built.stdout,
    /sources\.up\.adapt\.rules\[5\] \(find "Cursor rules engine"\) matches nothing in up's skills/,
  );
  const drift = cli("build", "--check");
  assert.equal(drift.status, 0, drift.stdout);
  assert.match(drift.stdout, /rules\[5\] \(find "Cursor rules engine"\) matches nothing/);
  const check = cli("check");
  assert.equal(check.status, 0, check.stdout);
  assert.match(
    check.stdout,
    /^note: skills-sync\.json: sources\.up\.adapt\.rules\[5\] \(find "Cursor rules engine"\) matches nothing/m,
  );
  assert.deepEqual(JSON.parse(cli("build", "--check", "--json").stdout).unusedRules, [
    { source: "up", rule: 5, find: "Cursor rules engine" },
  ]);
});

test("the build is deterministic: the same input gives byte-identical output, so a second build changes nothing and build --check and check stay clean", () => {
  config({ rules: RULES, forbid: ["AskQuestion"] });
  assert.equal(cli("build").status, 0);
  const first = tree(path.join(root, "plugins"));
  const hermes = tree(path.join(root, "dist"));
  const again = cli("build", "--json");
  assert.equal(again.status, 0);
  assert.deepEqual(
    JSON.parse(again.stdout).actions.filter((a: any) => a.kind !== "skip"),
    [],
    "nothing to write the second time",
  );
  assert.deepEqual(tree(path.join(root, "plugins")), first);
  assert.deepEqual(tree(path.join(root, "dist")), hermes);
  assert.equal(cli("build", "--check").status, 0);
  const check = cli("check");
  assert.equal(check.status, 0, check.stdout);
  // the pure transform gives the same bytes every time, rule counts included
  const files = new Map([["SKILL.md", Buffer.from(SKILL_A)]]);
  const c = compileAdapt({ rules: RULES });
  assert.ok(c.ok);
  const one = adaptFiles(files, c.compiled);
  const two = adaptFiles(files, c.compiled);
  assert.deepEqual([...one.files], [...two.files]);
  assert.deepEqual(one.counts, [1, 1, 1, 1, 1]);
});

test("without adapt the package is byte for byte what it was: no NOTICE line, the copies as upstream wrote them", () => {
  config();
  assert.equal(cli("build").status, 0);
  assert.equal(read("plugins/up/skills/a/references/notes.md"), "Never ask; use AskQuestion.\n");
  assert.doesNotMatch(read("plugins/up/NOTICE.md"), /Adapted/);
});

test("update warns, never fails, when a forbidden term is in new upstream text after the rules, and names a rule that no longer matches; text it has seen before is not named again", () => {
  config({ rules: RULES, forbid: ["Cursor", "AskQuestion"] });
  library.commit("adapt");
  up.file("skills/b/SKILL.md", "---\nname: b\ndescription: b skill\n---\nOpen the Cursor settings.\n");
  up.commit("cursor text");
  const r = cli("update", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /up: forbidden term left after the adapt rules in new upstream text: b\/SKILL\.md:5 "Cursor"/);
  assert.deepEqual(JSON.parse(r.stdout).forbidden, ["up:b/SKILL.md:5: Cursor"]);
  const quiet = cli("update", "--quiet");
  assert.equal(quiet.status, 0);
  assert.doesNotMatch(quiet.stderr, /forbidden term/, "the text is no longer new");

  config({ rules: [{ find: "Cursor rules engine", replace: "rules" }] });
  up.file("skills/b/SKILL.md", "---\nname: b\ndescription: b skill\n---\nplain again\n");
  up.commit("plain");
  const stale = cli("update", "--quiet");
  assert.equal(stale.status, 0);
  assert.match(stale.stderr, /up: adapt rule rules\[0\] \(find "Cursor rules engine"\) matches nothing upstream/);
});

test("the schema takes adapt on a source (rules of find, replace and flags; forbid; allow) and refuses anything else; a pattern that is not a regular expression is a check problem and a package that cannot be built", () => {
  const schema = shippedSchema("skills-sync");
  const with_ = (adapt: unknown) => ({
    version: 1,
    sources: { up: { repo: "o/r", ref: "main", skills: "*", adapt } },
  });
  assert.deepEqual(
    validate(schema, with_({ rules: [{ find: "a", replace: "b", flags: "im" }], forbid: ["x"], allow: ["y"] })),
    [],
  );
  assert.ok(validate(schema, with_({ rules: [{ find: "a" }] })).length, "replace is required");
  assert.ok(validate(schema, with_({ rules: [{ find: "a", replace: "b", flags: "x" }] })).length, "unknown flag");
  assert.ok(validate(schema, with_({ rules: [{ find: "", replace: "b" }] })).length, "an empty find");
  assert.ok(validate(schema, with_({ other: [] })).length, "unknown key");

  assert.deepEqual(adaptProblems({ up: { rules: [{ find: "(", replace: "" }], forbid: ["["] } }).length, 2);
  config({ rules: [{ find: "(", replace: "x" }] });
  const check = cli("check");
  assert.equal(check.status, 1);
  assert.match(check.stdout, /^skills-sync\.json: sources\.up\.adapt\.rules\[0\]\.find: not a regular expression/m);
  const built = cli("build");
  assert.equal(built.status, 1);
  assert.match(built.stdout, /sources\.up\.adapt\.rules\[0\]\.find: not a regular expression/);

  // forbiddenIn on its own: line numbers from 1, every match, the allow list by line
  const c = compileAdapt({ forbid: ["Cursor"], allow: ["^ok:"] });
  assert.ok(c.ok);
  assert.deepEqual(forbiddenIn("one\nCursor and Cursor\nok: Cursor\n", c.compiled), [
    { line: 2, term: "Cursor", pattern: "Cursor" },
  ]);
});
