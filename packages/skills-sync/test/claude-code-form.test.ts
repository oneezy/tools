// Claude Code's form, the account plugins (ADR-0007, tools#149): sync takes away what hides or duplicates an account
// plugin claude.ai delivered, and only after the fake claude lists that plugin; what the tool did not make, and what
// the account does not deliver yet, stays and is named. The CLI runs as a process on the pretend machine
// (test/machine.ts) against the fake GitHub and the fake claude; the tests assert what a user sees: the links and
// folders, the fake claude's calls and state, printed lines, --json, exit codes, and status afterwards.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { isLink, lexists, linkTarget } from "../src/fs.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  destroy,
  installedPlugin,
  libraryCopy,
  looseLink,
  names,
  oldLibraryLink,
  oldLocalFile,
  pretendMachine,
  skillFolder,
  snapshot,
  syncedPlugin,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  target?: string;
  note?: string;
  failed?: boolean;
  diagnostic?: { command: string[]; exitCode: number | null; stderr: string };
}
interface SyncJson {
  plan: boolean;
  actions: ActionJson[];
}
interface StatusJson {
  ok: boolean;
  harnesses: Record<
    string,
    {
      plugins: { installed: Array<{ id: string }>; other: Array<{ id: string; marketplace: string | null }> };
      duplicates: Array<{ skill: string; in: string[] }>;
    }
  >;
}

const NOT_DELIVERED =
  "not delivered by the claude.ai account yet; switch it on at claude.ai (Customize > Plugins), then sync again";

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

/** A machine with Claude Code alone (its folder and the fake claude), so Codex adds no lines. */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, harnesses: ["claude-code"], clis: ["claude"], ...options });
  machines.push(m);
  return m;
}

const latest = () => gh.fixture.releases.find((r) => r.number === 17)!;
/** The fake claude's state: which plugins and marketplaces it has. */
const fakeState = (m: PretendMachine) =>
  JSON.parse(fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8")) as {
    plugins: Record<string, unknown>;
    marketplaces: Record<string, string>;
  };
/** A plugin write through the fake claude: an install, uninstall or marketplace change (its --help probe is not one). */
const pluginWrite = (c: string[]) =>
  !c.includes("--help") && c.some((w) => ["install", "uninstall", "remove", "add", "update"].includes(w));
const lines = (r: { stdout: string }) => r.stdout.trimEnd().split("\n");
const actions = (r: { json: Record<string, unknown> | null }) => (r.json as unknown as SyncJson).actions;
const brief = (a: ActionJson) => [a.kind, a.path, a.note];
/** The paths `after` has that `before` had not; fails when `before` lost or changed any entry. */
function added(before: string[], after: string[]): string[] {
  const lost = before.filter((e) => !after.includes(e));
  assert.deepEqual(lost, [], `lost or changed: ${lost.join(", ")}`);
  return names(after.filter((e) => !before.includes(e)));
}

/**
 * The machine the old tool left behind, now that the account delivers oneezy and matt-pocock: the tool's own
 * oneezy@oneezy-skills (which hides oneezy@synced), loose links to a library clone for three of their skills, and one
 * link whose clone is gone. Returns the links.
 */
function migrating(m: PretendMachine): Record<string, string> {
  const r17 = latest();
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  syncedPlugin(m, "matt-pocock", { files: r17.plugins["matt-pocock"].files });
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-merge", "oneezy-status"] });
  libraryCopy(m);
  const links: Record<string, string> = {};
  for (const name of ["grilling", "oneezy-merge", "oneezy-status"]) links[name] = looseLink(m, "claude-code", name);
  const gone = path.join(m.base, "gone");
  links.tdd = looseLink(m, "claude-code", "tdd", path.join(gone, "tdd"));
  fs.rmSync(gone, { recursive: true, force: true });
  return links;
}

