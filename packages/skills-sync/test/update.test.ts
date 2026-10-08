// update: move the named sources (all when none is named) to latest, to the version skills-sync.json holds them at, or
// --to a version, previous or latest; every other source stays exactly where the lock has it. The tool never writes
// skills-sync.json: a --to prints the config change the caller lands. versions lists what a source has released.
// Upstreams are temp git repositories with release tags or a versioned manifest, and a CHANGELOG.md the update report reads.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, test } from "vite-plus/test";

let base: string;
let root: string;
let homeDir: string;
let tmpDir: string;
let up: Upstream;

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const HARNESS_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "HERMES_HOME"] as const;
const GIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
const LOCK = "skills-sync.lock.json";

/** Run the CLI against the temp library, home and temp folder redirected, every harness override dropped. */
function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPDIR: tmpDir,
  };
  for (const k of HARNESS_ENV) delete env[k];
  return spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
}

/** A temp git repository standing in for a source. */
class Upstream {
  constructor(public dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    const r = spawnSync("git", [...GIT, "-C", this.dir, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  skill(name: string, body = "do the thing", at = "skills"): void {
    this.file(`${at}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  }
  file(rel: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(this.dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(this.dir, rel), text);
  }
  commit(msg: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", msg);
    return this.head();
  }
  head(): string {
    return this.git("rev-parse", "HEAD");
  }
  date(commit = "HEAD"): string {
    return this.git("log", "-1", "--format=%cI", commit);
  }
  tag(name: string, annotated = false): void {
    if (annotated) this.git("tag", "-a", name, "-m", name);
    else this.git("tag", name);
  }
}

function json(rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
}

function config(sources: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(root, "skills-sync.json"),
    JSON.stringify({ version: 1, generate: { skills: true, plugins: false }, sources, plugins: {} }, null, 2) + "\n",
  );
}

function source(u: Upstream, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repo: u.dir, ref: "main", root: "skills", skills: ["a", "b"], ...extra };
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-update-"));
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});
beforeEach(() => {
  for (const n of fs.readdirSync(base)) fs.rmSync(path.join(base, n), { recursive: true, force: true });
  root = path.join(base, "dev", "skills");
  fs.mkdirSync(path.join(root, "skills", "oneezy", "own-one"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "skills", "oneezy", "own-one", "SKILL.md"),
    "---\nname: own-one\ndescription: mine\n---\nmine\n",
  );
  homeDir = path.join(base, "home");
  fs.mkdirSync(homeDir);
  tmpDir = path.join(base, "tmp");
  fs.mkdirSync(tmpDir);
  up = new Upstream(path.join(base, "up"));
  up.skill("a");
  up.skill("b");
  up.skill("c");
  up.commit("one");
});

function text(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Every skill a with a body naming the release, tagged: v1.0.0, v1.1.0, v1.2.0 (annotated), then one commit past it. */
function releases(u: Upstream): Record<string, string> {
  const at: Record<string, string> = {};
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
    u.skill("a", `release ${v}`);
    at[v] = u.commit(v);
    u.tag(`v${v}`, v === "1.2.0");
  }
  u.skill("b", "past 1.2.0");
  at.tip = u.commit("past");
  return at;
}

function working(name: string): string {
  return text(path.join(".agents", "skills", name, "SKILL.md"));
}

test("update <source> moves only that source to the tip of its ref; every other source's lock entry stays byte for byte; skills-sync.json is never written; refresh is the same command for every source", () => {
  const other = new Upstream(path.join(base, "other"));
  other.skill("a", "other one");
  other.commit("one");
  config({ up: source(up), other: source(other, { skills: { a: "other-a" } }) });
  assert.equal(cli("refresh", "--quiet").status, 0);
  const before = json(LOCK);
  const cfg = text("skills-sync.json");

  up.skill("a", "up two");
  const two = up.commit("two");
  other.skill("a", "other two");
  other.commit("two");
  const r = cli("update", "up", "--json");
  assert.equal(r.status, 0, r.stderr);
  const after = json(LOCK);
  assert.equal(after.sources.up.commit, two);
  assert.deepEqual(after.sources.other, before.sources.other, "not named: untouched");
  assert.ok(working("a").includes("up two"));
  assert.ok(working("other-a").includes("other one"), "the other source's working copy stays at its locked commit");
  assert.equal(text("skills-sync.json"), cfg);

  const all = cli("refresh", "--quiet");
  assert.equal(all.status, 0, all.stderr);
  assert.ok(working("other-a").includes("other two"), "refresh (no source named) moves every source");
  assert.equal(text("skills-sync.json"), cfg);
});

test("a version held in skills-sync.json (the schema admits it) is where update takes that source: the release tag's commit, not the tip, while an unheld source moves to latest; a plain sync after an upstream commit installs exactly what the lock says", () => {
  const at = releases(up);
  const other = new Upstream(path.join(base, "other"));
  other.skill("a", "other one");
  other.commit("one");
  config({ up: source(up, { version: "1.1.0" }), other: source(other, { skills: { a: "other-a" } }) });
  const cfg = text("skills-sync.json");
  const r = cli("update", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json(LOCK).sources.up.commit, at["1.1.0"]);
  assert.equal(json(LOCK).sources.up.version, "1.1.0");
  assert.ok(working("a").includes("release 1.1.0"));
  assert.equal(text("skills-sync.json"), cfg);

  other.skill("a", "other two");
  const two = other.commit("two");
  const again = cli("update");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(json(LOCK).sources.up.commit, at["1.1.0"], "held");
  assert.equal(json(LOCK).sources.other.commit, two, "unheld: latest");

  up.skill("a", "past everything");
  up.commit("later");
  const lock = text(LOCK);
  const sync = cli("--quiet", "--no-pull", "--no-projects", "--no-wsl", "--no-global", "--agents", "claude-code");
  assert.equal(sync.status, 0, sync.stderr);
  assert.ok(working("a").includes("release 1.1.0"), "frozen at the lock");
  assert.equal(text(LOCK), lock);
});

test("update <source> --to: a version takes its tag's commit, previous the next lower stable release than the lock's, latest the tip of ref; each reports the move from and to (version, commit, commits past it) and prints the config change to land, never writing skills-sync.json", () => {
  const at = releases(up);
  up.tag("v2.0.0-rc.1");
  config({ up: source(up) });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.up.commit, at.tip);
  const cfg = text("skills-sync.json");

  const exact = cli("update", "up", "--to", "1.0.0", "--json");
  assert.equal(exact.status, 0, exact.stderr);
  const out = JSON.parse(exact.stdout);
  assert.deepEqual(out.updated, [
    {
      id: "up",
      from: { version: "1.2.0", commit: at.tip, ahead: 1 },
      to: { version: "1.0.0", commit: at["1.0.0"], ahead: 0 },
      direction: "downgrade",
      changelog: null,
      changelogReason: "no CHANGELOG.md upstream",
    },
  ]);
  assert.deepEqual(out.config, [{ source: "up", version: "1.0.0" }]);
  assert.equal(json(LOCK).sources.up.commit, at["1.0.0"]);
  assert.equal(json(LOCK).sources.up.version, "1.0.0");
  assert.ok(working("a").includes("release 1.0.0"));
  assert.equal(text("skills-sync.json"), cfg);

  // the caller lands the hold; previous goes below what the lock has
  config({ up: source(up, { version: "1.0.0" }) });
  const held = text("skills-sync.json");
  assert.equal(cli("update", "up", "--to", "1.2.0", "--quiet").status, 0);
  const prev = cli("update", "up", "--to", "previous");
  assert.equal(prev.status, 0, prev.stderr);
  assert.equal(json(LOCK).sources.up.commit, at["1.1.0"]);
  assert.ok(
    prev.stdout.includes(`updated up: 1.2.0 ${at["1.2.0"].slice(0, 7)} -> 1.1.0 ${at["1.1.0"].slice(0, 7)}\n`),
    prev.stdout,
  );
  assert.ok(prev.stdout.includes(`skills-sync.json: sources.up.version = "1.1.0"`), prev.stdout);
  assert.equal(text("skills-sync.json"), held);

  const latest = cli("update", "up", "--to", "latest");
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(json(LOCK).sources.up.commit, at.tip, "the tip of ref, past the held version");
  assert.ok(
    latest.stdout.includes(`updated up: 1.1.0 ${at["1.1.0"].slice(0, 7)} -> 1.2.0 (+1 commit) ${at.tip.slice(0, 7)}\n`),
    latest.stdout,
  );
  assert.ok(latest.stdout.includes("skills-sync.json: remove sources.up.version"), latest.stdout);
  assert.equal(text("skills-sync.json"), held);
});

test("a source versioned by its manifest (no tags): --to a version takes the newest commit on ref's history whose manifest carried it, previous the newest commit carrying the next lower distinct version, a held version likewise", () => {
  const ps = new Upstream(path.join(base, "plugins"));
  const manifest = (version: string, description = "pstack") =>
    ps.file(
      "pstack/.cursor-plugin/plugin.json",
      JSON.stringify({ name: "pstack", description, version }, null, 2) + "\n",
    );
  const at: Record<string, string> = {};
  ps.skill("a", "one", "pstack/skills");
  manifest("0.15.8");
  ps.commit("0.15.8");
  ps.skill("a", "last of 0.15.8", "pstack/skills");
  at["0.15.8"] = ps.commit("a two");
  manifest("0.15.9");
  ps.commit("0.15.9");
  ps.skill("a", "three", "pstack/skills");
  ps.commit("a three");
  manifest("0.15.9", "described");
  ps.commit("describe");
  ps.skill("a", "last of 0.15.9", "pstack/skills");
  at["0.15.9"] = ps.commit("a four");
  manifest("0.15.10");
  ps.commit("0.15.10");
  ps.skill("a", "tip", "pstack/skills");
  at.tip = ps.commit("a five");
  config({ pstack: { repo: ps.dir, ref: "main", root: "pstack/skills", skills: ["a"] } });
  assert.equal(cli("update", "--quiet").status, 0);
  const cfg = text("skills-sync.json");

  const nine = cli("update", "pstack", "--to", "0.15.9", "--json");
  assert.equal(nine.status, 0, nine.stderr);
  assert.deepEqual(JSON.parse(nine.stdout).updated, [
    {
      id: "pstack",
      from: { version: "0.15.10", commit: at.tip, ahead: 1 },
      to: { version: "0.15.9", commit: at["0.15.9"], ahead: 3 },
      direction: "downgrade",
      changelog: null,
      changelogReason: "no CHANGELOG.md upstream",
    },
  ]);
  assert.deepEqual(JSON.parse(nine.stdout).config, [{ source: "pstack", version: "0.15.9" }]);
  assert.ok(working("a").includes("last of 0.15.9"));

  const prev = cli("update", "pstack", "--to", "previous", "--json");
  assert.equal(prev.status, 0, prev.stderr);
  assert.equal(json(LOCK).sources.pstack.commit, at["0.15.8"]);
  assert.equal(json(LOCK).sources.pstack.version, "0.15.8");
  assert.equal(text("skills-sync.json"), cfg);

  config({ pstack: { repo: ps.dir, ref: "main", root: "pstack/skills", skills: ["a"], version: "0.15.9" } });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.pstack.commit, at["0.15.9"], "held by its manifest version");
});

test("versions <source> lists the releases newest first with the lock's one marked (and how far past it the lock is); --json gives the same structurally; it writes nothing", () => {
  const at = releases(up);
  up.tag("v2.0.0-rc.1");
  up.git("tag", "up@1.1.0", at["1.1.0"]);
  config({ up: source(up) });
  assert.equal(cli("update", "up", "--to", "1.1.0", "--quiet").status, 0);
  const lock = text(LOCK);

  const r = cli("versions", "up");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter((l) => /^[* ] \d/.test(l));
  assert.deepEqual(
    lines.map((l) => l.split(/\s+/).slice(0, 3).join(" ")),
    [
      `  1.2.0 ${at["1.2.0"].slice(0, 7)}`,
      `* 1.1.0 ${at["1.1.0"].slice(0, 7)}`,
      `  1.0.0 ${at["1.0.0"].slice(0, 7)}`,
    ].map((l) => l.split(/\s+/).slice(0, 3).join(" ")),
  );
  assert.match(lines[1], /current/);

  const j = cli("versions", "up", "--json");
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout);
  assert.equal(out.source, "up");
  assert.deepEqual(out.current, { version: "1.1.0", commit: at["1.1.0"], ahead: 0 });
  assert.deepEqual(
    out.versions.map((v: { version: string; commit: string; current: boolean }) => [v.version, v.commit, v.current]),
    [
      ["1.2.0", at["1.2.0"], false],
      ["1.1.0", at["1.1.0"], true],
      ["1.0.0", at["1.0.0"], false],
    ],
  );
  assert.ok(out.versions.every((v: { date: string }) => /^\d{4}-\d\d-\d\d/.test(v.date)));
  assert.equal(text(LOCK), lock, "versions writes nothing");

  assert.equal(cli("update", "up", "--to", "latest", "--quiet").status, 0);
  const tip = JSON.parse(cli("versions", "up", "--json").stdout);
  assert.deepEqual(tip.current, { version: "1.2.0", commit: at.tip, ahead: 1 });
  assert.match(cli("versions", "up").stdout, /^\* 1\.2\.0 .*\+1 commit/m);
  assert.equal(cli("versions").status, 1, "which source?");
  assert.equal(cli("versions", "nope").status, 1);
});

test("update refuses, writing nothing and exiting non-zero: a version the source has not released (listing the ones it has, newest first), previous below the lowest release, --to without a source or with two, a source not in the config", () => {
  releases(up);
  const other = new Upstream(path.join(base, "other"));
  other.skill("a");
  other.commit("one");
  config({ up: source(up), other: source(other, { skills: { a: "other-a" } }) });
  assert.equal(cli("update", "up", "--to", "1.0.0", "--quiet").status, 0);
  const lock = text(LOCK);
  const cfg = text("skills-sync.json");
  const copy = working("a");
  up.skill("a", "moved on");
  up.commit("moved");

  const unknown = cli("update", "up", "--to", "1.5.0");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /up: 1\.5\.0 is not a release \(versions: 1\.2\.0, 1\.1\.0, 1\.0\.0\); nothing written/);
  const json_ = cli("update", "up", "--to", "1.5.0", "--json");
  assert.equal(json_.status, 1);
  assert.match(JSON.parse(json_.stdout).refused, /1\.5\.0 is not a release/);
  const below = cli("update", "up", "--to", "previous");
  assert.equal(below.status, 1);
  assert.match(below.stderr, /no release below 1\.0\.0/);
  for (const args of [
    ["update", "--to", "1.1.0"],
    ["update", "up", "other", "--to", "1.1.0"],
    ["update", "nope"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(r.stderr.trim(), args.join(" "));
  }
  assert.equal(text(LOCK), lock);
  assert.equal(text("skills-sync.json"), cfg);
  assert.equal(working("a"), copy);
});

/** The stand-in upstream's CHANGELOG.md: a title, an Unreleased section, then one section per version newest first in the heading styles found in the wild, each with a line naming it. */
function changelog(versions: string[]): string {
  const heading = (v: string, i: number) =>
    i % 3 === 0 ? `## [${v}] - 2026-10-0${i + 1}` : i % 3 === 1 ? `## v${v}` : `## ${v}`;
  const sections = versions.map(
    (v, i) => `${heading(v, i)}\n\n### Minor Changes\n\n- change in ${v}\n- migration note for ${v}\n`,
  );
  return `# Changelog\n\nAll notable changes.\n\n## Unreleased\n\n- not released yet\n\n${sections.join("\n")}`;
}

/** Releases 1.2.0, 1.2.3, 1.3.0 and 1.3.1 (tagged vX.Y.Z), each with skill a naming it and a CHANGELOG.md (at `file`) listing every release up to it. */
function changelogReleases(u: Upstream, file = "CHANGELOG.md"): Record<string, string> {
  const at: Record<string, string> = {};
  const all = ["1.2.0", "1.2.3", "1.3.0", "1.3.1"];
  for (const [i, v] of all.entries()) {
    u.skill("a", `release ${v}`);
    u.file(file, changelog(all.slice(0, i + 1).reverse()));
    at[v] = u.commit(v);
    u.tag(`v${v}`);
  }
  return at;
}

const UPGRADE =
  "## [1.3.1] - 2026-10-01\n\n### Minor Changes\n\n- change in 1.3.1\n- migration note for 1.3.1\n\n## v1.3.0\n\n### Minor Changes\n\n- change in 1.3.0\n- migration note for 1.3.0\n";

test("update from 1.2.3 to 1.3.1 reports the CHANGELOG.md sections between them (1.3.1 and 1.3.0, whole, subheadings included) and nothing outside: indented under the updated line in text, as changelog text with direction upgrade in --json", () => {
  const at = changelogReleases(up);
  config({ up: source(up) });
  assert.equal(cli("update", "up", "--to", "1.2.3", "--quiet").status, 0);

  const j = cli("update", "up", "--to", "latest", "--json", "--plan");
  assert.equal(j.status, 0, j.stderr);
  const [u] = JSON.parse(j.stdout).updated;
  assert.deepEqual(u, {
    id: "up",
    from: { version: "1.2.3", commit: at["1.2.3"], ahead: 0 },
    to: { version: "1.3.1", commit: at["1.3.1"], ahead: 0 },
    direction: "upgrade",
    changelog: UPGRADE,
  });

  const r = cli("update", "up", "--to", "latest");
  assert.equal(r.status, 0, r.stderr);
  const block = r.stdout.slice(r.stdout.indexOf("updated up:"));
  assert.ok(
    block.startsWith(
      `updated up: 1.2.3 ${at["1.2.3"].slice(0, 7)} -> 1.3.1 ${at["1.3.1"].slice(0, 7)}\n  changelog after 1.2.3 up to 1.3.1:\n    ## [1.3.1] - 2026-10-01\n\n    ### Minor Changes\n\n    - change in 1.3.1\n`,
    ),
    r.stdout,
  );
  assert.ok(block.includes("    - migration note for 1.3.0\n"), r.stdout);
  for (const outside of ["change in 1.2.3", "change in 1.2.0", "Unreleased", "not released yet", "All notable"])
    assert.ok(!block.includes(outside), `${outside}: ${r.stdout}`);
});

test("a downgrade from 1.3.1 to 1.2.3 reports the same range, read at 1.3.1, as what it undoes: direction downgrade in --json, the sections under an undoes line in text", () => {
  const at = changelogReleases(up);
  config({ up: source(up) });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.up.version, "1.3.1");

  const j = cli("update", "up", "--to", "1.2.3", "--json", "--plan");
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).updated, [
    {
      id: "up",
      from: { version: "1.3.1", commit: at["1.3.1"], ahead: 0 },
      to: { version: "1.2.3", commit: at["1.2.3"], ahead: 0 },
      direction: "downgrade",
      changelog: UPGRADE,
    },
  ]);

  const r = cli("update", "up", "--to", "1.2.3");
  assert.equal(r.status, 0, r.stderr);
  const block = r.stdout.slice(r.stdout.indexOf("updated up:"));
  assert.ok(
    block.startsWith(
      `updated up: 1.3.1 ${at["1.3.1"].slice(0, 7)} -> 1.2.3 ${at["1.2.3"].slice(0, 7)}\n  undoes the changelog after 1.2.3 up to 1.3.1:\n    ## [1.3.1] - 2026-10-01\n`,
    ),
    r.stdout,
  );
  assert.ok(block.includes("    - migration note for 1.3.0\n"), r.stdout);
  assert.ok(!block.includes("change in 1.2.3"), r.stdout);
});

test("changelog null with the reason: no CHANGELOG.md upstream, a version without a heading in it, a side with no version; a source that did not move is not in the report", () => {
  releases(up); // tags, no CHANGELOG.md
  const stillUp = new Upstream(path.join(base, "still"));
  const still = changelogReleases(stillUp);
  const noHeading = new Upstream(path.join(base, "noheading"));
  noHeading.skill("a", "one");
  noHeading.file("CHANGELOG.md", changelog(["1.3.0"]));
  noHeading.commit("1.2.3");
  noHeading.tag("v1.2.3");
  noHeading.skill("a", "two");
  noHeading.commit("1.3.0");
  noHeading.tag("v1.3.0");
  const bare = new Upstream(path.join(base, "bare")); // no tag, no manifest: no version
  bare.skill("a", "one");
  bare.file("CHANGELOG.md", changelog(["1.0.0"]));
  bare.commit("one");
  config({
    up: source(up, { version: "1.1.0" }),
    still: source(stillUp, { skills: { a: "still-a" } }),
    noheading: source(noHeading, { skills: { a: "nh-a" }, version: "1.2.3" }),
    bare: source(bare, { skills: { a: "bare-a" } }),
  });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.still.commit, still["1.3.1"]);

  config({
    up: source(up),
    still: source(stillUp, { skills: { a: "still-a" } }),
    noheading: source(noHeading, { skills: { a: "nh-a" } }),
    bare: source(bare, { skills: { a: "bare-a" } }),
  });
  bare.skill("a", "two");
  bare.commit("two");
  const j = cli("update", "--json", "--plan");
  assert.equal(j.status, 0, j.stderr);
  const updated = JSON.parse(j.stdout).updated as Array<{
    id: string;
    direction: string;
    changelog: string | null;
    changelogReason?: string;
  }>;
  assert.deepEqual(
    updated.map((u) => [u.id, u.direction, u.changelog, u.changelogReason]),
    [
      ["bare", "upgrade", null, `no upstream version for ${json(LOCK).sources.bare.commit.slice(0, 7)}`],
      ["noheading", "upgrade", null, "CHANGELOG.md has no heading for 1.2.3"],
      ["up", "upgrade", null, "no CHANGELOG.md upstream"],
    ],
    "still did not move: not reported",
  );

  const r = cli("update");
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    r.stdout,
    /^updated up: 1\.1\.0 \w{7} -> 1\.2\.0 \(\+1 commit\) \w{7}\n  changelog: none \(no CHANGELOG\.md upstream\)\n/m,
  );
  assert.match(r.stdout, /^  changelog: none \(CHANGELOG\.md has no heading for 1\.2\.3\)$/m);
  assert.ok(!r.stdout.includes("updated still"), r.stdout);
});

