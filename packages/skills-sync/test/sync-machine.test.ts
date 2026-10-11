// sync as a machine command: the managed block in each harness's global instructions file (ADR-0011), and in a cloud
// session nothing else. The CLI runs as a process on the pretend machine (test/machine.ts) against the fake GitHub; the
// tests assert what a user sees: the files (and that nothing else in the home changed), the fake CLIs' calls, the fake
// GitHub's requests, printed lines, --json and exit codes. The old library-based run is still reachable on a PC that has
// a library; one test proves it runs after the block, with its own instruction blocks off.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { isLink, lexists } from "../src/fs.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  blockIn,
  cli,
  destroy,
  globalBlock,
  globalFile,
  oldLibraryLink,
  oldLocalFile,
  pretendMachine,
  snapshot,
  write,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  note?: string;
  failed?: boolean;
}
interface SyncJson {
  plan: boolean;
  actions: ActionJson[];
  release: { repo: string; tag: string; number: number; commit: string; tool: string | null } | null;
  error?: string;
  cloud: boolean;
}

const START = "<!-- skills-sync:skills:start -->";
const END = "<!-- skills-sync:skills:end -->";
const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
/** The setup-script line cloud environments run today, and the plain one the spec reduces it to. */
const SETUP_LINE = ["-y", "--agents", "claude-code", "--global", "--no-projects", "--no-wsl", "--quiet"];
const PLAIN_LINE = ["--quiet"];

let gh: FakeGithub;
const machines: PretendMachine[] = [];

beforeAll(async () => {
  gh = await startFakeGithub();
});
afterAll(async () => {
  await gh.close();
});
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, ...options });
  machines.push(m);
  return m;
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;
/** The entries `after` has that `before` had not; fails when `before` lost any. */
function added(before: string[], after: string[]): string[] {
  assert.ok(
    before.every((e) => after.includes(e)),
    `lost: ${before.filter((e) => !after.includes(e)).join(", ")}`,
  );
  return after.filter((e) => !before.includes(e));
}
/** A plugin write through a harness CLI: install, add, uninstall, remove, or a marketplace change. */
const pluginWrite = (c: string[]) =>
  c.some((w) => ["install", "add", "uninstall", "remove", "update", "upgrade"].includes(w));

