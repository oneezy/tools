// build: the plugin form written into the library from skills-sync.json. plugins/<id>/ per plugin (an own group or a
// source), the two root catalogs, --check as the drift gate. The library is a temp git repository; upstream is another.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

let base: string;
let root: string;
let homeDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
}

/** A temp git repository: the library itself, or a source standing in for upstream. */
class Upstream {
  constructor(public dir: string) {}
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  skill(name: string, body = "do the thing", root = "skills"): void {
    const d = path.join(this.dir, root, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", msg);
    return this.head();
  }
  head(): string {
    return this.git("rev-parse", "HEAD");
  }
}

function repo(dir: string): Upstream {
  fs.mkdirSync(dir, { recursive: true });
  const u = new Upstream(dir);
  u.git("init", "-q", "-b", "main");
  return u;
}

function json(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function read(...rel: string[]): string {
  return fs.readFileSync(path.join(root, ...rel), "utf8");
}

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

const MIT = "MIT License\n\nCopyright (c) 2026 Up\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n";

const CONFIG = () => ({
  version: 1,
  library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills" },
  sources: { up: { repo: up.dir, ref: "main", root: "skills", skills: { a: "a", b: "b", tdd: "up-tdd" }, attribution: ["LICENSE"] } },
  plugins: {
    oneezy: { displayName: "Oneezy", description: "Justin's own skills, for every harness and project on the machine.", group: "oneezy" },
    up: { displayName: "Up", description: "Up's skills, following main.", source: "up" },
  },
});

function config(c: Record<string, unknown> = CONFIG()): void {
  write("skills-sync.json", JSON.stringify(c, null, 2) + "\n");
}

/** The actions of a --json run that touch a file: neither a skip, a note nor a conflict. */
function changes(r: { stdout: string }): Array<{ kind: string; path: string; note?: string }> {
  return (JSON.parse(r.stdout).actions as Array<{ kind: string; path: string; note?: string }>).filter((a) => a.kind !== "skip" && a.kind !== "note" && a.kind !== "conflict");
}

function actions(r: { stdout: string }): Array<{ kind: string; path: string; note?: string }> {
  return JSON.parse(r.stdout).actions;
}

/** Every file under a folder, relative path with / separators -> text. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).split("\\").join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

let library: Upstream;

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-build-"));
});
after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  up = repo(path.join(base, "up"));
  up.skill("a");
  up.skill("b");
  up.skill("tdd", "red, green");
  fs.writeFileSync(path.join(up.dir, "LICENSE"), MIT);
  up.commit("one");

  library = repo(root);
  write(".gitignore", ".agents/skills/\n.claude/skills/\nupstream/\nskills-sync.local.json\n");
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine\n");
  write("skills/oneezy/own-one/agents/openai.yaml", "interface:\n  display_name: own-one\n");
  write("skills/oneezy/own-two/SKILL.md", "---\nname: own-two\ndescription: two\nmetadata:\n  author: justin\n---\ntwo\n");
  write("skills/flat-one/SKILL.md", "---\nname: flat-one\ndescription: flat\n---\nflat\n");
  config();
  assert.equal(cli("refresh", "--quiet").status, 0);
  library.commit("library");
});

test("build --plugins writes plugins/<id>/ for an own group and a refreshed source: three manifests with the version rule, skill copies marked metadata.internal (a rename keeps its new name), LICENSE from the attribution, NOTICE.md with the commit; a flat skill is not packaged; an own plugin without a library LICENSE says so", () => {
  const r = cli("build", "--plugins", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(root, "plugins")).sort(), ["oneezy", "up"]);
  assert.deepEqual(Object.keys(tree(path.join(root, "plugins", "oneezy"))), [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "NOTICE.md", "plugin.json", "skills/own-one/SKILL.md", "skills/own-one/agents/openai.yaml", "skills/own-two/SKILL.md"]);
  assert.deepEqual(Object.keys(tree(path.join(root, "plugins", "up"))), [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "LICENSE", "NOTICE.md", "plugin.json", "skills/a/SKILL.md", "skills/b/SKILL.md", "skills/up-tdd/SKILL.md"]);

  // fix d1: every copy carries metadata.internal: true; everything else byte for byte, a rename keeps its rewritten name
  assert.equal(read("plugins/oneezy/skills/own-one/SKILL.md"), "---\nname: own-one\ndescription: mine\nmetadata:\n  internal: true\n---\nmine\n");
  assert.equal(read("plugins/oneezy/skills/own-two/SKILL.md"), "---\nname: own-two\ndescription: two\nmetadata:\n  internal: true\n  author: justin\n---\ntwo\n", "inserted into the existing metadata map");
  assert.equal(read("plugins/oneezy/skills/own-one/agents/openai.yaml"), "interface:\n  display_name: own-one\n");
  assert.equal(read("plugins/up/skills/up-tdd/SKILL.md"), "---\nname: up-tdd\ndescription: tdd skill\nmetadata:\n  internal: true\n---\nred, green\n");
  assert.equal(read("plugins/up/skills/a/SKILL.md"), "---\nname: a\ndescription: a skill\nmetadata:\n  internal: true\n---\ndo the thing\n");

  // the version: 0.<commit count>.0+<sha12> of the library's HEAD
  const version = `0.${library.git("rev-list", "--count", "HEAD")}.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.match(version, /^0\.1\.0\+[0-9a-f]{12}$/);

  const portable = json(path.join(root, "plugins", "oneezy", "plugin.json"));
  assert.equal(portable.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(portable.name, "oneezy");
  assert.equal(portable.version, version);
  assert.equal(portable.description, "Justin's own skills, for every harness and project on the machine.");
  assert.deepEqual(portable.author, { name: "oneezy", url: "https://github.com/oneezy" });
  assert.equal(portable.homepage, "https://github.com/oneezy/skills");
  assert.equal(portable.repository, "https://github.com/oneezy/skills");
  assert.ok(!("license" in portable), "no LICENSE in the library: no license field");
  assert.ok(portable.keywords.includes("oneezy"));
  const iface = portable.extensions["com.openai"].interface;
  assert.equal(iface.displayName, "Oneezy");
  assert.equal(iface.shortDescription, "Justin's own skills", "the description's first clause, at most 30 characters");
  assert.equal(iface.longDescription, "Justin's own skills, for every harness and project on the machine.");
  assert.equal(iface.developerName, "oneezy");
  assert.equal(typeof iface.category, "string");
  assert.ok(Array.isArray(iface.capabilities) && iface.capabilities.length > 0);
  assert.deepEqual(Object.keys(portable), ["$schema", "name", "version", "description", "author", "homepage", "repository", "keywords", "extensions"], "only Agent Plugins 1.0 fields at the root");

  const legacy = json(path.join(root, "plugins", "oneezy", ".codex-plugin", "plugin.json"));
  assert.equal(legacy.name, "oneezy");
  assert.equal(legacy.version, version);
  assert.equal(legacy.skills, "./skills/");
  assert.deepEqual(legacy.interface, iface);
  assert.ok(!("extensions" in legacy));

  const claude = json(path.join(root, "plugins", "oneezy", ".claude-plugin", "plugin.json"));
  assert.deepEqual(claude, { name: "oneezy", displayName: "Oneezy", description: "Justin's own skills, for every harness and project on the machine.", author: { name: "oneezy", url: "https://github.com/oneezy" }, homepage: "https://github.com/oneezy/skills", repository: "https://github.com/oneezy/skills", keywords: portable.keywords }, "no version, so Claude Code tracks commits");

  // the source plugin: license from the attribution file, the upstream repo and commit in the NOTICE
  const upPortable = json(path.join(root, "plugins", "up", "plugin.json"));
  assert.equal(upPortable.license, "MIT");
  assert.equal(upPortable.extensions["com.openai"].interface.shortDescription, "Up's skills");
  assert.equal(upPortable.version, version);
  assert.equal(json(path.join(root, "plugins", "up", ".claude-plugin", "plugin.json")).license, "MIT");
  assert.equal(read("plugins/up/LICENSE"), MIT);
  const notice = read("plugins/up/NOTICE.md");
  assert.ok(notice.includes(up.dir.split("\\").join("/")) || notice.includes(up.dir), "names the source repo");
  assert.ok(notice.includes(up.head()), "names the upstream commit");
  assert.match(notice, /\d{4}-\d{2}-\d{2}/, "dates it");
  assert.ok(notice.includes("MIT"), "names the license");
  assert.ok(notice.includes("metadata.internal"), "explains the internal marker");
  assert.ok(notice.includes("tdd") && notice.includes("up-tdd"), "records the rename");
  const ownNotice = read("plugins/oneezy/NOTICE.md");
  assert.ok(ownNotice.includes(library.head()), "an own plugin records the library commit");
  assert.ok(ownNotice.includes("metadata.internal"));

  // an own plugin with no LICENSE in the library: none in the package, one reported line, still built
  assert.ok(!fs.existsSync(path.join(root, "plugins", "oneezy", "LICENSE")));
  assert.ok(actions(r).some((a) => a.kind === "note" && /LICENSE/.test(a.note ?? "") && /oneezy/.test(a.path)), `a note about the missing LICENSE: ${r.stdout}`);
  assert.ok(!JSON.stringify(tree(path.join(root, "plugins"))).includes("flat-one"), "a flat skill belongs to no plugin");
  assert.deepEqual(fs.readdirSync(homeDir), [], "nothing written outside the library");
});

test("build --catalogs writes the Claude Code catalog (name from the library's owner and name, owner, ./plugins/<id> sources with descriptions) and the Codex catalog (interface.displayName, policy AVAILABLE and ON_USE, category), in the config's order", () => {
  const r = cli("build", "--catalogs", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(root, "plugins")), "--catalogs alone builds no package");
  const claude = json(path.join(root, ".claude-plugin", "marketplace.json"));
  assert.equal(claude.name, "oneezy-skills");
  assert.deepEqual(claude.owner, { name: "oneezy" });
  assert.equal(typeof claude.description, "string");
  assert.deepEqual(claude.plugins, [
    { name: "oneezy", source: "./plugins/oneezy", description: "Justin's own skills, for every harness and project on the machine." },
    { name: "up", source: "./plugins/up", description: "Up's skills, following main." },
  ]);
  const codex = json(path.join(root, ".agents", "plugins", "marketplace.json"));
  assert.equal(codex.name, "oneezy-skills");
  assert.equal(codex.interface.displayName, "oneezy/skills");
  assert.equal(codex.plugins.length, 2);
  for (const [i, id] of ["oneezy", "up"].entries()) {
    assert.equal(codex.plugins[i].name, id);
    assert.equal(codex.plugins[i].source, `./plugins/${id}`);
    assert.deepEqual(codex.plugins[i].policy, { installation: "AVAILABLE", authentication: "ON_USE" });
    assert.equal(typeof codex.plugins[i].category, "string");
  }
  assert.deepEqual(changes(cli("build", "--catalogs", "--json")), [], "a second run changes nothing");
});

test("build is idempotent and deterministic: a second build changes nothing byte for byte; a library commit that touches no input leaves every package, its version included, as it was; editing one own skill rebuilds only its package with the new HEAD's version; a stale plugins/<id> for an id no longer in the config is removed with a report line", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const first = tree(path.join(root, "plugins"));
  const second = cli("build", "--json");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(changes(second), []);
  assert.deepEqual(tree(path.join(root, "plugins")), first);
  assert.ok(second.stdout.includes('"version": "0.1.0+'), second.stdout);

  // the build is committed; the HEAD moves; the packages' inputs did not: nothing is rewritten, the versions stay
  library.commit("built");
  assert.match(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, /^0\.1\.0\+/);
  const after = cli("build", "--json");
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(changes(after), [], "nothing to write after a commit of the build itself");
  assert.deepEqual(tree(path.join(root, "plugins")), first);
  assert.deepEqual(changes(cli("build", "--check", "--json")), [], "and --check agrees");

  // one own skill edited and committed: its package moves to the new version; the source package is untouched
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine, edited\n");
  library.commit("edit own-one");
  const edited = cli("build", "--json");
  assert.equal(edited.status, 0, edited.stderr);
  const touched = changes(edited).map((a) => path.relative(root, a.path).split("\\").join("/")).sort();
  assert.deepEqual(touched, ["plugins/oneezy/.codex-plugin/plugin.json", "plugins/oneezy/NOTICE.md", "plugins/oneezy/plugin.json", "plugins/oneezy/skills/own-one/SKILL.md"], "only the edited package, and only its files that changed");
  const version = `0.3.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, version);
  assert.equal(json(path.join(root, "plugins", "oneezy", ".codex-plugin", "plugin.json")).version, version);
  assert.match(json(path.join(root, "plugins", "up", "plugin.json")).version, /^0\.1\.0\+/, "the untouched package keeps the version it was built with");
  assert.ok(read("plugins/oneezy/NOTICE.md").includes(library.head()));
  assert.equal(read("plugins/oneezy/skills/own-one/SKILL.md"), "---\nname: own-one\ndescription: mine\nmetadata:\n  internal: true\n---\nmine, edited\n");
  assert.deepEqual(changes(cli("build", "--json")), [], "settled");

  // a removed own skill leaves its package; a package for an id dropped from the config goes
  fs.rmSync(path.join(root, "skills", "oneezy", "own-two"), { recursive: true });
  write("plugins/old/plugin.json", "{}\n");
  write("plugins/old/skills/x/SKILL.md", "---\nname: x\n---\n");
  const pruned = cli("build", "--json");
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.ok(!fs.existsSync(path.join(root, "plugins", "oneezy", "skills", "own-two")), "own-two's copy is gone");
  assert.ok(!fs.existsSync(path.join(root, "plugins", "old")), "the stale package is gone");
  assert.ok(actions(pruned).some((a) => a.kind === "delete" && a.path.endsWith("old") && /no longer in skills-sync\.json/.test(a.note ?? "")), pruned.stdout);
  assert.deepEqual(fs.readdirSync(path.join(root, "plugins")).sort(), ["oneezy", "up"]);
});

test("build --check computes every output in memory, prints each drifted path and exits 1 writing nothing: a hand edit of a plugin copy, a source skill edited after the last build, a missing catalog, a stale package; clean after a build, exit 0", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const clean = cli("build", "--check");
  assert.equal(clean.status, 0, clean.stderr + clean.stdout);
  assert.match(clean.stdout, /build --check: clean/);

  write("plugins/up/skills/a/SKILL.md", "---\nname: a\ndescription: a skill\nmetadata:\n  internal: true\n---\nhand edited\n");
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine, edited after the build\n");
  fs.rmSync(path.join(root, ".agents", "plugins", "marketplace.json"));
  write("plugins/old/plugin.json", "{}\n");
  const before = tree(root);
  assert.equal(cli("build", "--plan").status, 0);
  assert.deepEqual(tree(root), before, "--plan wrote nothing");

  const drifted = cli("build", "--check");
  assert.equal(drifted.status, 1, "drift exits 1");
  const lines = drifted.stdout.split("\n").filter((l) => l.startsWith("drift"));
  const paths = lines.map((l) => l.replace(/^drift\s+/, "").trim()).sort();
  assert.deepEqual(paths, [".agents/plugins/marketplace.json", "plugins/old", "plugins/oneezy/skills/own-one/SKILL.md", "plugins/up/skills/a/SKILL.md"]);
  assert.deepEqual(tree(root), before, "--check wrote nothing");
  const asJson = cli("build", "--check", "--json");
  assert.equal(asJson.status, 1);
  assert.deepEqual(JSON.parse(asJson.stdout).drift.sort(), paths);

  assert.equal(cli("build", "--quiet").status, 0);
  const again = cli("build", "--check");
  assert.equal(again.status, 0, again.stdout);
  assert.equal(read("plugins/up/skills/a/SKILL.md"), "---\nname: a\ndescription: a skill\nmetadata:\n  internal: true\n---\ndo the thing\n", "the hand edit was overwritten from the working set");
  assert.ok(read("plugins/oneezy/skills/own-one/SKILL.md").includes("edited after the build"));
  // --check --catalogs looks at the catalogs only
  write("plugins/up/skills/a/SKILL.md", "drifted again\n");
  assert.equal(cli("build", "--check", "--catalogs").status, 0, "catalogs are clean");
  assert.equal(cli("build", "--check", "--plugins").status, 1, "the package is not");
});

test("generate.plugins: false builds nothing and --check ignores the plugin form; --artifacts only says it is the next stage; a library without git gets version 0.0.0+nogit", () => {
  config({ ...CONFIG(), generate: { skills: true, plugins: false } });
  const off = cli("build", "--plugins", "--catalogs");
  assert.equal(off.status, 0, off.stderr);
  assert.ok(!fs.existsSync(path.join(root, "plugins")));
  assert.ok(!fs.existsSync(path.join(root, ".claude-plugin")));
  assert.ok(!fs.existsSync(path.join(root, ".agents", "plugins")));
  assert.match(off.stderr, /generate\.plugins is false/);
  write("plugins/stale/plugin.json", "{}\n");
  const check = cli("build", "--check");
  assert.equal(check.status, 0, "nothing is checked when the plugin form is off");
  assert.ok(fs.existsSync(path.join(root, "plugins", "stale", "plugin.json")), "and nothing is touched");

  config();
  const artifacts = cli("build", "--artifacts");
  assert.equal(artifacts.status, 0, artifacts.stderr);
  assert.match(artifacts.stderr, /artifacts: next stage/);
  assert.ok(!fs.existsSync(path.join(root, "artifacts")));
  assert.ok(!fs.existsSync(path.join(root, "plugins", "oneezy")), "--artifacts alone builds no package");
  assert.doesNotMatch(cli("build", "--check").stderr, /artifacts/, "--check does not mention artifacts");

  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.equal(cli("build", "--quiet").status, 0);
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, "0.0.0+nogit");
  assert.equal(json(path.join(root, "plugins", "up", ".codex-plugin", "plugin.json")).version, "0.0.0+nogit");
  assert.ok(read("plugins/oneezy/NOTICE.md").includes("not a git checkout"));
  assert.deepEqual(changes(cli("build", "--json")), [], "settled without git too");
});

test("the config schema admits a releases section (the ChatGPT upload record per plugin: plugin_id, release_id, sha256, scope, date, optional files) and nothing else inside it", async () => {
  const { shippedSchema, validate } = await import("../src/schema.js");
  const sha = "a".repeat(64);
  const releases = { oneezy: { plugin_id: "plugin_abc", release_id: "rel_1", sha256: sha, scope: "personal", date: "2026-10-01" }, up: { plugin_id: "plugin_def", release_id: "rel_2", sha256: sha, scope: "personal", date: "2026-10-01", files: ["plugin.json", "skills/a/SKILL.md"] } };
  config({ ...CONFIG(), releases });
  assert.deepEqual(validate(shippedSchema("skills-sync"), json(path.join(root, "skills-sync.json"))), []);
  assert.equal(cli("build", "--plugins", "--quiet").status, 0, "a config with releases builds");
  const bad = { ...CONFIG(), releases: { oneezy: { plugin_id: "plugin_abc", release_id: "rel_1", sha256: "nope", scope: "personal", date: "2026-10-01", extra: 1 }, up: { release_id: "rel_2" } } };
  const errors = validate(shippedSchema("skills-sync"), bad);
  assert.ok(errors.some((e) => /\$\.releases\.oneezy\.extra: not allowed/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /\$\.releases\.oneezy\.sha256: must match/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /\$\.releases\.up: missing plugin_id/.test(e)), errors.join("\n"));
  config(bad);
  const r = cli("build", "--plugins", "--quiet");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /releases\.oneezy\.extra/);
});

/** `claude` on PATH, or null: the validation test skips itself without it. */
function claudeBinary(): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] : undefined;
  return first ?? null;
}

test("claude plugin validate passes on every built package and on the library root (its marketplace); warnings allowed, no errors", { skip: claudeBinary() ? false : "claude is not on PATH" }, () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const claudeHome = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: claudeHome };
  for (const target of [".", "plugins/oneezy", "plugins/up"]) {
    const r = spawnSync(claudeBinary()!, ["plugin", "validate", target], { encoding: "utf8", cwd: root, env, timeout: 120_000 });
    assert.equal(r.status, 0, `${target}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Validation passed/, `${target}: ${r.stdout}`);
    assert.doesNotMatch(r.stdout, /error/i, `${target}: ${r.stdout}`);
  }
  assert.ok(!fs.existsSync(path.join(root, ".claude.json")), "validate wrote nothing into the library");
});