test("the CHANGELOG.md nearest the source's root wins over one at the repo root", () => {
  changelogReleases(up, "skills/CHANGELOG.md");
  up.file("CHANGELOG.md", "# Changelog\n\n## 9.9.9\n\n- the repo root's, not the source's\n");
  up.commit("root changelog");
  config({ up: source(up, { version: "1.2.3" }) });
  assert.equal(cli("update", "--quiet").status, 0);
  config({ up: source(up, { version: "1.3.1" }) });
  const j = cli("update", "--json", "--plan");
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).updated[0].changelog, UPGRADE);
});

test("add resolves only the source it declares: an unheld source with a new upstream commit keeps its lock entry byte for byte and its working copy; add reports the new source as updated, like update, in text and --json", () => {
  const at = changelogReleases(up);
  config({ up: source(up) });
  assert.equal(cli("update", "--quiet").status, 0);
  const entry = (lock: string) => JSON.stringify(JSON.parse(lock).sources.up, null, 2);
  const before = entry(text(LOCK));
  up.skill("a", "moved on upstream");
  up.commit("past 1.3.1");

  const other = new Upstream(path.join(base, "other"));
  other.skill("x", "other one");
  const head = other.commit("one");
  const r = cli("add", other.dir, "--id", "other", "--no-plugin", "--json");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(entry(text(LOCK)), before, "up did not move");
  assert.equal(json(LOCK).sources.up.commit, at["1.3.1"]);
  assert.ok(working("a").includes("release 1.3.1"));
  assert.equal(json(LOCK).sources.other.commit, head);
  assert.deepEqual(JSON.parse(r.stdout).updated, [
    {
      id: "other",
      from: null,
      to: { version: null, commit: head, ahead: null },
      direction: "upgrade",
      changelog: null,
      changelogReason: "new to the lock: no version to compare with",
    },
  ]);

  const third = new Upstream(path.join(base, "third"));
  third.skill("y");
  const h3 = third.commit("one");
  const t = cli("add", third.dir, "--id", "third", "--no-plugin");
  assert.equal(t.status, 0, t.stderr);
  assert.equal(entry(text(LOCK)), before);
  assert.ok(
    t.stdout.includes(
      `updated third: (new) -> ${h3.slice(0, 7)}\n  changelog: none (new to the lock: no version to compare with)\n`,
    ),
    t.stdout,
  );
});

