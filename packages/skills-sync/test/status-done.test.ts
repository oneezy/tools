// status as the definition of done (tools#155, spec stories 50 to 56): on a pretend machine that `sync` brought to its
// form (account plugins laid down as claude.ai would, Codex's plugins from the fake GitHub, both hook entries, both
// blocks, the Codex hook trusted) with a checkout of oneezy/skills and one of oneezy/tools on dev beside each other,
// status prints all green and exits 0. Each thing that can be wrong is then one red line and exit 1: a plugin behind
// the release, a skill name listed twice, a missing hook entry, the old sync-dev.sh entry, a stale or missing block, a
// block left in a repository file, a dirty or off-dev checkout. What only a person can do is a manual step, printed
// after the red lines and counted in the summary, and alone leaves the exit at 0: the Codex hook trust, an account
// plugin not switched on at claude.ai, a Codex plugin from another marketplace, a folder or link to adopt or delete,
// and in the cloud the environment's setup script line. --json carries the same facts. The CLI runs as a process on
// the pretend machine against the fake GitHub; the tests assert what a user sees and that nothing was written.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { BLOCK_BODY } from "../src/block.js";
import { linkTarget, real, toHash } from "../src/fs.js";
import {
  fixtureConfig,
  startFakeGithub,
  type FakeGithub,
  type FixtureRelease,
} from "./fixtures/fake-github/fake-github.mjs";
import {
  advanceOrigin,
  blockIn,
  checkoutOf,
  cli,
  codexLegacySkills,
  codexTrust,
  currentBlock,
  destroy,
  git,
  githubClone,
  globalFile,
  hookEntry,
  hooksFile,
  installedPlugin,
  looseLink,
  oldLibraryLink,
  pretendMachine,
  releaseCopy,
  skillFolder,
  snapshot,
  syncedPlugin,
  write,
  type PretendMachine,
} from "./machine.js";

/** The sha256 of the tool's built-in block text, as the stamp carries it. */
const BUILT_IN = toHash(Buffer.from(`${BLOCK_BODY}\n`));

interface Line {
  ok: boolean;
  mark: string;
  text: string;
}
interface StatusJson {
  release: { tag: string } | null;
  error?: string;
  cloud: boolean;
  harnesses: Record<
    string,
    {
      lines: Line[];
      duplicates: Array<{ skill: string }>;
      hook: {
        file: string;
        present: boolean;
        current: boolean;
        trusted: boolean | null;
        trust: "trusted" | "new" | "changed" | null;
      } | null;
      block: { file: string; present: boolean; current: boolean; status: string; ids: string[] } | null;
      repoBlocks: Array<{ file: string; ids: string[] }>;
    }
  >;
  lines: Line[];
  checkouts: Array<{
    path: string;
    repo: string;
    branch: string;
    dirty: number | null;
    clean: boolean;
    ok: boolean;
    error?: string;
  }>;
  manualSteps: Array<{ id: string; title: string; steps: string[] }>;
  red: number;
  ok: boolean;
}

let gh: FakeGithub;
let r17: FixtureRelease;
const machines: PretendMachine[] = [];

beforeAll(async () => {
  gh = await startFakeGithub();
  r17 = gh.fixture.releases.find((r) => r.number === 17)!;
});
afterAll(async () => {
  await gh.close();
});
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

const lines = (text: string) => (text ? text.trimEnd().split("\n") : []);
const red = (ls: Line[]) => ls.filter((l) => !l.ok).map((l) => l.text);
const json = (r: { json: Record<string, unknown> | null }) => r.json as unknown as StatusJson;

/** A PC with both harnesses and both CLIs, the real git, the library on the fake GitHub at release-17 for Codex. */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, git: true, ...options });
  machines.push(m);
  return m;
}

/**
 * The machine after the repair: claude.ai delivered every release plugin, `sync` installed Codex's plugins, wrote both
 * blocks and both hook entries, Justin trusted the Codex hook, and the two checkouts sit on dev beside each other.
 * Returns the checkouts; status runs from inside the skills one.
 */