/** What the written block must say: the per-harness rows and the never-fetch rule. */
function assertBlock(text: string): void {
  assert.equal(count(text, START), 1, text);
  assert.equal(count(text, END), 1, text);
  const block = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
  assert.match(block, /^<!-- skills-sync:skills:start -->\r?\n## Skills\r?\n/);
  assert.ok(block.includes("| Claude Code | `/<plugin>:<skill>`, e.g. `/oneezy:oneezy-status` |"), block);
  assert.ok(
    block.includes(
      "| Codex | `$<skill>` in the prompt (a plugin's skill: `$<plugin>:<skill>`), the `/skills` picker, or `@<skill>` on ChatGPT web |",
    ),
    block,
  );
  assert.ok(
    block.includes("| Hermes | `/<skill>` for a loose skill; a plugin's skill: `/agent-plugin-<id>-<hash>:<skill>` |"),
    block,
  );
  assert.ok(
    block.includes("Never fetch a `SKILL.md` from GitHub, or run one from any copy this harness did not load"),
    block,
  );
  assert.ok(block.includes("When a typed skill does not resolve, show this table instead of improvising."), block);
  assert.ok(!block.includes("skills-sync:brain"), block);
}

test("sync on a machine with no library writes the skills block into both global files and touches nothing else", async () => {
  const m = machine();
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(added(before, snapshot(m.home)), [".claude/CLAUDE.md", ".codex/AGENTS.md"]);
  for (const h of ["claude-code", "codex"] as const) {
    const text = read(globalFile(m, h));
    assertBlock(text);
    // a new file is the block alone
    assert.ok(text.startsWith(START) && text.endsWith(`${END}\n`), text);
  }
  const lines = r.stdout.trimEnd().split("\n");
  assert.ok(
    lines.some((l) => l.startsWith("+ write") && l.includes("CLAUDE.md") && l.includes("(skills block)")),
    r.stdout,
  );
  assert.ok(
    lines.some((l) => l.startsWith("+ write") && l.includes("AGENTS.md") && l.includes("(skills block)")),
    r.stdout,
  );
  assert.equal(lines.at(-1), "2 changed, 0 already right, 0 left alone");
  // the forms are named, not acted on, until their tickets land
  assert.ok(
    lines.some((l) => l.startsWith(". note") && l.includes("Claude Code") && l.includes("form: account plugins")),
    r.stdout,
  );
  assert.ok(
    lines.some((l) => l.startsWith(". note") && l.includes("Codex") && l.includes("form: plugins from GitHub")),
    r.stdout,
  );
  // no library cloned or remembered, GitHub only read, no plugin command run
  assert.equal(lexists(path.join(m.home, ".skills-sync")), false);
  assert.ok(r.requests.length > 0 && r.requests.every((q) => q.method === "GET"), JSON.stringify(r.requests));
  assert.ok(r.requests.some((q) => q.path === "/repos/oneezy/skills/releases/latest"));
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
});

test("a second sync changes nothing and says so; --quiet then prints nothing; --json shows two skips and the release", async () => {
  const m = machine();
  await cli(m, []);
  const files = (["claude-code", "codex"] as const).map((h) => globalFile(m, h));
  const texts = files.map(read);
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "0 changed, 2 already right, 0 left alone");
  assert.deepEqual(files.map(read), texts);
  assert.deepEqual(snapshot(m.home), before);
  const quiet = await cli(m, ["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  const j = await cli(m, ["--json"]);
  assert.equal(j.status, 0, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.plan, false);
  assert.equal(s.cloud, false);
  assert.deepEqual(s.release, {
    repo: "oneezy/skills",
    tag: "release-17",
    number: 17,
    commit: "1717171717171717171717171717171717171717",
    tool: null,
  });
  assert.deepEqual(
    s.actions.filter((a) => a.kind !== "note").map((a) => [a.kind, path.basename(a.path), a.note]),
    [
      ["skip", "CLAUDE.md", "skills block current"],
      ["skip", "AGENTS.md", "skills block current"],
    ],
  );
});

test("text around the markers stays byte for byte: the old brain block is replaced where it stands, CRLF files keep CRLF", async () => {
  const m = machine();
  const claude = globalFile(m, "claude-code");
  write(claude, "# Mine\n\nAbove the block.\n\n");
  globalBlock(m, "claude-code", "brain", "## Brain\nLoad /oneezy-brain.");
  fs.appendFileSync(claude, "\nBelow the block.\n");
  const codex = globalFile(m, "codex");
  write(codex, "top\r\n<!-- skills-sync:brain:start -->\r\nold\r\n<!-- skills-sync:brain:end -->\r\nbottom\r\n");
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  const c = read(claude);
  assert.ok(c.startsWith(`# Mine\n\nAbove the block.\n\n${START}\n`), c);
  assert.ok(c.endsWith(`\n${END}\n\nBelow the block.\n`), c);
  assertBlock(c);
  assert.ok(r.stdout.includes("(skills block replaces brain)"), r.stdout);
  const x = read(codex);
  assert.ok(x.startsWith(`top\r\n${START}\r\n`), x);
  assert.ok(x.endsWith(`\r\n${END}\r\nbottom\r\n`), x);
  assert.equal(count(x, "\n"), count(x, "\r\n"), "every newline is CRLF");
  assertBlock(x);
  // and a second run leaves both exactly as they are
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(claude), c);
  assert.equal(read(codex), x);
});

test("a file with two managed blocks is left alone and red; the other harness's file is still written", async () => {
  const m = machine();
  globalBlock(m, "claude-code", "brain", "one");
  globalBlock(m, "claude-code", "other", "two");
  const text = read(globalFile(m, "claude-code"));
  const r = await cli(m, []);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(read(globalFile(m, "claude-code")), text);
  assertBlock(read(globalFile(m, "codex")));
  const reds = r.stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.startsWith("!"));
  assert.equal(reds.length, 1, r.stdout);
  assert.ok(reds[0].includes("CLAUDE.md") && reds[0].includes("2 managed blocks (brain, other)"), reds[0]);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "1 changed, 0 already right, 1 left alone");
});

test("blocks the old tool wrote into repository files are reported, never edited: in the current directory and in the projects the old local file remembers", async () => {
  const m = machine();
  const dev = path.join(m.base, "dev");
  const app = path.join(dev, "app");
  const repoFiles = [
    blockIn(path.join(app, "AGENTS.md"), "brain", "old"),
    blockIn(path.join(app, "CLAUDE.md"), "brain", "old"),
    blockIn(path.join(app, ".claude", "CLAUDE.md"), "brain", "old"),
    blockIn(path.join(m.base, "here", "AGENTS.md"), "brain", "old"),
    blockIn(path.join(m.base, "here", "CLAUDE.md"), "brain", "old"),
  ];
  fs.mkdirSync(path.join(app, ".git"));
  oldLocalFile(m, { dev, projects: ["app", "gone"] });
  const texts = repoFiles.map(read);
  const libraryBefore = snapshot(path.join(m.base, "old-library"));
  const homeBefore = snapshot(m.home);
  // the cloud is where the current directory is a repository with such a block
  const r = await cli(m, PLAIN_LINE, CLOUD, path.join(m.base, "here"));
  assert.equal(r.status, 0, r.stderr);
  const notes = r.stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.startsWith(". note") && l.includes("skills-sync block (brain) in a repository file"));
  assert.deepEqual(notes.map((l) => l.split(/\s+/)[2]).sort(), [...repoFiles].sort(), r.stdout);
  assert.ok(
    notes.every((l) => l.includes("remove it by hand")),
    r.stdout,
  );
  assert.deepEqual(repoFiles.map(read), texts);
  // the old library and its local file were read, not written; the home gained only the two global files
  assert.deepEqual(snapshot(path.join(m.base, "old-library")), libraryBefore);
  assert.deepEqual(added(homeBefore, snapshot(m.home)), [".claude/CLAUDE.md", ".codex/AGENTS.md"]);
});