test("one sync leaves only the account plugins for every skill they carry: the tool's plugin and its marketplace are uninstalled, the links to library copies and the dangling one removed, and status lists no duplicate", async () => {
  const m = machine();
  const links = migrating(m);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // the account plugins stay as they are; nothing else of the library's is left on the harness
  for (const id of ["oneezy", "matt-pocock"])
    assert.ok(fs.existsSync(path.join(m.claudeHome, "plugins", "synced", "org-1111_bucket-2222", id, "plugin.json")));
  for (const link of Object.values(links)) assert.equal(lexists(link), false, link);
  assert.deepEqual(fakeState(m).plugins, {});
  assert.deepEqual(fakeState(m).marketplaces, {});
  // through claude's own commands, the plugin before its marketplace
  const writes = r.calls.filter(pluginWrite);
  assert.deepEqual(writes, [
    ["claude", "plugin", "uninstall", "oneezy@oneezy-skills", "--scope", "user", "--json"],
    ["claude", "plugin", "marketplace", "remove", "oneezy-skills", "--json"],
  ]);
  // what a user reads: per account plugin its removals, the uninstall before the links, the manual step last
  const out = lines(r);
  const at = (part: string) => {
    const i = out.findIndex((l) => l.includes(part));
    assert.ok(i >= 0, `${part} in\n${r.stdout}`);
    return i;
  };
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("- remove") &&
        l.includes(links.grilling) &&
        l.includes("grilling is in matt-pocock@synced; a link to a library copy"),
    ),
    r.stdout,
  );
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("- remove") &&
        l.includes(links.tdd) &&
        l.includes("tdd is in matt-pocock@synced; a dangling link"),
    ),
    r.stdout,
  );
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("- uninstall") &&
        l.includes("Claude Code: plugin oneezy@oneezy-skills") &&
        l.includes("(hides oneezy@synced)"),
    ),
    r.stdout,
  );
  assert.ok(
    at("plugin oneezy@oneezy-skills") < at(links["oneezy-merge"]) &&
      at(links["oneezy-merge"]) < at(links["oneezy-status"]),
    r.stdout,
  );
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("- uninstall") &&
        l.includes("Claude Code: marketplace oneezy-skills") &&
        l.includes("(no plugin from it remains)"),
    ),
    r.stdout,
  );
  assert.ok(
    out.some((l) => l.startsWith(". note") && l.includes(`play: ${NOT_DELIVERED}`)),
    r.stdout,
  );
  assert.equal(out.at(-1), "7 changed, 0 already right, 0 left alone");
  // status agrees: each skill name once, everything green
  const s = await cli(m, ["status", "--json"]);
  assert.equal(s.status, 0, s.stdout);
  const status = s.json as unknown as StatusJson;
  assert.deepEqual(status.harnesses["claude-code"].duplicates, []);
  assert.deepEqual(status.harnesses["claude-code"].plugins.installed, []);
  assert.equal(status.ok, true);
});

test("a second sync changes nothing: no plugin command that writes, nothing on disk, and --quiet prints nothing", async () => {
  const m = machine();
  migrating(m);
  await cli(m, []);
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r).at(-1), "0 changed, 1 already right, 0 left alone");
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  const quiet = await cli(m, ["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  assert.deepEqual(snapshot(m.home), before);
});

test("nothing is removed for a plugin the account does not deliver (absent, or switched off at claude.ai), and the report names it; its marketplace stays while it does", async () => {
  const m = machine();
  const r17 = latest();
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  syncedPlugin(m, "matt-pocock", { files: r17.plugins["matt-pocock"].files, enabled: false });
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-merge", "oneezy-status"] });
  installedPlugin(m, "claude-code", "play", { version: "c69993a67bba", skills: ["play-unslop"] });
  libraryCopy(m);
  const keep = ["grilling", "tdd", "play-unslop"].map((n) => looseLink(m, "claude-code", n));
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  // oneezy's copy goes; play's and matt-pocock's stay, with the marketplace that still serves play
  assert.deepEqual(Object.keys(fakeState(m).plugins), ["play@oneezy-skills"]);
  assert.deepEqual(Object.keys(fakeState(m).marketplaces), ["oneezy-skills"]);
  for (const link of keep) assert.ok(isLink(link), link);
  assert.deepEqual(r.calls.filter(pluginWrite), [
    ["claude", "plugin", "uninstall", "oneezy@oneezy-skills", "--scope", "user", "--json"],
  ]);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "note")
      .map(brief),
    [
      ["note", "Claude Code", `matt-pocock: ${NOT_DELIVERED}`],
      ["note", "Claude Code", `play: ${NOT_DELIVERED}`],
    ],
  );
  assert.ok(!actions(r).some((a) => a.path.includes("play") || a.path.includes("grilling") || a.path.includes("tdd")));
});