async function synced(m: PretendMachine): Promise<{ skills: string; tools: string }> {
  githubClone(m, r17);
  for (const id of Object.keys(r17.plugins)) syncedPlugin(m, id, { files: r17.plugins[id].files });
  const skills = checkoutOf(m, "oneezy/skills");
  const tools = checkoutOf(m, "oneezy/tools");
  const r = await cli(m, [], {}, skills);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // the entry sync appended is the only SessionStart group, so Codex's trust record names group 0
  codexTrust(m, 0);
  return { skills, tools };
}

const expectGreen = (m: PretendMachine, skills: string, tools: string) => [
  "latest: oneezy/skills release-17 (1717171)",
  "Claude Code  form: account plugins",
  "= matt-pocock@synced 1.3.1 (latest 1.3.1)",
  "= oneezy@synced 0.43.1 (latest 0.43.1)",
  "= play@synced 0.43.0 (latest 0.43.0)",
  `= session hook in ${hooksFile(m, "claude-code")}`,
  `= global block in ${globalFile(m, "claude-code")} current`,
  "Codex  form: plugins from GitHub",
  "= matt-pocock@oneezy-skills 1.3.1 (latest 1.3.1)",
  "= oneezy@oneezy-skills 0.43.1 (latest 0.43.1)",
  "= play@oneezy-skills 0.43.0 (latest 0.43.0)",
  `= session hook in ${hooksFile(m, "codex")}, trusted in Codex`,
  `= global block in ${globalFile(m, "codex")} current`,
  "ChatGPT  account copies, read through Codex",
  ". not checked: Codex on this machine is not signed in with ChatGPT (codex login)",
  "Checkouts",
  `= ${skills} on dev, clean`,
  `= ${tools} on dev, clean`,
  "status: all green",
];

test("a fully synced machine prints every line green and exits 0; --json carries the hook, block, checkout and step facts; nothing is written", async () => {
  const m = machine();
  const { skills, tools } = await synced(m);
  const before = snapshot(m.home);
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(lines(r.stdout), expectGreen(m, skills, tools));
  assert.deepEqual(snapshot(m.home), before);
  // the git calls read only: the checkouts' heads and trees are as they were
  assert.equal(git(m, skills, ["status", "--porcelain"]), "");
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.equal(j.ok, true);
  assert.equal(j.red, 0);
  assert.deepEqual(j.manualSteps, []);
  assert.deepEqual(j.harnesses["claude-code"].hook, {
    file: hooksFile(m, "claude-code"),
    present: true,
    current: true,
    trusted: null,
    trust: null,
  });
  assert.deepEqual(j.harnesses.codex.hook, {
    file: hooksFile(m, "codex"),
    present: true,
    current: true,
    trusted: true,
    trust: "trusted",
  });
  for (const h of ["claude-code", "codex"] as const)
    assert.deepEqual(j.harnesses[h].block, {
      file: globalFile(m, h),
      present: true,
      current: true,
      status: "current",
      ids: ["skills"],
      // the fixture library's release-17 has no SHARED.md: the built-in text, stamped with that release
      stamp: { release: "release-17", sha256: BUILT_IN },
      latest: { release: "release-17", sha256: BUILT_IN },
    });
  assert.deepEqual(j.harnesses.codex.repoBlocks, []);
  assert.deepEqual(j.checkouts, [
    { path: skills, repo: "oneezy/skills", branch: "dev", dirty: 0, clean: true, ok: true },
    { path: tools, repo: "oneezy/tools", branch: "dev", dirty: 0, clean: true, ok: true },
  ]);
  // --quiet on a done machine prints nothing at all
  const quiet = await cli(m, ["status", "--quiet"], {}, skills);
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "");
});

test("a plugin behind the latest release is one red line and exit 1", async () => {
  const m = machine();
  const { skills } = await synced(m);
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"] });
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1);
  assert.ok(
    lines(r.stdout).includes("! matt-pocock@synced 1.3.0 (latest 1.3.1); start a new Claude Code session"),
    r.stdout,
  );
  assert.equal(lines(r.stdout).at(-1), "status: 1 red line");
  assert.equal(json(await cli(m, ["status", "--json"], {}, skills)).red, 1);
});