test("a repository block is also reported outside the cloud, and a global file is never mistaken for one", async () => {
  const m = machine();
  const here = path.join(m.base, "here");
  const file = blockIn(path.join(here, "AGENTS.md"), "brain", "old");
  const r = await cli(m, [], {}, here);
  assert.equal(r.status, 0, r.stderr);
  const notes = r.stdout.split("\n").filter((l) => l.includes("in a repository file"));
  assert.equal(notes.length, 1, r.stdout);
  assert.ok(notes[0].includes(file), notes[0]);
  // run from inside ~/.codex: its AGENTS.md is the global file, written, not a repository leftover
  const again = await cli(m, [], {}, m.codexHome);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!again.stdout.includes("in a repository file"), again.stdout);
});

for (const [name, line] of [
  ["today's setup-script line", SETUP_LINE],
  ["the plain line", PLAIN_LINE],
] as const)
  test(`in the cloud, ${name} writes only the global block: no clone, no ~/.skills-sync, no links, no plugins, no local file, even with a library present`, async () => {
    const m = machine();
    // a library is on the machine (as the old setup script left it): the cloud run must not touch or use it
    const library = fs.realpathSync(oldLibraryLink(m));
    const libraryBefore = snapshot(library);
    const homeBefore = snapshot(m.home);
    const r = await cli(m, [...line], CLOUD);
    assert.equal(r.status, 0, r.stderr);
    const files = line === SETUP_LINE ? [".claude/CLAUDE.md"] : [".claude/CLAUDE.md", ".codex/AGENTS.md"];
    assert.deepEqual(added(homeBefore, snapshot(m.home)), files);
    for (const f of files) assertBlock(read(path.join(m.home, f)));
    assert.deepEqual(snapshot(library), libraryBefore);
    assert.equal(fs.existsSync(path.join(library, "skills-sync.local.json")), false);
    for (const dir of [path.join(m.claudeHome, "skills"), path.join(m.home, ".agents", "skills")])
      assert.equal(fs.existsSync(dir), false, dir);
    assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
    assert.ok(
      r.requests.every((q) => q.method === "GET"),
      JSON.stringify(r.requests),
    );
    // --quiet: the writes and the summary, nothing about forms; stderr empty, so the setup script stays silent
    const lines = r.stdout.trimEnd().split("\n");
    assert.equal(lines.filter((l) => l.startsWith("+ write")).length, files.length, r.stdout);
    assert.equal(lines.at(-1), `${files.length} changed, 0 already right, 0 left alone`);
    assert.ok(!r.stdout.includes("form:"), r.stdout);
    assert.equal(r.stderr, "");
    // the next session start: nothing to do, nothing printed
    const again = await cli(m, [...line], CLOUD);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, "");
  });

test("in the cloud, --repo <checkout> does not bring the library-based run back: the block is the whole sync", async () => {
  const m = machine();
  const library = fs.realpathSync(oldLibraryLink(m));
  const before = snapshot(library);
  const homeBefore = snapshot(m.home);
  const r = await cli(m, ["--repo", library, "--json"], CLOUD);
  assert.equal(r.status, 0, r.stderr);
  const s = r.json as unknown as SyncJson;
  assert.equal(s.cloud, true);
  assert.deepEqual(
    s.actions.map((a) => a.kind),
    ["write", "write"],
  );
  assert.deepEqual(snapshot(library), before);
  assert.deepEqual(added(homeBefore, snapshot(m.home)), [".claude/CLAUDE.md", ".codex/AGENTS.md"]);
});