test("check reports a held version the lock is not at as one problem on skills-sync.json, naming the update that fixes it; clean once update takes the source there, and a source without a hold is never held to its lock's version", () => {
  releases(up);
  config({ up: source(up, { version: "1.1.0" }) });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(cli("check").status, 0, "held where the lock is");

  config({ up: source(up, { version: "1.0.0" }) });
  const r = cli("check");
  assert.equal(r.status, 1);
  assert.deepEqual(
    r.stdout.split("\n").filter((l) => l && !l.startsWith("check:")),
    ["skills-sync.json: sources.up.version holds 1.0.0 but the lock has 1.1.0; run update up"],
  );
  const j = JSON.parse(cli("check", "--json").stdout);
  assert.deepEqual(j.problems, [
    { path: "skills-sync.json", reason: "sources.up.version holds 1.0.0 but the lock has 1.1.0; run update up" },
  ]);

  assert.equal(cli("update", "up", "--quiet").status, 0);
  assert.equal(cli("check").status, 0, "update took it to the hold");
  config({ up: source(up) });
  assert.equal(cli("check").status, 0, "no hold: the lock may be at any version");
});

test("an upstream that commits CHANGELOG.md and its manifest with CRLF line endings: the changelog sections between two versions still resolve (reported with LF), and so do the manifest's versions", () => {
  const crlf = (s: string) => s.replace(/\n/g, "\r\n");
  const last: Record<string, string> = {}; // per version, the newest commit carrying it
  const all = ["1.2.0", "1.2.3", "1.3.0", "1.3.1"];
  for (const [i, v] of all.entries()) {
    up.skill("a", `release ${v}`);
    up.file("CHANGELOG.md", crlf(changelog(all.slice(0, i + 1).reverse())));
    up.file("skills/.claude-plugin/plugin.json", crlf(JSON.stringify({ name: "up", version: v }, null, 2) + "\n"));
    up.commit(v);
    up.skill("b", `past ${v}`);
    last[v] = up.commit(`past ${v}`);
  }
  assert.ok(fs.readFileSync(path.join(up.dir, "CHANGELOG.md"), "utf8").includes("\r\n"), "committed with CRLF");
  config({ up: source(up, { version: "1.2.3" }) });
  const held = cli("update", "--json");
  assert.equal(held.status, 0, held.stderr);
  assert.equal(
    json(LOCK).sources.up.commit,
    last["1.2.3"],
    "the newest commit whose manifest carried the held version",
  );
  assert.equal(json(LOCK).sources.up.version, "1.2.3");

  const j = cli("update", "up", "--to", "1.3.1", "--json", "--plan");
  assert.equal(j.status, 0, j.stderr);
  const [u] = JSON.parse(j.stdout).updated;
  assert.deepEqual(
    [u.from, u.to, u.direction],
    [
      { version: "1.2.3", commit: last["1.2.3"], ahead: 1 },
      { version: "1.3.1", commit: last["1.3.1"], ahead: 1 },
      "upgrade",
    ],
  );
  assert.equal(u.changelog, UPGRADE);

  const v = JSON.parse(cli("versions", "up", "--json").stdout);
  assert.deepEqual(
    v.versions.map((x: { version: string }) => x.version),
    ["1.3.1", "1.3.0", "1.2.3", "1.2.0"],
  );
});