test("a plugin ahead of the release (main's snapshot before the release job finished, or claude.ai ahead) is a note, not red", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const ahead = { version: "0.43.2", skills: ["oneezy-merge", "oneezy-status"] };
  syncedPlugin(m, "oneezy", ahead);
  installedPlugin(m, "codex", "oneezy", ahead);
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 0, r.stdout);
  const out = lines(r.stdout);
  assert.ok(out.includes(". oneezy@synced 0.43.2 (latest 0.43.1; ahead of the release)"), r.stdout);
  assert.ok(out.includes(". oneezy@oneezy-skills 0.43.2 (latest 0.43.1; ahead of the release)"), r.stdout);
  assert.equal(out.at(-1), "status: all green");
});

test("a skill name listed twice is one red line and exit 1", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const link = looseLink(m, "claude-code", "oneezy-status", path.join(m.base, "elsewhere", "oneezy-status"));
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1);
  const out = lines(r.stdout);
  assert.deepEqual(
    out.filter((l) => l.startsWith("! ")),
    [`! oneezy-status listed twice: oneezy@synced, loose link -> ${linkTarget(link)!}`],
  );
  assert.equal(out.at(-1), "status: 1 red line");
});

test("a missing session hook entry is one red line naming the file and exit 1; the old sync-dev.sh entry still there is one too", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const file = hooksFile(m, "claude-code");
  write(file, "{}\n");
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1);
  assert.deepEqual(
    lines(r.stdout).filter((l) => l.startsWith("! ")),
    [`! no session hook entry in ${file}; run sync`],
  );
  assert.equal(lines(r.stdout).at(-1), "status: 1 red line");
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.deepEqual(j.harnesses["claude-code"].hook, {
    file,
    present: false,
    current: false,
    trusted: null,
    trust: null,
  });
  // sync puts the entry back; the hand-made one beside it is the next red line until sync's next run removes it
  assert.equal((await cli(m, [], {}, skills)).status, 0);
  hookEntry(m, "claude-code", "bash ~/.claude/hooks/sync-dev.sh");
  const old = await cli(m, ["status"], {}, skills);
  assert.equal(old.status, 1);
  assert.deepEqual(
    lines(old.stdout).filter((l) => l.startsWith("! ")),
    [`! old sync-dev.sh hook still in ${file}; run sync`],
  );
  assert.equal(json(await cli(m, ["status", "--json"], {}, skills)).harnesses["claude-code"].hook?.current, false);
});

test("a stale global block (an older block's text) is one red line and exit 1; a missing one too", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const file = globalFile(m, "codex");
  write(file, "");
  blockIn(file, "brain", "## Brain\nold text\n");
  const stale = await cli(m, ["status"], {}, skills);
  assert.equal(stale.status, 1);
  assert.deepEqual(
    lines(stale.stdout).filter((l) => l.startsWith("! ")),
    [`! global block in ${file} is stale (an older block: brain); run sync`],
  );
  assert.equal(lines(stale.stdout).at(-1), "status: 1 red line");
  assert.deepEqual(json(await cli(m, ["status", "--json"], {}, skills)).harnesses.codex.block, {
    file,
    present: true,
    current: false,
    status: "outdated",
    ids: ["brain"],
    stamp: null,
    latest: { release: "release-17", sha256: BUILT_IN },
  });
  fs.rmSync(file);
  const missing = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(missing.status, 1);
  assert.deepEqual(red(json(missing).harnesses.codex.lines), [`global block in ${file} is missing; run sync`]);
  assert.equal(json(missing).harnesses.codex.block?.present, false);
});

