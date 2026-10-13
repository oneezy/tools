// sync as a machine command: the managed block in each harness's global instructions file (ADR-0011), and in a cloud
// session nothing else. The CLI runs as a process on the pretend machine (test/machine.ts) against the fake GitHub; the
// tests assert what a user sees: the files (and that nothing else in the home changed), the fake CLIs' calls, the fake
// GitHub's requests, printed lines, --json and exit codes. There is no library-based run any more: a library on the
// machine is never found or used, and an older flag is named once on stderr (test/no-local-state.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { BLOCK_BODY } from "../src/block.js";
import { lexists, linkTarget, samePath } from "../src/fs.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  blockIn,
  cli,
  destroy,
  globalBlock,
  globalFile,
  names,
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

/** The start marker of the tool's pointer text. */
const BUILT_IN_START = `<!-- skills-sync:skills:start built-in sha256:${createHash("sha256").update(`${BLOCK_BODY}\n`).digest("hex")} -->`;
/** The start marker sync writes: the tool's pointer, stamped built-in, release or not. */
const START = BUILT_IN_START;
const END = "<!-- skills-sync:skills:end -->";
const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
/** The setup-script line cloud environments run today, and the plain one the spec reduces it to. */
const SETUP_LINE = ["-y", "--agents", "claude-code", "--global", "--no-projects", "--no-wsl", "--quiet"];
const PLAIN_LINE = ["--quiet"];
/** The one line a machine command prints for the older flags: each as given, once, in order. */
const ignored = (...flags: string[]) =>
  `ignored: ${flags.join(", ")} (settings come from the release's skills-sync.json; machine facts are detected on every run)\n`;

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

/**
 * A machine with both harness folders, the fake claude on PATH and no codex: these tests are about the block, and with
 * a codex on PATH the sync would also install Codex's plugins from GitHub (test/codex-form.test.ts covers that form).
 */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, clis: ["claude"], ...options });
  machines.push(m);
  return m;
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const count = (text: string, part: string) => text.split(part).length - 1;
/** The paths `after` has that `before` had not; fails when any entry of `before` changed or went. */
function added(before: string[], after: string[]): string[] {
  assert.ok(
    before.every((e) => after.includes(e)),
    `changed or lost: ${before.filter((e) => !after.includes(e)).join(", ")}`,
  );
  return names(after.filter((e) => !before.includes(e)));
}
/** A plugin write through a harness CLI: install, add, uninstall, remove, or a marketplace change. */
const pluginWrite = (c: string[]) =>
  c.some((w) => ["install", "add", "uninstall", "remove", "update", "upgrade"].includes(w));

/** What the written block must say: the per-harness rows and the never-fetch rule. */
function assertBlock(text: string): void {
  assert.equal(count(text, START), 1, text);
  assert.equal(count(text, END), 1, text);
  const block = text.slice(text.indexOf(START), text.indexOf(END) + END.length);
  assert.ok(block.startsWith(START), block);
  assert.match(block.slice(START.length), /^\r?\n## How Justin works\r?\n/);
  assert.ok(
    block.includes("At the start of every session, load the `/oneezy-agents` skill and follow what it loads"),
    block,
  );
  assert.ok(block.includes("| Claude Code | `/<plugin>:<skill>`, e.g. `/oneezy:oneezy-agents` |"), block);
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
    block.includes("Never fetch a `SKILL.md` from GitHub, or run one from any folder this harness does not read"),
    block,
  );
  assert.ok(block.includes("When a typed skill does not resolve, show this table instead of improvising."), block);
  // Brain routing moved into /oneezy-agents' rules with everything else
  assert.ok(!block.includes("## Brain"), block);
  assert.ok(!block.includes("skills-sync:brain"), block);
}