/** The git processes one CLI run spawns, counted by a wrapper put first on its PATH (POSIX only). */
function gitCalls(...args: string[]): number {
  const bin = path.join(base, "bin");
  const count = path.join(base, "git-calls");
  if (!fs.existsSync(bin)) {
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\necho x >> "${count}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  }
  fs.rmSync(count, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    TMPDIR: tmpDir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  };
  for (const k of HARNESS_ENV) delete env[k];
  const r = spawnSync(process.execPath, [CLI, ...args, "--repo", root], { encoding: "utf8", cwd: root, env });
  assert.equal(r.status, 0, r.stderr);
  return fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0;
}

// not on Windows: it counts git through a POSIX shell wrapper
test.skipIf(process.platform === "win32")(
  "resolving a version and listing versions takes as many git processes for a long history as for a short one: by release tags, and by a manifest whose version changed many times",
  () => {
    const calls = (n: number, tagged: boolean): [number, number] => {
      for (const d of ["up", "dev", "bin"]) fs.rmSync(path.join(base, d), { recursive: true, force: true });
      fs.mkdirSync(path.join(root, "skills", "oneezy", "own-one"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "skills", "oneezy", "own-one", "SKILL.md"),
        "---\nname: own-one\ndescription: mine\n---\nmine\n",
      );
      const u = new Upstream(path.join(base, "up"));
      for (let i = 1; i <= n; i++) {
        u.skill("a", `release ${i}`);
        if (!tagged)
          u.file(
            "skills/.claude-plugin/plugin.json",
            JSON.stringify({ name: "up", version: `1.${i}.0` }, null, 2) + "\n",
          );
        u.commit(`1.${i}.0`);
        if (tagged) u.tag(`v1.${i}.0`);
        u.skill("b", `past ${i}`);
        u.commit(`past ${i}`);
      }
      config({ up: source(u) });
      const update = gitCalls("update", "--json");
      assert.equal(json(LOCK).sources.up.version, `1.${n}.0`);
      const versions = gitCalls("versions", "up", "--json");
      return [update, versions];
    };
    for (const tagged of [true, false])
      assert.deepEqual(calls(12, tagged), calls(3, tagged), tagged ? "by tags" : "by manifest");
  },
);

test("a source committed in UTC is locked with its date spelled Z, whatever git printed (git before 2.45 prints +00:00), so check agrees across hosts", () => {
  up.skill("a", "utc");
  up.git("add", "-A");
  const r = spawnSync("git", [...GIT, "-C", up.dir, "commit", "-q", "-m", "utc"], {
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_DATE: "2026-10-06T06:44:34+00:00" },
  });
  assert.equal(r.status, 0, r.stderr);
  config({ up: source(up) });
  assert.equal(cli("update", "--quiet").status, 0);
  assert.equal(json(LOCK).sources.up.date, "2026-10-06T06:44:34Z");
  const check = cli("check");
  assert.equal(check.status, 0, check.stdout + check.stderr);
});