test("a block an older version left in a repository file is a red cleanup line until removed by hand", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const file = blockIn(path.join(skills, "CLAUDE.md"), "brain", "## Brain\nold\n");
  const r = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(r.status, 1);
  const claude = json(r).harnesses["claude-code"];
  assert.deepEqual(claude.repoBlocks, [{ file, ids: ["brain"] }]);
  assert.ok(
    red(claude.lines).includes(
      `skills-sync block (brain) in ${file}; remove it by hand, the block lives only in Claude Code's global file now`,
    ),
    JSON.stringify(claude.lines),
  );
});

test("a dirty checkout is one red line and exit 1; so is one on another branch; --json says which", async () => {
  const m = machine();
  const { skills, tools } = await synced(m);
  // origin moves on: a status that fetched would move origin/dev in the checkouts
  const was = {
    skills: git(m, skills, ["rev-parse", "origin/dev"]),
    tools: git(m, tools, ["rev-parse", "origin/dev"]),
  };
  advanceOrigin(m, "oneezy/skills");
  advanceOrigin(m, "oneezy/tools");
  fs.appendFileSync(path.join(skills, "README.md"), "local edit\n");
  const dirty = await cli(m, ["status"], {}, skills);
  assert.equal(dirty.status, 1);
  assert.deepEqual(
    lines(dirty.stdout).filter((l) => l.startsWith("! ")),
    [`! ${skills} on dev, dirty (1 file); commit or stash them`],
  );
  assert.equal(lines(dirty.stdout).at(-1), "status: 1 red line");
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.deepEqual(j.checkouts, [
    { path: skills, repo: "oneezy/skills", branch: "dev", dirty: 1, clean: false, ok: false },
    { path: tools, repo: "oneezy/tools", branch: "dev", dirty: 0, clean: true, ok: true },
  ]);
  assert.equal(j.red, 1);
  // clean again, but tools on a branch: found beside skills, red
  git(m, skills, ["checkout", "--quiet", "--", "README.md"]);
  git(m, tools, ["checkout", "--quiet", "-b", "feat/x"]);
  const off = await cli(m, ["status"], {}, skills);
  assert.equal(off.status, 1);
  assert.deepEqual(
    lines(off.stdout).filter((l) => l.startsWith("! ")),
    [`! ${tools} on feat/x, clean; switch it to dev`],
  );
  assert.equal(lines(off.stdout).at(-1), "status: 1 red line");
  // status never fetched or moved anything: origin/dev in each is where the clone left it, though origin moved on
  assert.equal(git(m, skills, ["rev-parse", "origin/dev"]), was.skills);
  assert.equal(git(m, tools, ["rev-parse", "origin/dev"]), was.tools);
  // dirty and off dev at once: both remedies
  fs.appendFileSync(path.join(tools, "README.md"), "local edit\n");
  assert.deepEqual(
    lines((await cli(m, ["status"], {}, skills)).stdout).filter((l) => l.startsWith("! ")),
    [`! ${tools} on feat/x, dirty (1 file); commit or stash them, then switch it to dev`],
  );
});

test("from a task worktree under a checkout (<repo>/.claude/worktrees/<name>), status checks the main checkouts, not the worktrees", async () => {
  const m = machine();
  const { skills, tools } = await synced(m);
  // the real repositories ignore .claude/worktrees/; so does this one
  fs.appendFileSync(path.join(skills, ".git", "info", "exclude"), ".claude/worktrees/\n");
  const task = path.join(skills, ".claude", "worktrees", "skills-issue-1-x");
  git(m, skills, ["worktree", "add", "--quiet", "-b", "feat/x", task]);
  // a linked worktree beside the checkouts (its .git is a file) is no checkout of its own either
  git(m, tools, ["worktree", "add", "--quiet", "-b", "feat/y", path.join(path.dirname(tools), "tools-issue-2-y")]);
  const r = await cli(m, ["status"], {}, task);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!lines(r.stdout).some((l) => l.startsWith("! ")), r.stdout);
  assert.equal(lines(r.stdout).at(-1), "status: all green");
  // git names the main worktree in its own spelling of the path (on Windows a short 8.3 temp folder may come back long)
  assert.deepEqual(
    json(await cli(m, ["status", "--json"], {}, task)).checkouts.map((c) => [real(c.path), c.branch, c.ok]),
    [
      [real(skills), "dev", true],
      [real(tools), "dev", true],
    ],
  );
});