test("--plan writes nothing and says what would change, in text and --json", async () => {
  const m = machine();
  globalBlock(m, "codex", "brain", "old");
  const before = snapshot(m.home);
  const texts = [read(globalFile(m, "codex"))];
  const r = await cli(m, ["--plan"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual([read(globalFile(m, "codex"))], texts);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "plan: 2 would change, 0 already right, 0 left alone");
  const j = await cli(m, ["--plan", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.plan, true);
  assert.deepEqual(
    s.actions.filter((a) => a.kind === "write").map((a) => [path.basename(a.path), a.note]),
    [
      ["CLAUDE.md", "skills block"],
      ["AGENTS.md", "skills block replaces brain"],
    ],
  );
  assert.deepEqual(snapshot(m.home), before);
});

test("GitHub unreachable: the block is still written, one red line names the release, exit 1", async () => {
  const m = machine({ github: null });
  const r = await cli(m, []);
  assert.equal(r.status, 1, r.stderr);
  for (const h of ["claude-code", "codex"] as const) assertBlock(read(globalFile(m, h)));
  const reds = r.stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.startsWith("!"));
  assert.equal(reds.length, 1, r.stdout);
  assert.ok(reds[0].includes("oneezy/skills") && reds[0].includes("latest release not read"), reds[0]);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "2 changed, 0 already right, 1 left alone");
  const j = await cli(m, ["--json"]);
  assert.equal(j.status, 1, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.release, null);
  assert.match(s.error ?? "", /releases\/latest/);
  assert.equal(s.actions.filter((a) => a.kind === "conflict").length, 1);
  // the block stayed current: the red line is the only thing wrong
  assert.deepEqual(
    s.actions.filter((a) => a.kind === "skip").map((a) => path.basename(a.path)),
    ["CLAUDE.md", "AGENTS.md"],
  );
});

test("--library names the release repo as owner/repo: another repo is asked for, anything else is exit 2 with nothing written", async () => {
  const m = machine();
  const before = snapshot(m.home);
  const bad = await cli(m, ["--library", "https://github.com/oneezy/skills.git"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /sync: --library names the release repo as owner\/repo/);
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(bad.requests.length, 0);
  const other = await cli(m, ["--library", "other/library"]);
  assert.ok(
    other.requests.some((q) => q.path === "/repos/other/library/releases/latest"),
    JSON.stringify(other.requests),
  );
  // the fake has no such repo: red, but the block needs no release
  assert.equal(other.status, 1, other.stderr);
  assertBlock(read(globalFile(m, "claude-code")));
});

test("--agents picks the harnesses; Hermes has no global instructions file in the table, so it gets a form line and no block", async () => {
  const m = machine({ harnesses: ["claude-code", "codex", "hermes"] });
  const before = snapshot(m.home);
  const r = await cli(m, ["--agents", "codex,hermes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(added(before, snapshot(m.home)), [".codex/AGENTS.md"]);
  assert.ok(!r.stdout.includes("Claude Code"), r.stdout);
  assert.ok(
    r.stdout
      .split("\n")
      .some((l) => l.startsWith(". note") && l.includes("Hermes") && l.includes("form: loose skills")),
    r.stdout,
  );
  assert.deepEqual(fs.readdirSync(m.hermesHome), []);
});

test("a PC with a library keeps the old library-based sync after the block, with the old instruction blocks off: one report, no brain block", async () => {
  const m = machine();
  const library = fs.realpathSync(oldLibraryLink(m));
  globalBlock(m, "claude-code", "brain", "## Brain\nold");
  const r = await cli(m, ["--no-wsl"]);
  assert.equal(r.status, 0, r.stderr);
  // the block first, then what the old run did: the user-folder links of the library's skills, as before
  for (const h of ["claude-code", "codex"] as const) assertBlock(read(globalFile(m, h)));
  const link = path.join(m.claudeHome, "skills", "oneezy-status");
  assert.ok(isLink(link), link);
  assert.ok(isLink(path.join(m.home, ".agents", "skills", "oneezy-status")));
  const lines = r.stdout.trimEnd().split("\n");
  const write = lines.findIndex((l) => l.startsWith("+ write") && l.includes("CLAUDE.md"));
  const linked = lines.findIndex((l) => l.startsWith("+ link") && l.includes("oneezy-status"));
  assert.ok(write >= 0 && linked > write, r.stdout);
  assert.equal(lines.filter((l) => /\d+ changed, \d+ already right, \d+ left alone$/.test(l)).length, 1, r.stdout);
  // the old run still remembers its answers in the library, as it did; nothing of it wrote a brain block anywhere
  assert.ok(fs.existsSync(path.join(library, "skills-sync.local.json")));
  for (const f of fs.readdirSync(m.home, { recursive: true, withFileTypes: true }))
    if (f.isFile() && f.name.endsWith(".md")) {
      const text = read(path.join(f.parentPath, f.name));
      assert.ok(!text.includes("skills-sync:brain"), `${f.name}: ${text}`);
    }
  const again = await cli(m, ["--no-wsl"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.trimEnd().split("\n").at(-1)?.startsWith("0 changed"), again.stdout);
});