test("a loose link to somewhere else and a real skill folder with an account plugin's skill name are left alone, each named with the plugin it duplicates", async () => {
  const m = machine();
  syncedPlugin(m, "oneezy", { files: latest().plugins.oneezy.files });
  const mine = path.join(m.base, "mine", "oneezy-status");
  const link = looseLink(m, "claude-code", "oneezy-status", mine);
  const folder = skillFolder(m, "claude-code", "oneezy-merge");
  const before = snapshot(path.join(m.claudeHome, "skills"));
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(path.join(m.claudeHome, "skills")), before);
  assert.ok(isLink(link) && fs.existsSync(path.join(mine, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(folder, "SKILL.md")));
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind !== "write")
      .map(brief),
    [
      [
        "note",
        link,
        "oneezy-status is also in oneezy@synced; this link points outside the library, so it is yours to keep or remove",
      ],
      ["note", folder, "oneezy-merge is also in oneezy@synced; a real skill folder is yours to keep or remove"],
      ["note", "Claude Code", `matt-pocock: ${NOT_DELIVERED}`],
      ["note", "Claude Code", `play: ${NOT_DELIVERED}`],
    ],
  );
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
});

test("a plugin of the same name from another marketplace, and an account plugin that is not the library's, are never touched", async () => {
  const m = machine();
  syncedPlugin(m, "oneezy", { files: latest().plugins.oneezy.files });
  installedPlugin(m, "claude-code", "oneezy", {
    marketplace: "elsewhere",
    version: "9.9.9",
    skills: ["oneezy-status"],
  });
  syncedPlugin(m, "design", {
    version: "1.0.0",
    skills: ["design-critique"],
    marketplace: "anthropic-plugin-directory",
  });
  libraryCopy(m);
  const link = looseLink(m, "claude-code", "design-critique");
  const before = snapshot(path.join(m.claudeHome, "skills"));
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(fakeState(m).plugins), ["oneezy@elsewhere"]);
  assert.deepEqual(Object.keys(fakeState(m).marketplaces), ["elsewhere"]);
  assert.ok(isLink(link));
  assert.deepEqual(snapshot(path.join(m.claudeHome, "skills")), before);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  assert.ok(!actions(r).some((a) => /elsewhere|design/.test(a.path + (a.note ?? ""))), JSON.stringify(actions(r)));
  // status still names the duplicates the user has to settle, as before
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(status.harnesses["claude-code"].duplicates, [
    {
      skill: "design-critique",
      in: ["design@synced", `loose link -> ${linkTarget(link)!}`],
    },
    { skill: "oneezy-status", in: ["oneezy@synced", "oneezy@elsewhere"] },
  ]);
  assert.deepEqual(
    status.harnesses["claude-code"].plugins.other.map((o) => o.id),
    ["design", "oneezy"],
  );
});

for (const [name, options, extra] of [
  ["claude cannot list its plugins", {}, { FAKE_HARNESS_FAIL_LIST: "claude" }],
  ["claude has no plugin commands", {}, { FAKE_HARNESS_OLD: "claude" }],
  ["there is no claude on PATH", { clis: [] as [] }, {}],
] as const)
  test(`removal happens only after the account plugin is verified through claude: when ${name}, nothing is removed and one red line says so`, async () => {
    const m = machine(options);
    migrating(m);
    const before = snapshot(m.home);
    const r = await cli(m, [], extra);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    // the block is written; the links, the plugin and the marketplace are as they were
    assert.deepEqual(added(before, snapshot(m.home)), [".claude/CLAUDE.md"]);
    assert.deepEqual(Object.keys(fakeState(m).plugins), ["oneezy@oneezy-skills"]);
    assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
    const reds = lines(r).filter((l) => l.startsWith("!"));
    assert.equal(reds.length, 1, r.stdout);
    assert.ok(reds[0].includes("Claude Code: account plugins"), reds[0]);
    assert.ok(reds[0].includes("account plugins not verified, nothing removed"), reds[0]);
    assert.ok(/no claude on PATH|claude cannot list its plugins/.test(reds[0]), reds[0]);
    assert.ok(!r.stdout.includes("not delivered"), r.stdout);
  });