test("status reads git without taking its index lock: a tracked file's new timestamp does not make it rewrite the index", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const index = path.join(skills, ".git", "index");
  const before = fs.readFileSync(index);
  // the same bytes with another timestamp: a plain git status would refresh the index's stat data and write it
  const later = new Date(Date.now() + 120_000);
  fs.utimesSync(path.join(skills, "README.md"), later, later);
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(index).equals(before), "status rewrote .git/index");
});

test("a checkout whose git status cannot be read is a red line saying so, never a clean one", async () => {
  const m = machine();
  const { skills, tools } = await synced(m);
  write(path.join(skills, ".git", "index"), "not an index");
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1, r.stdout);
  const reds = lines(r.stdout).filter((l) => l.startsWith("! "));
  assert.equal(reds.length, 1, r.stdout);
  assert.ok(reds[0].startsWith(`! ${skills}: git status not read (exit 128)`), r.stdout);
  assert.ok(lines(r.stdout).includes(`= ${tools} on dev, clean`), r.stdout);
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.equal(j.red, 1);
  const c = j.checkouts.find((x) => x.path === skills)!;
  assert.deepEqual([c.dirty, c.clean, c.ok], [null, false, false]);
  assert.match(c.error ?? "", /^git status not read \(exit 128\)/);
});

test("outside any checkout the checkouts are one note, not red", async () => {
  const m = machine();
  await synced(m);
  const r = await cli(m, ["status"]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(
    lines(r.stdout).includes(
      ". no checkout of oneezy/skills or oneezy/tools in reach (the repository here and the folders beside it)",
    ),
    r.stdout,
  );
  assert.deepEqual(json(await cli(m, ["status", "--json"])).checkouts, []);
});

test("an untrusted Codex hook is a manual step with the trust steps, not a red line: exit 0 when nothing else is red", async () => {
  const m = machine();
  const { skills } = await synced(m);
  fs.rmSync(path.join(m.codexHome, "config.toml"));
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 0, r.stdout);
  const out = lines(r.stdout);
  assert.ok(
    out.includes(`= session hook in ${hooksFile(m, "codex")}, new in Codex, not trusted yet (manual step below)`),
    r.stdout,
  );
  assert.ok(!out.some((l) => l.startsWith("! ")), r.stdout);
  const at = out.indexOf("Manual steps");
  assert.ok(at > 0 && at > out.indexOf("Checkouts"), r.stdout);
  assert.deepEqual(out.slice(at), [
    "Manual steps",
    `1. Trust the Skills Sync hook in Codex, once on this machine (${hooksFile(m, "codex")})`,
    "   1. Run codex in a terminal on this machine.",
    '   2. On the "Hooks need review" screen choose "1. Review hooks" (or type /hooks).',
    '   3. Select SessionStart, then the row "[!] Skills Sync · new", and press t.',
    "   4. Press Esc twice. The hook runs from the next codex start, and status no longer lists this step.",
    "status: 0 red lines, 1 manual step",
  ]);
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.equal(j.ok, true);
  assert.deepEqual(j.harnesses.codex.hook, {
    file: hooksFile(m, "codex"),
    present: true,
    current: true,
    trusted: false,
    trust: "new",
  });
  assert.deepEqual(
    j.manualSteps.map((s) => [s.id, s.steps.length]),
    [["codex-trust", 4]],
  );
  // --quiet keeps the step: it is open work, not a green line
  const quiet = await cli(m, ["status", "--quiet"], {}, skills);
  assert.equal(quiet.status, 0);
  assert.equal(lines(quiet.stdout)[0], "Manual steps");
  assert.equal(lines(quiet.stdout).at(-1), "status: 0 red lines, 1 manual step");
});

