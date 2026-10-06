// build: the plugin form written into the library from skills-sync.json. plugins/<id>/ per plugin (an own group or a
// source), the two root catalogs, --check as the drift gate. The library is a temp git repository; upstream is another.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";
import { pathToFileURL } from "node:url";

let base: string;
let root: string;
let homeDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];

/** Run the CLI against the temp library, home redirected into the temp folder, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return cliIn(root, ...args);
}

/** The same against another library folder: a fresh repo, a clone. */
function cliIn(repo: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", repo], { encoding: "utf8", cwd: repo, env });
}

/** The drift list of a --check --json run, sorted. */
function drift(r: { stdout: string }): string[] {
  return (JSON.parse(r.stdout).drift as string[]).sort();
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

/** The repository holds that commit object: false in a clone that never fetched it. */
function holds(dir: string, commit: string): boolean {
  return spawnSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`], { encoding: "utf8" }).status === 0;
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

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-build-"));
});
afterAll(() => {
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

  // the version of a new package: 0.1.0+<sha12> of the library's HEAD
  const version = `0.1.0+${library.git("rev-parse", "--short=12", "HEAD")}`;

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

test("build is idempotent and deterministic: a second build changes nothing byte for byte; a library commit that touches no input leaves every package, its version included, as it was; editing one own skill rebuilds only its package with the next version at the new HEAD's sha; a stale plugins/<id> for an id no longer in the config is removed with a report line", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const first = tree(path.join(root, "plugins"));
  const second = cli("build", "--json");
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(changes(second), []);
  assert.deepEqual(tree(path.join(root, "plugins")), first);
  assert.match(JSON.parse(second.stdout).versions.oneezy, /^0\.1\.0\+[0-9a-f]{12}$/, second.stdout);

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
  const version = `0.2.0+${library.git("rev-parse", "--short=12", "HEAD")}`;
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, version, "the next minor after 0.1.0, whatever the commit count");
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
  // a changed package takes the next version, so its two versioned manifests drift with the files that changed
  assert.deepEqual(paths, [".agents/plugins/marketplace.json", "plugins/old", "plugins/oneezy/.codex-plugin/plugin.json", "plugins/oneezy/plugin.json", "plugins/oneezy/skills/own-one/SKILL.md", "plugins/up/.codex-plugin/plugin.json", "plugins/up/plugin.json", "plugins/up/skills/a/SKILL.md"]);
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

test("generate.plugins: false builds nothing and --check ignores the plugin form; a build with no output named writes packages and catalogs and no archive; a library without git gets version 0.0.0+nogit, its archives too", () => {
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
  assert.equal(cli("build", "--quiet").status, 0);
  assert.ok(fs.existsSync(path.join(root, "plugins", "oneezy", "plugin.json")) && fs.existsSync(path.join(root, ".claude-plugin", "marketplace.json")));
  assert.ok(!fs.existsSync(path.join(root, "artifacts")), "a build with no output named writes the committed form only: no archive");

  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  assert.equal(cli("build", "--quiet").status, 0);
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, "0.0.0+nogit");
  assert.equal(json(path.join(root, "plugins", "up", ".codex-plugin", "plugin.json")).version, "0.0.0+nogit");
  assert.ok(read("plugins/oneezy/NOTICE.md").includes("not a git checkout"));
  assert.deepEqual(changes(cli("build", "--json")), [], "settled without git too");
  // the archives carry the same version; an own plugin has no commit to record, a source plugin still has upstream's
  assert.equal(cli("build", "--artifacts", "--quiet").status, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "artifacts")).sort(), ["oneezy-0.0.0+nogit.zip", "releases.json", "up-0.0.0+nogit.zip"]);
  const record = json(path.join(root, "artifacts", "releases.json")).plugins;
  assert.equal(record.oneezy.commit, null);
  assert.equal(record.up.commit, up.head());
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

test("a prior version is believed only when the package agrees with itself and with every commit the repository holds: a version and a NOTICE naming different commits, a NOTICE naming another real commit or the wrong date are all drift, and build rebuilds that package with the next version at HEAD while the untouched source package keeps its own; the minor is not a commit count, so any minor with the right commit is believed", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const c1 = library.head();
  const c2 = library.commit("built");
  assert.equal(cli("build", "--check").status, 0, "verified: the repository holds c1 and the NOTICE names it with its date");
  const short = (c: string) => library.git("rev-parse", "--short=12", c);
  // the NOTICE spells UTC as Z whatever git printed (git < 2.45 prints +00:00)
  const date = (c: string) => library.git("log", "-1", "--format=%cI", c).replace(/[+-]00:00$/, "Z");
  const manifests = ["plugins/oneezy/.codex-plugin/plugin.json", "plugins/oneezy/NOTICE.md", "plugins/oneezy/plugin.json"];
  const built = tree(path.join(root, "plugins", "oneezy"));
  const tamper = (version: string, commit: string, when: string) => {
    for (const f of ["plugin.json", ".codex-plugin/plugin.json"]) write(`plugins/oneezy/${f}`, built[f].replace(/"version": "[^"]+"/, `"version": "${version}"`));
    write("plugins/oneezy/NOTICE.md", built["NOTICE.md"].replace(/^- Commit: .*$/m, `- Commit: ${commit} (${when})`));
  };
  // well-formed, the version naming one commit and the NOTICE another
  tamper("0.999.0+abcdefabcdef", "0".repeat(40), "1999-01-01T00:00:00+00:00");
  let r = cli("build", "--check", "--json");
  assert.equal(r.status, 1);
  assert.deepEqual(drift(r), manifests);
  // a commit the repository holds with another minor: believed, the minor counts builds of the package, not commits
  tamper(`0.7.0+${short(c1)}`, c1, date(c1));
  r = cli("build", "--check", "--json");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(drift(r), []);
  // the version it was built with, the NOTICE naming another real commit: the manifests differ from a build at HEAD (the NOTICE happens to match one)
  tamper(`0.1.0+${short(c1)}`, c2, date(c2));
  r = cli("build", "--check", "--json");
  assert.equal(r.status, 1);
  assert.deepEqual(drift(r), ["plugins/oneezy/.codex-plugin/plugin.json", "plugins/oneezy/plugin.json"]);
  // the right version and commit, the wrong date
  tamper(`0.1.0+${short(c1)}`, c1, "1999-01-01T00:00:00+00:00");
  r = cli("build", "--check", "--json");
  assert.equal(r.status, 1);
  assert.deepEqual(drift(r), manifests);
  // build treats the package as changed: the next minor after the one on disk (0.1.0) at HEAD; the source package stays at the version it was built with
  const rebuilt = cli("build", "--json");
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.deepEqual(changes(rebuilt).map((a) => path.relative(root, a.path).split("\\").join("/")).sort(), manifests);
  const version = `0.2.0+${short(c2)}`;
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, version);
  assert.equal(json(path.join(root, "plugins", "oneezy", ".codex-plugin", "plugin.json")).version, version);
  assert.ok(read("plugins/oneezy/NOTICE.md").includes(`- Commit: ${c2} (${date(c2)})`));
  assert.match(json(path.join(root, "plugins", "up", "plugin.json")).version, /^0\.1\.0\+/);
  assert.equal(cli("build", "--check").status, 0);
});

test("a package built on a branch is as built after the branch is squash-merged: the commit its version names is in nobody's history on the target branch, and build --check, check and build agree there, in the repository that still holds the branch and in a fresh clone that never had its commits", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  library.commit("built");
  library.git("checkout", "-q", "-b", "feature/x");
  // a long branch: a commit count would put the package far ahead of where the squash leaves main's count
  for (let i = 0; i < 4; i++) {
    write(`notes-${i}.md`, `${i}\n`);
    library.commit(`note ${i}`);
  }
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine, edited on a branch\n");
  const onBranch = library.commit("edit own-one");
  assert.equal(cli("build", "--quiet").status, 0);
  const version = `0.2.0+${library.git("rev-parse", "--short=12", onBranch)}`;
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, version);
  library.commit("built on the branch");
  assert.equal(cli("build", "--check").status, 0, "clean on the branch");
  const built = tree(path.join(root, "plugins"));

  library.git("checkout", "-q", "main");
  library.git("merge", "-q", "--squash", "feature/x");
  library.commit("edit own-one (#1)");
  assert.equal(library.git("rev-list", "--count", "HEAD"), "3", "library, built, the squash");
  assert.equal(spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", onBranch, "HEAD"]).status, 1, "the commit the package was built at is not in main's history");
  assert.deepEqual(tree(path.join(root, "plugins")), built, "the squash landed the packages as the branch built them");
  const check = cli("build", "--check");
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /build --check: clean/);
  const whole = cli("check");
  assert.equal(whole.status, 0, whole.stdout);
  assert.deepEqual(changes(cli("build", "--json")), [], "nothing rewritten");
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, version, "the version it was built with, the branch's commit");
  assert.ok(read("plugins/oneezy/NOTICE.md").includes(`- Commit: ${onBranch} (`));

  // the next change on main, whose count (3) is below the branch's (7): the version still goes up, never back
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine, edited on main\n");
  library.commit("edit own-one on main");
  assert.equal(library.git("rev-list", "--count", "HEAD"), "4");
  assert.equal(cli("build", "--quiet").status, 0);
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, `0.3.0+${library.git("rev-parse", "--short=12", "HEAD")}`);
  library.git("checkout", "-q", "--", ".");
  library.git("reset", "-q", "--hard", "HEAD~1");

  // what CI checks out: main alone, over the transport, so the branch's commits are not there at all
  const clone = path.join(base, "clone");
  library.git("clone", "-q", "--single-branch", "--branch", "main", pathToFileURL(root).href, clone);
  assert.ok(!holds(clone, onBranch), "the clone never had the branch's commits");
  assert.equal(cliIn(clone, "refresh", "--frozen", "--quiet").status, 0, "the snapshot and working set from the lock");
  const cloned = cliIn(clone, "build", "--check");
  assert.equal(cloned.status, 0, cloned.stdout);
  assert.match(cloned.stdout, /build --check: clean/);
  const clonedWhole = cliIn(clone, "check");
  assert.equal(clonedWhole.status, 0, clonedWhole.stdout);
  assert.deepEqual(changes(cliIn(clone, "build", "--json")), [], "nothing rewritten there either");
  assert.equal(new Upstream(clone).git("status", "--porcelain"), "");
});

test("a shallow clone is as built: at depth 1 (what actions/checkout fetches) it holds none of the commits the versions name, at depth 2 one of them, and build --check, check and build are clean in both; a package that changed there builds, the next version at the clone's HEAD, because no version comes from history", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const c1 = library.head();
  library.commit("built");
  write("skills/oneezy/own-one/SKILL.md", "---\nname: own-one\ndescription: mine\n---\nmine, edited\n");
  const c3 = library.commit("edit own-one");
  assert.equal(cli("build", "--quiet").status, 0);
  library.commit("rebuilt");
  assert.equal(json(path.join(root, "plugins", "oneezy", "plugin.json")).version, `0.2.0+${library.git("rev-parse", "--short=12", c3)}`);
  assert.equal(json(path.join(root, "plugins", "up", "plugin.json")).version, `0.1.0+${library.git("rev-parse", "--short=12", c1)}`);

  for (const depth of [1, 2]) {
    const clone = path.join(base, `shallow-${depth}`);
    library.git("clone", "-q", "--depth", String(depth), pathToFileURL(root).href, clone);
    const at = new Upstream(clone);
    assert.equal(at.git("rev-parse", "--is-shallow-repository"), "true");
    assert.ok(!holds(clone, c1), "the commit the source package was built at is not there");
    assert.equal(holds(clone, c3), depth === 2, "the commit the own package was built at is there at depth 2 only");
    assert.equal(cliIn(clone, "refresh", "--frozen", "--quiet").status, 0, "the snapshot and working set from the lock");
    const check = cliIn(clone, "build", "--check");
    assert.equal(check.status, 0, `depth ${depth}: ${check.stdout}`);
    assert.match(check.stdout, /build --check: clean/);
    const whole = cliIn(clone, "check");
    assert.equal(whole.status, 0, `depth ${depth}: ${whole.stdout}`);
    assert.deepEqual(changes(cliIn(clone, "build", "--json")), [], `depth ${depth}: nothing rewritten`);
    assert.equal(at.git("status", "--porcelain"), "");
  }

  // a package whose inputs changed takes the next version at the clone's HEAD; the shallow history does not matter
  const clone = path.join(base, "shallow-1");
  const at = new Upstream(clone);
  fs.writeFileSync(path.join(clone, "skills", "oneezy", "own-two", "SKILL.md"), "---\nname: own-two\ndescription: two\n---\ntwo, edited in the shallow clone\n");
  const drifted = cliIn(clone, "build", "--check", "--json");
  assert.equal(drifted.status, 1);
  assert.deepEqual(drift(drifted), ["plugins/oneezy/.codex-plugin/plugin.json", "plugins/oneezy/NOTICE.md", "plugins/oneezy/plugin.json", "plugins/oneezy/skills/own-two/SKILL.md"]);
  const built = cliIn(clone, "build", "--json");
  assert.equal(built.status, 0, built.stderr + built.stdout);
  assert.equal(json(path.join(clone, "plugins", "oneezy", "plugin.json")).version, `0.3.0+${at.git("rev-parse", "--short=12", "HEAD")}`);
  assert.match(json(path.join(clone, "plugins", "up", "plugin.json")).version, /^0\.1\.0\+/, "the untouched package keeps its own");
  assert.equal(cliIn(clone, "build", "--check").status, 0);
});

test("a checkout without a commit yet builds 0.0.0+nogit and its NOTICE says so; after the first commit that prior is not believed: build gives the package the real version and --check agrees", () => {
  const fresh = repo(path.join(base, "fresh"));
  fs.mkdirSync(path.join(fresh.dir, "skills", "grp", "one"), { recursive: true });
  fs.writeFileSync(path.join(fresh.dir, "skills", "grp", "one", "SKILL.md"), "---\nname: one\ndescription: one\n---\none\n");
  fs.writeFileSync(path.join(fresh.dir, "skills-sync.json"), JSON.stringify({ version: 1, library: { name: "fresh", owner: "t" }, sources: {}, plugins: { grp: { displayName: "Grp", group: "grp" } } }, null, 2) + "\n");
  const manifest = path.join(fresh.dir, "plugins", "grp", "plugin.json");
  const notice = () => fs.readFileSync(path.join(fresh.dir, "plugins", "grp", "NOTICE.md"), "utf8");
  assert.equal(cliIn(fresh.dir, "build", "--quiet").status, 0);
  assert.equal(json(manifest).version, "0.0.0+nogit");
  assert.match(notice(), /^- Commit: a git checkout without a commit yet$/m);
  assert.deepEqual(changes(cliIn(fresh.dir, "build", "--json")), [], "settled before the first commit");
  fresh.commit("one");
  const check = cliIn(fresh.dir, "build", "--check", "--json");
  assert.equal(check.status, 1, "0.0.0+nogit is no longer what a build would write");
  assert.deepEqual(drift(check), ["plugins/grp/.codex-plugin/plugin.json", "plugins/grp/NOTICE.md", "plugins/grp/plugin.json"]);
  assert.equal(cliIn(fresh.dir, "build", "--quiet").status, 0);
  const version = `0.1.0+${fresh.git("rev-parse", "--short=12", "HEAD")}`;
  assert.equal(json(manifest).version, version);
  assert.equal(json(path.join(fresh.dir, "plugins", "grp", ".codex-plugin", "plugin.json")).version, version);
  assert.ok(notice().includes(`- Commit: ${fresh.head()} (`));
  assert.equal(cliIn(fresh.dir, "build", "--check").status, 0);
});

test("a play group with skills is packaged and cataloged exactly like oneezy: the same files in plugins/play as in plugins/oneezy, its skill copies marked internal, its NOTICE naming skills/play, an entry in both catalogs; build --check and check are clean", () => {
  config({ ...CONFIG(), plugins: { ...CONFIG().plugins, play: { displayName: "Play", description: "Justin's playground.", group: "play" } } });
  write("skills/play/play-unslop/SKILL.md", "---\nname: play-unslop\ndescription: unslop\n---\nunslop\n");
  write("skills/play/play-unslop/agents/openai.yaml", "interface:\n  display_name: play-unslop\n");
  write("skills/oneezy/own-two/agents/openai.yaml", "interface:\n  display_name: own-two\n");
  write("LICENSE", MIT);
  library.commit("playground");
  const r = cli("build", "--json");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const shape = (id: string, skill: string) => Object.keys(tree(path.join(root, "plugins", id))).filter((f) => !f.startsWith("skills/") || f.startsWith(`skills/${skill}/`)).map((f) => f.replace(`skills/${skill}/`, "skills/<skill>/")).sort();
  assert.deepEqual(shape("play", "play-unslop"), shape("oneezy", "own-two"));
  assert.match(read("plugins", "play", "skills", "play-unslop", "SKILL.md"), /metadata:\n  internal: true\n/);
  assert.match(read("plugins", "play", "NOTICE.md"), /^- Source: `skills\/play` of oneezy\/skills/m);
  assert.match(read("plugins", "play", "NOTICE.md"), /^- Skills: play-unslop$/m);
  assert.equal(json(path.join(root, "plugins", "play", "plugin.json")).version, json(path.join(root, "plugins", "oneezy", "plugin.json")).version, "both new at the same HEAD");
  for (const catalog of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    assert.deepEqual(json(path.join(root, catalog)).plugins.map((p: { name: string }) => p.name), ["oneezy", "up", "play"], catalog);
  }
  assert.equal(cli("build", "--check").status, 0);
  assert.equal(cli("check").status, 0);
});

test("a group declared as a plugin but holding no skills yet is skipped with one note, exit 0: build writes no package and no catalog entry for it, build --check and check are clean and print the note; once it has a skill it is built, and when its last skill goes its package and catalog entries go too", () => {
  const withPlay = () => config({ ...CONFIG(), plugins: { ...CONFIG().plugins, play: { displayName: "Play", description: "Justin's playground.", group: "play" } } });
  withPlay();
  const NOTE = "no skills under skills/play yet; not built, not cataloged";
  const r = cli("build", "--json");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const about = actions(r).filter((a) => a.path.split(path.sep).join("/").endsWith("plugins/play"));
  assert.deepEqual(about.map((a) => [a.kind, a.note]), [["note", NOTE]], "one note, nothing else about plugins/play");
  assert.ok(!fs.existsSync(path.join(root, "plugins", "play")));
  for (const catalog of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
    assert.deepEqual(json(path.join(root, catalog)).plugins.map((p: { name: string }) => p.name), ["oneezy", "up"], catalog);
  }
  library.commit("empty playground");
  const buildCheck = cli("build", "--check");
  assert.equal(buildCheck.status, 0, buildCheck.stdout);
  assert.equal(buildCheck.stdout.split("\n").filter((l) => l.includes(NOTE)).length, 1, buildCheck.stdout);
  assert.match(buildCheck.stdout, /^build --check: clean\b/m);
  const check = cli("check");
  assert.equal(check.status, 0, check.stdout);
  assert.deepEqual(check.stdout.split("\n").filter((l) => l && !l.startsWith("check:")), [`note: plugins/play: ${NOTE}`]);
  assert.deepEqual(JSON.parse(cli("check", "--json").stdout).notes, [{ path: "plugins/play", reason: NOTE }]);

  // a first skill: built and cataloged; the last one gone: package and catalog entries removed, the note again
  write("skills/play/play-unslop/SKILL.md", "---\nname: play-unslop\ndescription: unslop\n---\nunslop\n");
  assert.equal(cli("build", "--quiet").status, 0);
  assert.ok(fs.existsSync(path.join(root, "plugins", "play", "skills", "play-unslop", "SKILL.md")));
  assert.ok(json(path.join(root, ".claude-plugin", "marketplace.json")).plugins.some((p: { name: string }) => p.name === "play"));
  library.commit("first play skill");
  fs.rmSync(path.join(root, "skills", "play"), { recursive: true });
  const stale = cli("check");
  assert.equal(stale.status, 1, "the committed package is drift once its group is empty");
  assert.ok(stale.stdout.includes(`plugins/play: ${NOTE}; build would remove it`), stale.stdout);
  const emptied = cli("build", "--json");
  assert.equal(emptied.status, 0, emptied.stdout);
  assert.deepEqual(actions(emptied).filter((a) => a.path.split(path.sep).join("/").endsWith("plugins/play")).map((a) => [a.kind, a.note]), [["delete", NOTE]], "one line: the removal, with the reason");
  assert.ok(!fs.existsSync(path.join(root, "plugins", "play")));
  assert.deepEqual(json(path.join(root, ".claude-plugin", "marketplace.json")).plugins.map((p: { name: string }) => p.name), ["oneezy", "up"]);
  assert.equal(cli("check").status, 0);
});

test("a package that cannot be built is a conflict that fails the run: a source not in the config, a source without a snapshot (a clone before refresh); build leaves plugins/<id> alone and exits 1, build --check lists plugins/<id> as drift and exits 1", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  config({ ...CONFIG(), plugins: { ...CONFIG().plugins, src: { displayName: "Src", source: "nosrc" } } });
  write("plugins/src/plugin.json", "{}\n");
  const check = cli("build", "--check");
  assert.equal(check.status, 1);
  assert.match(check.stdout, /source nosrc is not in skills-sync\.json/);
  assert.match(check.stdout, /1 conflict\(s\) above to fix first/);
  const paths = check.stdout.split("\n").filter((l) => l.startsWith("drift")).map((l) => l.replace(/^drift\s+/, "").trim()).sort();
  assert.deepEqual(paths, [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", "plugins/src"], "the catalogs gained an entry; the package cannot be built");
  const r = cli("build", "--json");
  assert.equal(r.status, 1, "a conflict fails build too");
  assert.equal(actions(r).filter((a) => a.kind === "conflict").length, 1);
  assert.equal(read("plugins/src/plugin.json"), "{}\n", "whatever plugins/src holds is left alone");
  assert.ok(fs.existsSync(path.join(root, "plugins", "up", "plugin.json")), "the other packages are built");
  // the clone-before-refresh shape: the source is in the config, its snapshot is not there
  config();
  assert.equal(cli("build", "--quiet").status, 0, "back to the two plugins; plugins/src goes as a stale id");
  assert.ok(!fs.existsSync(path.join(root, "plugins", "src")));
  fs.rmSync(path.join(root, "upstream"), { recursive: true });
  const noSnapshot = cli("build", "--check", "--json");
  assert.equal(noSnapshot.status, 1);
  assert.deepEqual(drift(noSnapshot), ["plugins/up"]);
  assert.ok(actions(noSnapshot).some((a) => a.kind === "conflict" && /no snapshot under upstream\/up/.test(a.note ?? "")), noSnapshot.stdout);
  const built = tree(path.join(root, "plugins", "up"));
  assert.equal(cli("build").status, 1);
  assert.deepEqual(tree(path.join(root, "plugins", "up")), built, "the committed package is never deleted for want of a snapshot");
});

test("a clone that git converts to CRLF on checkout (core.autocrlf=true) is as built: build --check is clean, build rewrites nothing and git sees nothing to commit; a real edit there still drifts", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  library.commit("built");
  const clone = path.join(base, "clone");
  library.git("clone", "-q", "-c", "core.autocrlf=true", root, clone);
  const at = new Upstream(clone);
  const eol = at.git("ls-files", "--eol").split(/\r?\n/).filter((l) => /plugins\/|marketplace\.json/.test(l));
  assert.ok(eol.length > 10 && eol.every((l) => /^i\/lf\s+w\/crlf/.test(l)), eol.join("\n"));
  assert.equal(cliIn(clone, "refresh", "--frozen", "--quiet").status, 0, "the snapshot and working set from the lock");
  const check = cliIn(clone, "build", "--check");
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /build --check: clean/);
  assert.deepEqual(changes(cliIn(clone, "build", "--json")), [], "nothing rewritten");
  assert.equal(at.git("status", "--porcelain"), "");
  fs.writeFileSync(path.join(clone, "plugins", "up", "skills", "a", "SKILL.md"), "---\r\nname: a\r\ndescription: a skill\r\nmetadata:\r\n  internal: true\r\n---\r\nhand edited\r\n");
  const edited = cliIn(clone, "build", "--check", "--json");
  assert.equal(edited.status, 1);
  assert.deepEqual(drift(edited), ["plugins/up/.codex-plugin/plugin.json", "plugins/up/plugin.json", "plugins/up/skills/a/SKILL.md"], "the edited package counts as changed, so it would take the clone's HEAD version too");
});

test("build never follows a link: a junction or symlink inside plugins/<id>, or plugins/<id> itself as one, is a conflict that fails the run, the package is left alone and the source is never written through; --check lists the link; a link inside a source skill folder is not copied, with a note", () => {
  assert.equal(cli("build", "--quiet").status, 0);
  const link = path.join(root, "plugins", "oneezy", "skills", "own-one");
  fs.rmSync(link, { recursive: true });
  fs.symlinkSync(path.join(root, "skills", "oneezy", "own-one"), link, "junction");
  const source = tree(path.join(root, "skills"));
  const check = cli("build", "--check", "--json");
  assert.equal(check.status, 1);
  assert.deepEqual(drift(check), ["plugins/oneezy/skills/own-one"]);
  const r = cli("build", "--json");
  assert.equal(r.status, 1);
  assert.ok(actions(r).some((a) => a.kind === "conflict" && a.path === link && /never follows/.test(a.note ?? "")), r.stdout);
  assert.deepEqual(tree(path.join(root, "skills")), source, "no source file was written through the link");
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "the link is still there");
  fs.rmSync(link);
  assert.equal(cli("build", "--quiet").status, 0, "with the link gone the package is rebuilt");
  assert.equal(read("plugins/oneezy/skills/own-one/SKILL.md"), "---\nname: own-one\ndescription: mine\nmetadata:\n  internal: true\n---\nmine\n");
  assert.equal(cli("build", "--check").status, 0);
  // the package folder itself as a link
  const pkg = path.join(root, "plugins", "up");
  fs.rmSync(pkg, { recursive: true });
  fs.symlinkSync(path.join(root, ".agents", "skills"), pkg, "junction");
  const whole = cli("build", "--check", "--json");
  assert.equal(whole.status, 1);
  assert.deepEqual(drift(whole), ["plugins/up"]);
  assert.equal(cli("build").status, 1);
  assert.ok(fs.lstatSync(pkg).isSymbolicLink(), "left alone");
  fs.rmSync(pkg);
  // a link inside a source skill folder: not copied, one note, the package builds
  const inside = path.join(root, "skills", "oneezy", "own-two", "linked");
  fs.symlinkSync(path.join(root, "skills", "flat-one"), inside, "junction");
  const noted = cli("build", "--json");
  assert.equal(noted.status, 0, noted.stderr);
  assert.ok(actions(noted).some((a) => a.kind === "note" && a.path === inside && /not copied/.test(a.note ?? "")), noted.stdout);
  assert.ok(!fs.existsSync(path.join(root, "plugins", "oneezy", "skills", "own-two", "linked")));
  assert.equal(cli("build", "--check").status, 0);
  fs.rmSync(inside);
});

/** `claude` on PATH, or null: the validation test skips itself without it. */
function claudeBinary(): string | null {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["claude"], { encoding: "utf8" });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] : undefined;
  return first ?? null;
}

test.skipIf(!claudeBinary())("claude plugin validate passes on every built package and on the library root (its marketplace); warnings allowed, no errors", () => {
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

test("commit dates are written one way whatever git printed: UTC as Z (git 2.45 and later) and +00:00 (older git) give the same NOTICE date; other offsets are kept", async () => {
  const { isoDate } = await import("../src/build.js");
  assert.equal(isoDate("2026-10-01T17:03:05+00:00"), "2026-10-01T17:03:05Z");
  assert.equal(isoDate("2026-10-01T17:03:05Z"), "2026-10-01T17:03:05Z");
  assert.equal(isoDate("2026-10-01T17:03:05-00:00"), "2026-10-01T17:03:05Z");
  assert.equal(isoDate("2026-10-01T03:04:36-05:00"), "2026-10-01T03:04:36-05:00");
  assert.equal(isoDate("2026-09-29T13:37:40+01:00"), "2026-09-29T13:37:40+01:00");
  assert.equal(isoDate(null), null);
});

test("a changed package's version is the next minor after the one on disk, never a commit count: 1 for a new package or one whose version is not of the rule, with HEAD's sha; without a commit, 0.0.0+nogit", async () => {
  const { bump } = await import("../src/build.js");
  const head = { version: "0.1.0+abcdefabcdef", commit: "abcdefabcdef" + "0".repeat(28), date: "2026-10-05T00:00:00Z", checkout: true, shallow: false };
  assert.equal(bump("0.25.0+d5b0644567db", head), "0.26.0+abcdefabcdef");
  assert.equal(bump("0.9.0+0123456789ab", head), "0.10.0+abcdefabcdef");
  assert.equal(bump(undefined, head), "0.1.0+abcdefabcdef");
  assert.equal(bump("1.2.3", head), "0.1.0+abcdefabcdef");
  assert.equal(bump("0.0.0+nogit", head), "0.1.0+abcdefabcdef");
  assert.equal(bump("0.3.0+abcdefabcdef", { ...head, commit: null, version: "0.0.0+nogit" }), "0.0.0+nogit");
});