test("sync on a machine with no library writes the skills block into both global files and touches nothing else", async () => {
  const m = machine();
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  // the two global blocks and the two session hook entries (test/hooks.test.ts has the hooks' own tests)
  assert.deepEqual(added(before, snapshot(m.home)), [
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".codex/AGENTS.md",
    ".codex/hooks.json",
  ]);
  for (const h of ["claude-code", "codex"] as const) {
    const text = read(globalFile(m, h));
    assertBlock(text);
    // a new file is the block alone
    assert.ok(text.startsWith(START) && text.endsWith(`${END}\n`), text);
  }
  const lines = r.stdout.trimEnd().split("\n");
  assert.ok(
    lines.some(
      (l) =>
        l.startsWith("+ write") &&
        l.includes("CLAUDE.md") &&
        l.includes("(skills block (the pointer to /oneezy-agents))"),
    ),
    r.stdout,
  );
  assert.ok(
    lines.some(
      (l) =>
        l.startsWith("+ write") &&
        l.includes("AGENTS.md") &&
        l.includes("(skills block (the pointer to /oneezy-agents))"),
    ),
    r.stdout,
  );
  assert.equal(lines.at(-1), "4 changed, 0 already right, 0 left alone");
  // Claude Code's form is the account plugins: claude lists none here, which is one line about the sign-in, not one
  // manual step per plugin of the release
  assert.ok(
    lines.some(
      (l) =>
        l.startsWith(". note") &&
        l.includes("Claude Code") &&
        l.includes("claude lists no account plugins; check it is logged in with the claude.ai account"),
    ),
    r.stdout,
  );
  assert.ok(!r.stdout.includes("not delivered"), r.stdout);
  // the other forms are named, not acted on, until their tickets land
  assert.ok(
    lines.some(
      (l) => l.startsWith(". note") && l.includes("Codex: plugins from GitHub") && l.includes("no codex on PATH"),
    ),
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
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "0 changed, 4 already right, 0 left alone");
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
    config: { catalog: "oneezy-skills", harnesses: null, plugins: {} },
  });
  assert.deepEqual(
    s.actions.filter((a) => a.kind !== "note").map((a) => [a.kind, path.basename(a.path), a.note]),
    [
      ["skip", "CLAUDE.md", "skills block current"],
      ["skip", "settings.json", "session hook current"],
      ["skip", "AGENTS.md", "skills block current"],
      ["skip", "hooks.json", "session hook current"],
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
  assert.ok(r.stdout.includes("(skills block replaces brain (the pointer to /oneezy-agents); backup "), r.stdout);
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

test("a marker mentioned in prose, or inline in a fenced example, is not a marker: the block is appended and the mention kept", async () => {
  const m = machine();
  const claude = globalFile(m, "claude-code");
  // a marker is a whole line: one quoted mid-sentence, or sharing its line with other text, is prose
  const mine =
    "The tool writes `<!-- skills-sync:skills:start -->` markers.\n\n```\n<!-- skills-sync:brain:start --> routing <!-- skills-sync:brain:end -->\n```\n" +
    // whole-line markers with an id that is not the tool's (skills, brain): an example of the user's, text like any other
    "```\n<!-- skills-sync:example:start -->\nmine\n<!-- skills-sync:example:end -->\n```\n";
  write(claude, mine);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  const text = read(claude);
  assert.ok(text.startsWith(mine), text);
  assertBlock(text.slice(mine.length));
});

test("a file with two managed blocks is left alone and red; the other harness's file is still written", async () => {
  const m = machine();
  globalBlock(m, "claude-code", "brain", "one");
  globalBlock(m, "claude-code", "skills", "two");
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
  assert.ok(reds[0].includes("CLAUDE.md") && reds[0].includes("2 managed blocks (brain, skills)"), reds[0]);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "3 changed, 0 already right, 1 left alone");
});

test("blocks the old tool wrote into repository files are reported, never edited: in the current directory; the projects the old local file remembers are not looked at, that file is never read", async () => {
  const m = machine();
  const dev = path.join(m.base, "dev");
  const app = path.join(dev, "app");
  const repoFiles = [
    blockIn(path.join(m.base, "here", "AGENTS.md"), "brain", "old"),
    blockIn(path.join(m.base, "here", "CLAUDE.md"), "brain", "old"),
    blockIn(path.join(m.base, "here", ".claude", "CLAUDE.md"), "brain", "old"),
  ];
  // what the old tool left in a project it remembered: found only by running there, where its harness would read it
  const projectFiles = [
    blockIn(path.join(app, "AGENTS.md"), "brain", "old"),
    blockIn(path.join(app, "CLAUDE.md"), "brain", "old"),
  ];
  fs.mkdirSync(path.join(app, ".git"));
  oldLocalFile(m, { dev, projects: ["app", "gone"] });
  const texts = [...repoFiles, ...projectFiles].map(read);
  const libraryBefore = snapshot(path.join(m.base, "old-library"));
  const homeBefore = snapshot(m.home);
  // the cloud is where the current directory is a repository with such a block
  const r = await cli(m, PLAIN_LINE, CLOUD, path.join(m.base, "here"));
  assert.equal(r.status, 0, r.stderr);
  const notes = r.stdout
    .trimEnd()
    .split("\n")
    .filter((l) => l.startsWith(". note") && l.includes("skills-sync block (brain) outside the global file"));
  // the line is `. note         <path>  (<note>)`; the path may hold spaces
  const noted = notes.map((l) => /^\. note\s+(.*?)  \(/.exec(l)?.[1] ?? l);
  assert.equal(noted.length, repoFiles.length, r.stdout);
  for (const file of repoFiles)
    assert.ok(
      noted.some((p) => samePath(p, file)),
      `${file} in ${noted.join(", ")}`,
    );
  assert.ok(
    notes.every((l) => l.includes("remove it by hand")),
    r.stdout,
  );
  assert.ok(!r.stdout.includes(app), `the remembered project is not looked at: ${r.stdout}`);
  assert.deepEqual([...repoFiles, ...projectFiles].map(read), texts);
  // the old library and its local file were left as they are; the home gained only the two global files
  assert.deepEqual(snapshot(path.join(m.base, "old-library")), libraryBefore);
  assert.deepEqual(added(homeBefore, snapshot(m.home)), [".claude/CLAUDE.md", ".codex/AGENTS.md"]);
  // run inside the project, its blocks are the ones reported (not under --quiet: a note is not a change)
  const inside = await cli(m, [], CLOUD, app);
  assert.equal(inside.status, 0, inside.stderr);
  for (const file of projectFiles) assert.ok(inside.stdout.includes(file), `${file} in ${inside.stdout}`);
});

test("a repository block is also reported outside the cloud, and a global file is never mistaken for one", async () => {
  const m = machine();
  const here = path.join(m.base, "here");
  const file = blockIn(path.join(here, "AGENTS.md"), "brain", "old");
  const r = await cli(m, [], {}, here);
  assert.equal(r.status, 0, r.stderr);
  const notes = r.stdout.split("\n").filter((l) => l.includes("outside the global file"));
  assert.equal(notes.length, 1, r.stdout);
  assert.ok(samePath(/^\. note\s+(.*?)  \(/.exec(notes[0])?.[1] ?? "", file), notes[0]);
  // run from inside ~/.codex: its AGENTS.md is the global file, written, not a leftover
  const again = await cli(m, [], {}, m.codexHome);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!again.stdout.includes("outside the global file"), again.stdout);
  // a stale block in Codex's second global file is a leftover too: reported, left alone
  const override = blockIn(path.join(m.codexHome, "AGENTS.override.md"), "brain", "old");
  const text = read(override);
  const third = await cli(m, []);
  assert.equal(third.status, 0, third.stderr);
  const left = third.stdout.split("\n").filter((l) => l.includes("outside the global file"));
  assert.equal(left.length, 1, third.stdout);
  assert.ok(samePath(/^\. note\s+(.*?)  \(/.exec(left[0])?.[1] ?? "", override), left[0]);
  assert.equal(read(override), text);
});

for (const [name, line] of [
  ["today's setup-script line", SETUP_LINE],
  ["the plain line", PLAIN_LINE],
] as const)
  test(`in the cloud, ${name} writes only the global blocks: no clone, no ~/.skills-sync, no links, no plugins, no local file, even with a library present; the older flags are named once on stderr`, async () => {
    const m = machine();
    // a library is on the machine (as the old setup script left it): the cloud run must not touch or use it
    const library = linkTarget(oldLibraryLink(m))!;
    const libraryBefore = snapshot(library);
    const homeBefore = snapshot(m.home);
    const r = await cli(m, [...line], CLOUD);
    assert.equal(r.status, 0, r.stderr);
    // --agents picks nothing any more: every detected harness gets its block
    const files = [".claude/CLAUDE.md", ".codex/AGENTS.md"];
    const warning = line === SETUP_LINE ? ignored("-y", "--agents", "--global", "--no-projects", "--no-wsl") : "";
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
    // stderr: the one line naming the older flags, or nothing, so the setup script stays silent
    assert.equal(r.stderr, warning);
    // the next session start: nothing to do, nothing printed but that line
    const again = await cli(m, [...line], CLOUD);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, "");
    assert.equal(again.stderr, warning);
  });

test("in the cloud with no GitHub reachable the plain line still exits 0 and prints nothing red: both blocks get the pointer, one line says the release was not read", async () => {
  const m = machine({ github: null });
  const r = await cli(m, PLAIN_LINE, CLOUD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  // --quiet: the two writes, the one line about the block's text, the summary; nothing red
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("+ write")).length, 2, r.stdout);
  assert.ok(!lines.some((l) => l.startsWith("!")), r.stdout);
  assert.match(
    lines.find((l) => l.includes("latest release not read")) ?? "",
    /^\. note\s+oneezy\/skills {2}\(latest release not read: .*; the global block needs none\)$/,
  );
  for (const h of ["claude-code", "codex"] as const) assert.ok(read(globalFile(m, h)).startsWith(BUILT_IN_START));
  // --json names the error, and nothing is a conflict
  const j = await cli(m, ["--json"], CLOUD);
  assert.equal(j.status, 0, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.cloud, true);
  assert.equal(s.release, null);
  assert.match(s.error ?? "", /releases\/latest/);
  assert.equal(s.actions.filter((a) => a.kind === "conflict").length, 0);
});

test("in the cloud, --repo <checkout> does not bring a library-based run back: the block is the whole sync, the flag is named once", async () => {
  const m = machine();
  const library = linkTarget(oldLibraryLink(m))!;
  const before = snapshot(library);
  const homeBefore = snapshot(m.home);
  const r = await cli(m, ["--repo", library, "--json"], CLOUD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, ignored("--repo"));
  const s = r.json as unknown as SyncJson;
  assert.equal(s.cloud, true);
  // the leftover link is named, then the two blocks; nothing of a library run
  assert.deepEqual(
    s.actions.map((a) => a.kind),
    ["note", "write", "write"],
  );
  assert.ok(s.actions[0].note?.startsWith("the old library link;"), s.actions[0].note);
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
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "plan: 4 would change, 0 already right, 0 left alone");
  const j = await cli(m, ["--plan", "--json"]);
  assert.equal(j.status, 0, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.plan, true);
  assert.deepEqual(
    s.actions
      .filter((a) => a.kind === "write")
      .map((a) => [path.basename(a.path), a.note?.replace(/; backup .*-backup-\d{8}-\d{6}\.md$/, "; backup <file>")]),
    [
      ["CLAUDE.md", "skills block (the pointer to /oneezy-agents)"],
      ["settings.json", "session hook"],
      ["AGENTS.md", "skills block replaces brain (the pointer to /oneezy-agents); backup <file>"],
      ["hooks.json", "session hook"],
    ],
  );
  // the backup is planned, not made
  assert.deepEqual(snapshot(m.home), before);
});