test("a Codex hooks file without the tool's entry is a red line and no trust step, whatever trust record is left", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const file = hooksFile(m, "codex");
  write(file, "{}\n");
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(
    lines(r.stdout).filter((l) => l.startsWith("! ")),
    [`! no session hook entry in ${file}; run sync`],
  );
  assert.ok(!lines(r.stdout).includes("Manual steps"), r.stdout);
  assert.equal(lines(r.stdout).at(-1), "status: 1 red line");
  assert.deepEqual(json(await cli(m, ["status", "--json"], {}, skills)).manualSteps, []);
});

test("manual steps print after the red lines and never hide one; the summary counts both; the exit code follows the red lines alone", async () => {
  const m = machine();
  const { skills } = await synced(m);
  fs.rmSync(path.join(m.codexHome, "config.toml"));
  fs.appendFileSync(path.join(skills, "README.md"), "local edit\n");
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 1);
  const out = lines(r.stdout);
  const redAt = out.indexOf(`! ${skills} on dev, dirty (1 file); commit or stash them`);
  const stepsAt = out.indexOf("Manual steps");
  assert.ok(redAt > 0 && stepsAt > redAt, r.stdout);
  assert.equal(out.at(-1), "status: 1 red line, 1 manual step");
  const j = json(await cli(m, ["status", "--json"], {}, skills));
  assert.equal(j.red, 1);
  assert.equal(j.ok, false);
  assert.equal(j.manualSteps.length, 1);
});

test("an account plugin claude.ai does not deliver, or one switched off there, is a manual step naming the plugin and the page", async () => {
  const m = machine();
  const { skills } = await synced(m);
  fs.rmSync(path.join(m.claudeHome, "plugins", "synced", "org-1111_bucket-2222", "play"), { recursive: true });
  syncedPlugin(m, "matt-pocock", { files: r17.plugins["matt-pocock"].files, enabled: false });
  const r = await cli(m, ["status"], {}, skills);
  assert.equal(r.status, 0, r.stdout);
  const out = lines(r.stdout);
  const at = out.indexOf("Manual steps");
  assert.deepEqual(out.slice(at), [
    "Manual steps",
    "1. Switch on the account plugins claude.ai does not deliver to Claude Code yet: matt-pocock, play",
    "   1. Open https://claude.ai/customize/plugins (Customize > Plugins) in a browser, signed in to the claude.ai account Claude Code uses.",
    "   2. Find matt-pocock and switch it on (it is switched off today).",
    "   3. Find play and switch it on.",
    "   4. Start a new Claude Code session so claude.ai syncs them in, then run npx --yes @oneezy/skills-sync@latest status: each should show as <id>@synced.",
    "status: 0 red lines, 1 manual step",
  ]);
  assert.deepEqual(
    json(await cli(m, ["status", "--json"], {}, skills)).manualSteps.map((s) => s.id),
    ["claude-plugins"],
  );
  // no account plugin at all: the sign-in is the step, not one toggle per plugin (and nothing installed is red)
  fs.rmSync(path.join(m.claudeHome, "plugins"), { recursive: true });
  const none = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(none.status, 1);
  assert.deepEqual(
    json(none).manualSteps.map((s) => [s.id, s.title]),
    [["claude-account", "Claude Code lists no account plugin: check its claude.ai sign-in"]],
  );
  assert.deepEqual(red(json(none).harnesses["claude-code"].lines), ["no plugins installed (latest release-17)"]);
});

test("a Codex plugin of a library plugin's name from another marketplace is red where its skills double and a manual step saying how to uninstall it", async () => {
  const m = machine();
  const { skills } = await synced(m);
  installedPlugin(m, "codex", "oneezy", {
    files: r17.plugins.oneezy.files,
    version: "0.43.1",
    marketplace: "openai-curated-remote",
  });
  const r = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(r.status, 1);
  const j = json(r);
  assert.deepEqual(
    j.harnesses.codex.duplicates.map((d) => d.skill),
    ["oneezy-merge", "oneezy-status"],
  );
  assert.deepEqual(
    j.manualSteps.map((s) => [s.id, s.title, s.steps]),
    [
      [
        "codex-other-plugins",
        "Uninstall the Codex plugins from other marketplaces that double the library's: oneezy@openai-curated-remote",
        [
          "oneezy@openai-curated-remote: open ChatGPT > Plugins > Installed, find oneezy and choose Uninstall plugin; or run codex plugin remove oneezy@openai-curated-remote.",
          "Run status again: each skill name should be listed once.",
        ],
      ],
    ],
  );
});