test("a delivered account plugin whose folder lists no skill yet is not verified: its tool copy and links stay, one red line", async () => {
  const m = machine();
  syncedPlugin(m, "oneezy", { version: "0.43.1", skills: [] });
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-status"] });
  libraryCopy(m);
  const link = looseLink(m, "claude-code", "oneezy-status");
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(isLink(link));
  assert.deepEqual(Object.keys(fakeState(m).plugins), ["oneezy@oneezy-skills"]);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "conflict")
      .map(brief),
    [["conflict", "Claude Code: plugin oneezy@synced", "lists no skills yet; not verified, nothing removed for it"]],
  );
});

test("a failed uninstall is reported with claude's own words and leaves that plugin's links; the other plugin's cleanup proceeds and the marketplace stays", async () => {
  const m = machine();
  const links = migrating(m);
  installedPlugin(m, "claude-code", "matt-pocock", { version: "c69993a67bba", skills: ["grilling", "tdd"] });
  const r = await cli(m, ["--json"], { FAKE_HARNESS_FAIL_UNINSTALL: "oneezy@oneezy-skills" });
  assert.equal(r.status, 1, r.stderr);
  // matt-pocock: uninstalled, its links gone; oneezy: still installed, its links still there, its marketplace too
  assert.deepEqual(Object.keys(fakeState(m).plugins), ["oneezy@oneezy-skills"]);
  assert.deepEqual(Object.keys(fakeState(m).marketplaces), ["oneezy-skills"]);
  for (const name of ["grilling", "tdd"]) assert.equal(lexists(links[name]), false, name);
  for (const name of ["oneezy-merge", "oneezy-status"]) assert.ok(isLink(links[name]), name);
  assert.deepEqual(r.calls.filter(pluginWrite), [
    ["claude", "plugin", "uninstall", "matt-pocock@oneezy-skills", "--scope", "user", "--json"],
    ["claude", "plugin", "uninstall", "oneezy@oneezy-skills", "--scope", "user", "--json"],
  ]);
  const failed = actions(r).filter((a) => a.kind === "conflict");
  assert.equal(failed.length, 1, JSON.stringify(actions(r)));
  assert.deepEqual(brief(failed[0]), [
    "conflict",
    "Claude Code: plugin oneezy@oneezy-skills",
    "claude could not uninstall it; oneezy@synced stays hidden and its skills' links stay",
  ]);
  assert.equal(failed[0].failed, true);
  assert.ok(failed[0].diagnostic?.command.includes("uninstall"), JSON.stringify(failed[0].diagnostic));
  assert.match(failed[0].diagnostic?.stderr ?? "", /fixture uninstall denied/);
  assert.ok(!actions(r).some((a) => a.kind === "remove" && /oneezy-(merge|status)/.test(a.path)));
  assert.ok(!actions(r).some((a) => a.path.includes("marketplace")));
});