test("GitHub unreachable: both blocks get the pointer all the same beside the one red line naming the release, exit 1", async () => {
  const m = machine({ github: null });
  const r = await cli(m, []);
  assert.equal(r.status, 1, r.stderr);
  for (const h of ["claude-code", "codex"] as const) assert.ok(read(globalFile(m, h)).startsWith(BUILT_IN_START));
  const out = r.stdout.trimEnd().split("\n");
  const reds = out.filter((l) => l.startsWith("!"));
  assert.equal(reds.length, 1, r.stdout);
  assert.ok(reds[0].includes("oneezy/skills") && reds[0].includes("latest release not read"), reds[0]);
  // each written block names its text
  assert.equal(out.filter((l) => l.includes("skills block (the pointer to /oneezy-agents)")).length, 2, r.stdout);
  // the two blocks and the two hook entries need no release
  assert.equal(out.at(-1), "4 changed, 0 already right, 1 left alone");
  const j = await cli(m, ["--json"]);
  assert.equal(j.status, 1, j.stderr);
  const s = j.json as unknown as SyncJson;
  assert.equal(s.release, null);
  assert.match(s.error ?? "", /releases\/latest/);
  assert.equal(s.actions.filter((a) => a.kind === "conflict").length, 1);
  // the blocks are current without the release, and so are the hook entries
  assert.deepEqual(
    s.actions
      .filter((a) => a.kind === "skip")
      .map((a) => path.basename(a.path))
      .sort(),
    ["AGENTS.md", "CLAUDE.md", "hooks.json", "settings.json"],
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
  // the fake has no such repo: red, and without its release the block gets the built-in text
  assert.equal(other.status, 1, other.stderr);
  assert.ok(read(globalFile(m, "claude-code")).startsWith(BUILT_IN_START));
});

test("--agents picks nothing any more: every detected harness is served and the flag is named once; Hermes has no global instructions file in the table, so it gets a form line and no block", async () => {
  const m = machine({ harnesses: ["claude-code", "codex", "hermes"] });
  const before = snapshot(m.home);
  const r = await cli(m, ["--agents", "codex,hermes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, ignored("--agents"));
  assert.deepEqual(added(before, snapshot(m.home)), [
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".codex/AGENTS.md",
    ".codex/hooks.json",
  ]);
  assert.ok(r.stdout.includes("Claude Code"), r.stdout);
  assert.ok(
    r.stdout
      .split("\n")
      .some((l) => l.startsWith(". note") && l.includes("Hermes: plugins") && l.includes("no hermes on PATH")),
    r.stdout,
  );
  assert.deepEqual(fs.readdirSync(m.hermesHome), []);
});