test("a release config that writes the library's name in another case (Oneezy/Skills) names the same catalog: Codex's plugins from oneezy-skills are the library's, no step to uninstall them", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const contents = gh.fixture.contents![r17.commit];
  const was = contents["skills-sync.json"];
  contents["skills-sync.json"] = fixtureConfig("Oneezy/Skills", "0.43.1");
  try {
    const r = await cli(m, ["status", "--json"], {}, skills);
    assert.equal(r.status, 0, r.stdout);
    const j = json(r);
    assert.deepEqual(j.manualSteps, []);
    assert.deepEqual(j.harnesses.codex.duplicates, []);
  } finally {
    contents["skills-sync.json"] = was;
  }
});

test("a Codex plugin from another marketplace that is switched off doubles nothing: no step to uninstall it", async () => {
  const m = machine();
  const { skills } = await synced(m);
  installedPlugin(m, "codex", "oneezy", {
    files: r17.plugins.oneezy.files,
    version: "0.43.1",
    marketplace: "openai-curated-remote",
    enabled: false,
  });
  const r = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(json(r).harnesses.codex.duplicates, []);
  assert.deepEqual(json(r).manualSteps, []);
});

test("what sync leaves in Codex's skills folders because it is not the library's is a manual step: adopt it or delete it; the library's own copies are not listed", async () => {
  const m = machine();
  const { skills } = await synced(m);
  const mine = skillFolder(m, "codex", "my-notes", codexLegacySkills(m));
  const elsewhere = looseLink(m, "codex", "their-skill", path.join(m.base, "elsewhere", "their-skill"));
  // exactly the release's files: sync deletes it on its next run, so it is a duplicate line, not a step
  releaseCopy(m, "codex", "tdd", r17);
  const r = await cli(m, ["status", "--json"], {}, skills);
  assert.equal(r.status, 1);
  const j = json(r);
  assert.deepEqual(
    j.harnesses.codex.duplicates.map((d) => d.skill),
    ["tdd"],
  );
  const step = j.manualSteps.find((s) => s.id === "adopt-or-delete");
  assert.ok(step, JSON.stringify(j.manualSteps));
  assert.equal(step.title, "Adopt into oneezy/skills or delete by hand: 2 items left in Codex's skills folders");
  assert.deepEqual(step.steps.slice(0, 2), [
    `${elsewhere}: links to ${linkTarget(elsewhere)!}, not a library copy`,
    `${mine}: a skill folder not in release-17`,
  ]);
  assert.match(step.steps[2], /^To adopt one: add it under skills\/ in oneezy\/skills/);
});

test("a harness the release's skills-sync.json does not serve owes no manual step; the account-plugins step names only the plugins the config gives Claude Code", async () => {
  const m = machine();
  const { skills } = await synced(m);
  fs.rmSync(path.join(m.codexHome, "config.toml"));
  skillFolder(m, "codex", "my-notes", codexLegacySkills(m));
  for (const id of ["matt-pocock", "play"])
    fs.rmSync(path.join(m.claudeHome, "plugins", "synced", "org-1111_bucket-2222", id), { recursive: true });
  const served = json(await cli(m, ["status", "--json"], {}, skills));
  assert.deepEqual(
    served.manualSteps.map((s) => s.id),
    ["claude-plugins", "codex-trust", "adopt-or-delete"],
  );
  const contents = gh.fixture.contents![r17.commit];
  const was = contents["skills-sync.json"];
  contents["skills-sync.json"] = fixtureConfig("oneezy/skills", "0.43.1", {
    machines: { harnesses: ["claude-code"], plugins: { "*": ["oneezy", "play"] } },
  });
  try {
    const j = json(await cli(m, ["status", "--json"], {}, skills));
    assert.deepEqual(Object.keys(j.harnesses), ["claude-code"]);
    assert.deepEqual(
      j.manualSteps.map((s) => [s.id, s.title]),
      [["claude-plugins", "Switch on the account plugins claude.ai does not deliver to Claude Code yet: play"]],
    );
  } finally {
    contents["skills-sync.json"] = was;
  }
});