test("--plan lists every removal and changes nothing: no plugin command that writes, nothing on disk; the sync then does what the plan said", async () => {
  const m = machine();
  const links = migrating(m);
  const before = snapshot(m.home);
  const r = await cli(m, ["--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  // a plan may still ask claude read-only questions; here whether the marketplace is registered
  assert.ok(
    r.calls.some((c) => JSON.stringify(c) === JSON.stringify(["claude", "plugin", "marketplace", "list", "--json"])),
    JSON.stringify(r.calls),
  );
  const planned = actions(r);
  assert.equal((r.json as unknown as SyncJson).plan, true);
  assert.deepEqual(
    planned.map((a) => [a.kind, path.basename(a.path)]),
    [
      ["write", "CLAUDE.md"],
      ["remove", "grilling"],
      ["remove", "tdd"],
      ["uninstall", "Claude Code: plugin oneezy@oneezy-skills"],
      ["remove", "oneezy-merge"],
      ["remove", "oneezy-status"],
      ["uninstall", "Claude Code: marketplace oneezy-skills"],
      ["note", "Claude Code"],
    ],
  );
  for (const name of ["grilling", "tdd", "oneezy-merge", "oneezy-status"])
    assert.ok(
      planned.some((a) => a.kind === "remove" && a.path === links[name]),
      name,
    );
  const text = await cli(m, ["--plan"]);
  assert.equal(lines(text).at(-1), "plan: 7 would change, 0 already right, 0 left alone");
  assert.deepEqual(snapshot(m.home), before);
  // the real run is the plan carried out
  const real = await cli(m, ["--json"]);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(
    actions(real).map((a) => [a.kind, a.path, a.note]),
    planned.map((a) => [a.kind, a.path, a.note]),
  );
  for (const link of Object.values(links)) assert.equal(lexists(link), false, link);
});

test("an account plugin behind the release still replaces the tool's copy; a link whose skill it does not carry yet stays, without a word", async () => {
  const m = machine();
  const r16 = gh.fixture.releases.find((r) => r.number === 16)!;
  syncedPlugin(m, "oneezy", { files: r16.plugins.oneezy.files });
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling"] });
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-merge", "oneezy-status"] });
  libraryCopy(m);
  const grilling = looseLink(m, "claude-code", "grilling");
  const tdd = looseLink(m, "claude-code", "tdd");
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fakeState(m).plugins, {});
  assert.equal(lexists(grilling), false);
  assert.ok(isLink(tdd));
  assert.ok(!actions(r).some((a) => a.path === tdd), JSON.stringify(actions(r)));
  // status is where the gap shows: the account plugins behind, tdd listed once
  const s = await cli(m, ["status"]);
  assert.equal(s.status, 1);
  assert.match(s.stdout, /! matt-pocock@synced 1\.3\.0 \(latest 1\.3\.1; skills differ: missing tdd\)/);
  assert.match(s.stdout, /! oneezy@synced 0\.43\.0 \(latest 0\.43\.1\)/);
  assert.ok(!s.stdout.includes("listed twice"), s.stdout);
});

test("GitHub unreachable: nothing is compared or removed, one note says so beside the red release line", async () => {
  const m = machine({ github: null });
  const links = migrating(m);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  for (const link of Object.values(links)) assert.ok(isLink(link) || lexists(link), link);
  assert.deepEqual(Object.keys(fakeState(m).plugins), ["oneezy@oneezy-skills"]);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind !== "write")
      .map(brief),
    [
      ["conflict", "oneezy/skills", actions(r)[0].note],
      ["note", "Claude Code: account plugins", "nothing compared or removed: the latest release was not read"],
    ],
  );
  assert.match(actions(r)[0].note ?? "", /^latest release not read: /);
});

// The old run's WSL fan-out spawns wsl.exe by name: on Linux a shim of that name in the pretend machine's bin records
// the command line; on Windows the real wsl.exe in System32 would win the lookup, so the check stays off there.
test.skipIf(process.platform === "win32")(
  "on a PC with a library and a remembered WSL distro, the old run inside the distro is told which harnesses it serves, never Claude Code",
  async () => {
    const m = machine({ harnesses: ["claude-code", "codex"], clis: ["claude", "codex"] });
    oldLibraryLink(m);
    oldLocalFile(m, { wsl: ["ubuntu"] });
    const log = path.join(m.base, "wsl.log");
    const shim = path.join(m.bin, "wsl.exe");
    fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
    fs.chmodSync(shim, 0o755);
    const r = await cli(m, []);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(log), "wsl.exe was not run");
    const argv = fs.readFileSync(log, "utf8").trimEnd().split("\n");
    assert.deepEqual(argv.slice(0, 5), ["-d", "ubuntu", "--", "bash", "-lic"]);
    const command = argv.slice(5).join("\n");
    assert.ok(command.includes(" --agents codex "), command);
    assert.ok(!command.includes("claude-code"), command);
    assert.equal(lexists(path.join(m.claudeHome, "skills")), false);
  },
);