test("in the cloud status shows the block lines and the manual steps only, reads the release for the block alone, and the exit code follows the block", async () => {
  const m = machine({ harnesses: ["claude-code"], clis: ["claude"], git: false });
  const cloud = { CLAUDE_CODE_REMOTE: "true" };
  // what a cloud thread has today: the account plugins, and what the old setup line made of the library
  for (const id of Object.keys(r17.plugins)) syncedPlugin(m, id, { files: r17.plugins[id].files });
  const old = oldLibraryLink(m);
  looseLink(m, "claude-code", "oneezy-status");
  looseLink(m, "claude-code", "grilling");
  const r = await cli(m, ["status"], cloud);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(lines(r.stdout), [
    ". cloud session",
    "Claude Code  form: account plugins",
    `! global block in ${globalFile(m, "claude-code")} is missing; run sync`,
    "Manual steps",
    `1. The old @oneezy/skills-sync line ran in this session (${old} is the old library link -> ${linkTarget(old)!}; 2 loose links in ${path.join(m.claudeHome, "skills")} (grilling, oneezy-status)): make the cloud run the new one`,
    "   1. At claude.ai open this project's settings, then the Cloud environment menu, then the gear beside the selected environment, and find Setup script (an environment the organization owns is read-only there: an admin changes it in the admin settings).",
    "   2. If the line that runs @oneezy/skills-sync is the old one (it ends -y --agents claude-code --global --no-projects --no-wsl --quiet), replace it with: npx --yes @oneezy/skills-sync@latest --quiet",
    "   3. If the setup script already runs the new line, the old one came from elsewhere in this session, such as a repository's AGENTS.md telling the agent to run it first: change that line to npx --yes @oneezy/skills-sync@latest --quiet the same way.",
    "   4. Start a new cloud thread and run npx --yes @oneezy/skills-sync@latest status there: no loose link, and this step gone.",
    "status: 1 red line, 1 manual step",
  ]);
  // GitHub was only read, for the release the block's text comes from
  assert.ok(r.requests.length > 0 && r.requests.every((q) => q.method === "GET"), JSON.stringify(r.requests));
  const j = json(await cli(m, ["status", "--json"], cloud));
  assert.equal(j.cloud, true);
  assert.equal(j.release?.tag, "release-17");
  assert.ok(!("error" in j));
  assert.deepEqual(j.lines, []);
  assert.deepEqual(j.checkouts, []);
  assert.deepEqual(
    j.harnesses["claude-code"].lines.map((l) => l.text),
    [`global block in ${globalFile(m, "claude-code")} is missing; run sync`],
  );
  // the facts are still there for /oneezy-status, lines or not
  assert.deepEqual(
    j.harnesses["claude-code"].duplicates.map((d) => d.skill),
    ["grilling", "oneezy-status"],
  );
  assert.deepEqual(
    j.manualSteps.map((s) => s.id),
    ["cloud-setup"],
  );
  // the block written (a cloud sync does that): exit 0 with the step still open
  currentBlock(m, "claude-code");
  const done = await cli(m, ["status"], cloud);
  assert.equal(done.status, 0, done.stdout);
  assert.equal(lines(done.stdout).at(-1), "status: 0 red lines, 1 manual step");
  // a thread whose environment runs the new line: nothing of the old library, no step, all green
  fs.rmSync(old);
  fs.rmSync(path.join(m.claudeHome, "skills"), { recursive: true });
  const fresh = await cli(m, ["status"], cloud);
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.deepEqual(lines(fresh.stdout), [
    ". cloud session",
    "Claude Code  form: account plugins",
    `= global block in ${globalFile(m, "claude-code")} current`,
    "status: all green",
  ]);
});
