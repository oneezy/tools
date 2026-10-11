// Codex's form (tools#150): sync adds the library's marketplace from GitHub, installs every plugin of the latest
// release, upgrades them when a newer release exists, verifies each through Codex's own listing and prompt input, and
// only then removes the copies of their skills in ~/.agents/skills and the deprecated ~/.codex/skills; .system and every
// folder that is not the library's stay, the latter listed for Justin to adopt or delete. The CLI runs as a process on
// the pretend machine (test/machine.ts) with the fake codex on PATH and the fake GitHub; the fake codex clones its
// marketplace from a pretend GitHub checkout laid down by `githubClone`. The tests assert what a user sees: the fake
// codex's calls and its own `plugin list --json` afterwards, files and links, printed lines, --json, exit codes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { isLink, lexists } from "../src/fs.js";
import {
  fixtureRelease,
  startFakeGithub,
  type FakeGithub,
  type FixtureRelease,
} from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  codexLegacySkills,
  codexPluginEnabled,
  destroy,
  fakeCli,
  githubClone,
  installedPlugin,
  libraryCheckout,
  releaseCopy,
  looseLink,
  oldLibraryLink,
  pretendMachine,
  skillFolder,
  snapshot,
  systemSkill,
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
}
interface CodexPlugin {
  pluginId: string;
  version: string | null;
  enabled: boolean;
  marketplaceSource: { sourceType: string; source: string };
}
interface CodexMarketplace {
  name: string;
  marketplaceSource: { sourceType: string; source: string };
}
interface StatusJson {
  ok: boolean;
  harnesses: Record<
    string,
    {
      duplicates: Array<{ skill: string; in: string[] }>;
      loose: Array<{ name: string }>;
      folders: Array<{ name: string }>;
      lines: Array<{ ok: boolean; text: string }>;
    }
  >;
}

const MKT = "oneezy-skills";
const ADD_MARKETPLACE = ["codex", "plugin", "marketplace", "add", "oneezy/skills", "--json"];
const UPGRADE = ["codex", "plugin", "marketplace", "upgrade", MKT, "--json"];
const addPlugin = (id: string) => ["codex", "plugin", "add", `${id}@${MKT}`, "--json"];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const calls = (r: { calls: string[][] }, call: string[]) => r.calls.filter((c) => same(c, call)).length;
/** A call that changes something on the fake codex: a plugin or marketplace write. */
const mutating = (c: string[]) =>
  ["add", "remove", "upgrade", "install", "uninstall", "update"].some((w) => c.includes(w));

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

/** A machine with Codex alone, its CLI on PATH, the library on the pretend GitHub at release-17. */
function machine(options: Parameters<typeof pretendMachine>[0] = {}, release = r17): PretendMachine {
  const m = pretendMachine({ harnesses: ["codex"], clis: ["codex"], github: gh, ...options });
  machines.push(m);
  githubClone(m, release);
  return m;
}

const lines = (r: { stdout: string }) => r.stdout.trimEnd().split("\n");
/**
 * ~/.skills-sync as the old tool left it, pointing at a folder under the machine (where `looseLink` puts its targets).
 * The folder is bare, so the old library-based run (still behind the machine sync on a PC until #154) does not start.
 */
function oldSkillsSync(m: PretendMachine): string {
  const to = path.join(m.base, "old-library");
  fs.mkdirSync(to, { recursive: true });
  return oldLibraryLink(m, to);
}
/** What codex lists installed, by plugin id: [id, version, enabled, where its marketplace comes from]. */
const installed = (m: PretendMachine) =>
  ((fakeCli(m, "codex", ["plugin", "list", "--json"]).json as unknown as { installed: CodexPlugin[] }).installed ?? [])
    .map((p) => [p.pluginId, p.version, p.enabled, p.marketplaceSource.sourceType] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
const marketplaces = (m: PretendMachine) =>
  (
    (
      fakeCli(m, "codex", ["plugin", "marketplace", "list", "--json"]).json as unknown as {
        marketplaces: CodexMarketplace[];
      }
    ).marketplaces ?? []
  ).map((x) => [x.name, x.marketplaceSource.sourceType, x.marketplaceSource.source] as const);
const actions = (r: { json: Record<string, unknown> | null }) => (r.json as unknown as SyncJson).actions;
const ALL_17 = [
  ["matt-pocock@oneezy-skills", "1.3.1", true, "git"],
  ["oneezy@oneezy-skills", "0.43.1", true, "git"],
  ["play@oneezy-skills", "0.43.0", true, "git"],
];

test("on a machine with nothing installed, sync adds the marketplace from GitHub and installs every plugin of the latest release; codex lists them installed and enabled", async () => {
  const m = machine();
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(r, ADD_MARKETPLACE), 1, JSON.stringify(r.calls));
  for (const id of ["matt-pocock", "oneezy", "play"]) assert.equal(calls(r, addPlugin(id)), 1, JSON.stringify(r.calls));
  // in the release's order, after the marketplace; no upgrade and no removal on a fresh machine
  const writes = r.calls.filter(mutating).map((c) => c.slice(1).join(" "));
  assert.deepEqual(writes, [
    "plugin marketplace add oneezy/skills --json",
    "plugin add matt-pocock@oneezy-skills --json",
    "plugin add oneezy@oneezy-skills --json",
    "plugin add play@oneezy-skills --json",
  ]);
  assert.deepEqual(installed(m), ALL_17);
  assert.deepEqual(marketplaces(m), [[MKT, "git", "https://github.com/oneezy/skills.git"]]);
  // what the user reads: the marketplace, each plugin at its version, the block, one summary
  const out = lines(r);
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("+ install") &&
        l.includes(`Codex: marketplace ${MKT}`) &&
        l.includes("(from GitHub oneezy/skills)"),
    ),
    r.stdout,
  );
  assert.ok(
    out.some(
      (l) => l.startsWith("+ install") && l.includes("Codex: plugin oneezy@oneezy-skills") && l.includes("(0.43.1)"),
    ),
    r.stdout,
  );
  assert.equal(out.at(-1), "5 changed, 0 already right, 0 left alone");
  // status agrees: current, nothing listed twice, exit 0
  const s = await cli(m, ["status", "--json"]);
  assert.equal(s.status, 0, s.stdout);
  const codex = (s.json as unknown as StatusJson).harnesses.codex;
  assert.deepEqual(codex.duplicates, []);
  assert.ok(
    codex.lines.every((l) => l.ok),
    JSON.stringify(codex.lines),
  );
});

test("a second sync changes nothing: every plugin and the marketplace are skips, no plugin command that writes runs, the home is as it was", async () => {
  const m = machine();
  assert.equal((await cli(m, [])).status, 0);
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r).at(-1), "0 changed, 5 already right, 0 left alone");
  assert.deepEqual(r.calls.filter(mutating), []);
  assert.deepEqual(snapshot(m.home), before);
  const j = await cli(m, ["--json"]);
  assert.deepEqual(
    actions(j)
      .filter((a) => a.path.startsWith("Codex"))
      .map((a) => [a.kind, a.path, a.note]),
    [
      ["skip", `Codex: marketplace ${MKT}`, "from GitHub oneezy/skills"],
      ["skip", "Codex: plugin matt-pocock@oneezy-skills", "installed 1.3.1"],
      ["skip", "Codex: plugin oneezy@oneezy-skills", "installed 0.43.1"],
      ["skip", "Codex: plugin play@oneezy-skills", "installed 0.43.0"],
    ],
  );
  assert.deepEqual(installed(m), ALL_17);
});

test("a newer release triggers one marketplace upgrade for the harness: a plugin behind by version, and an unversioned one behind by its skill set, both follow it", async () => {
  const older = fixtureRelease({
    number: 17,
    commit: "1717171717171717171717171717171717171717",
    plugins: {
      oneezy: { version: "0.43.1", skills: ["oneezy-merge", "oneezy-status"] },
      design: { version: null, skills: ["frontend-design"] },
    },
  });
  const newer = fixtureRelease({
    number: 18,
    previous: "release-17",
    commit: "1818181818181818181818181818181818181818",
    plugins: {
      oneezy: { version: "0.43.2", skills: ["oneezy-merge", "oneezy-status"] },
      design: { version: null, skills: ["frontend-design", "slop-check"] },
    },
  });
  const own = await startFakeGithub({ repo: "oneezy/skills", releases: [older], contents: {} });
  try {
    const m = machine({ github: own }, older);
    const first = await cli(m, []);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(installed(m), [
      ["design@oneezy-skills", null, true, "git"],
      ["oneezy@oneezy-skills", "0.43.1", true, "git"],
    ]);
    // the library moves: release-18 on GitHub, main at its commit
    own.addRelease(newer);
    githubClone(m, newer);
    const r = await cli(m, []);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(calls(r, UPGRADE), 1, JSON.stringify(r.calls));
    assert.equal(r.calls.filter((c) => c[2] === "add").length, 0, JSON.stringify(r.calls));
    const upgrade = lines(r).find((l) => l.startsWith("+ install") && l.includes("upgrade:"));
    assert.ok(upgrade?.includes("design missing slop-check") && upgrade.includes("oneezy 0.43.1 -> 0.43.2"), r.stdout);
    assert.deepEqual(installed(m), [
      ["design@oneezy-skills", null, true, "git"],
      ["oneezy@oneezy-skills", "0.43.2", true, "git"],
    ]);
    // the plugins verified at the new release: status is green, and the next sync has nothing to do
    const s = await cli(m, ["status"]);
    assert.equal(s.status, 0, s.stdout);
    const again = await cli(m, []);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(again.calls.filter(mutating), []);
    assert.ok(lines(again).at(-1)?.startsWith("0 changed"), again.stdout);
  } finally {
    await own.close();
  }
});

test("library copies go only after the plugin carrying them verifies: a failed plugin add is a conflict and keeps that plugin's copies, the next sync removes them", async () => {
  const m = machine();
  oldSkillsSync(m);
  // the four copies the tool left: a link into ~/.skills-sync, one into a checkout (in Codex's old folder), a dangling
  // link, and a real folder with the release's own SKILL.md
  const viaHome = looseLink(m, "codex", "oneezy-status");
  const checkout = libraryCheckout(m);
  const viaCheckout = looseLink(
    m,
    "codex",
    "grilling",
    path.join(checkout, "skills", "matt-pocock", "grilling"),
    codexLegacySkills(m),
  );
  const gone = path.join(m.base, "gone");
  const dangling = looseLink(m, "codex", "tdd", path.join(gone, "tdd"));
  fs.rmSync(gone, { recursive: true });
  const copy = releaseCopy(m, "codex", "oneezy-merge", r17, codexLegacySkills(m));
  for (const p of [viaHome, viaCheckout, dangling]) assert.ok(isLink(p), p);

  const failed = await cli(m, ["--json"], { FAKE_HARNESS_FAIL_ADD: "oneezy@oneezy-skills" });
  assert.equal(failed.status, 1, failed.stderr);
  const conflicts = actions(failed).filter((a) => a.kind === "conflict");
  assert.deepEqual(
    conflicts.map((a) => [a.path, a.note]),
    [["Codex: plugin oneezy@oneezy-skills", "codex plugin add failed; its copies stay"]],
  );
  // oneezy's copies stay; matt-pocock verified, so its link into the checkout and the dangling one went
  assert.ok(isLink(viaHome), "the link to the library copy of oneezy-status stays");
  assert.ok(fs.existsSync(path.join(copy, "SKILL.md")), "the real copy of oneezy-merge stays");
  assert.equal(lexists(viaCheckout), false, viaCheckout);
  assert.equal(lexists(dangling), false, dangling);
  assert.deepEqual(
    actions(failed)
      .filter((a) => a.kind === "remove" || a.kind === "delete")
      .map((a) => [a.kind, a.path, a.note]),
    [
      ["remove", dangling, "dangling link; carried by matt-pocock@oneezy-skills"],
      ["remove", viaCheckout, "library copy; carried by matt-pocock@oneezy-skills"],
    ],
  );
  assert.deepEqual(installed(m), [
    ["matt-pocock@oneezy-skills", "1.3.1", true, "git"],
    ["play@oneezy-skills", "0.43.0", true, "git"],
  ]);

  // codex works again: oneezy installs and verifies, and its two copies go
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls(r, addPlugin("oneezy")), 1);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "remove" || a.kind === "delete")
      .map((a) => [a.kind, a.path, a.note]),
    [
      ["remove", viaHome, "library copy; carried by oneezy@oneezy-skills"],
      ["delete", copy, "library copy; carried by oneezy@oneezy-skills"],
    ],
  );
  assert.equal(lexists(viaHome), false);
  assert.equal(lexists(copy), false);
  // the library the link pointed into is untouched: only the link went
  assert.ok(fs.existsSync(path.join(m.base, "old-library", ".agents", "skills", "oneezy-status", "SKILL.md")));
  assert.deepEqual(installed(m), ALL_17);
});

test("each skill name is listed once afterwards: status shows no duplicate, no loose link and no folder for Codex, and a third sync changes nothing", async () => {
  const m = machine();
  oldSkillsSync(m);
  looseLink(m, "codex", "oneezy-status");
  looseLink(m, "codex", "grilling", undefined, codexLegacySkills(m));
  releaseCopy(m, "codex", "tdd", r17, codexLegacySkills(m));
  const before = await cli(m, ["status", "--json"]);
  assert.equal(before.status, 1);
  assert.ok((before.json as unknown as StatusJson).harnesses.codex.loose.length === 2);
  assert.equal((await cli(m, [])).status, 0);
  const s = await cli(m, ["status", "--json"]);
  assert.equal(s.status, 0, s.stdout);
  const codex = (s.json as unknown as StatusJson).harnesses.codex;
  assert.deepEqual([codex.duplicates, codex.loose, codex.folders], [[], [], []]);
  assert.deepEqual(
    codex.lines.map((l) => l.text),
    [
      "matt-pocock@oneezy-skills 1.3.1 (latest 1.3.1)",
      "oneezy@oneezy-skills 0.43.1 (latest 0.43.1)",
      "play@oneezy-skills 0.43.0 (latest 0.43.0)",
    ],
  );
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(lines(again).at(-1)?.startsWith("0 changed"), again.stdout);
  assert.deepEqual(again.calls.filter(mutating), []);
});

test(".system is never listed or touched; a folder that is not the library's stays and is listed adopt-or-delete, so is a link to somewhere else", async () => {
  const m = machine();
  const system = systemSkill(m, "skill-installer");
  const own = skillFolder(m, "codex", "my-own", codexLegacySkills(m));
  const mine = skillFolder(m, "codex", "mine-too");
  // a library skill's name, but not the library's bytes: Justin's to judge
  const edited = skillFolder(m, "codex", "tdd", codexLegacySkills(m));
  const elsewhere = looseLink(m, "codex", "elsewhere", path.join(m.base, "elsewhere", "elsewhere"));
  const systemBefore = snapshot(system);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  for (const f of [own, mine, edited]) assert.ok(fs.existsSync(path.join(f, "SKILL.md")), f);
  assert.ok(isLink(elsewhere));
  assert.deepEqual(snapshot(system), systemBefore);
  assert.ok(!JSON.stringify(r.json).includes(".system"), r.stdout);
  const notes = actions(r).filter((a) => a.kind === "note" && !a.path.startsWith("Codex"));
  const byPath = (a: [string, string | undefined], b: [string, string | undefined]) => a[0].localeCompare(b[0]);
  assert.deepEqual(
    notes.map((a): [string, string | undefined] => [a.path, a.note]).sort(byPath),
    (
      [
        [edited, "not from the library; adopt it into oneezy/skills or delete it by hand"],
        [
          elsewhere,
          `links to ${path.join(m.base, "elsewhere", "elsewhere")}, not a library copy; adopt it into oneezy/skills or delete it by hand`,
        ],
        [mine, "not from the library; adopt it into oneezy/skills or delete it by hand"],
        [own, "not from the library; adopt it into oneezy/skills or delete it by hand"],
      ] as [string, string | undefined][]
    ).sort(byPath),
  );
  assert.deepEqual(
    actions(r).filter((a) => a.kind === "remove" || a.kind === "delete"),
    [],
  );
  // the text run says the same, one line per folder
  const text = await cli(m, []);
  assert.equal(text.status, 0);
  assert.equal(
    lines(text).filter((l) => l.startsWith(". note") && l.includes("adopt it into oneezy/skills")).length,
    4,
  );
  assert.ok(lines(text).at(-1)?.startsWith("0 changed"), text.stdout);
});

test("an old marketplace of the library's name registered from a local folder is replaced by the GitHub one; the plugins Codex kept are reinstalled from it", async () => {
  const m = machine();
  // the old tool's form: ~/.skills-sync registered as the marketplace, one plugin installed from it, behind
  const root = path.dirname(
    path.dirname(
      installedPlugin(m, "codex", "oneezy", { version: "0.43.0", skills: ["oneezy-merge", "oneezy-status"] }),
    ),
  );
  assert.deepEqual(marketplaces(m), [[MKT, "local", root]]);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter(mutating).map((c) => c.slice(1).join(" ")),
    [
      `plugin marketplace remove ${MKT} --json`,
      "plugin marketplace add oneezy/skills --json",
      "plugin add matt-pocock@oneezy-skills --json",
      "plugin add play@oneezy-skills --json",
      `plugin marketplace upgrade ${MKT} --json`,
    ],
  );
  assert.deepEqual(
    actions(r)
      .filter((a) => a.path === `Codex: marketplace ${MKT}`)
      .map((a) => [a.kind, a.note]),
    [
      ["uninstall", `was the local folder ${root}`],
      ["install", "from GitHub oneezy/skills"],
      ["install", "upgrade: oneezy 0.43.0 -> 0.43.1"],
    ],
  );
  assert.deepEqual(marketplaces(m), [[MKT, "git", "https://github.com/oneezy/skills.git"]]);
  assert.deepEqual(installed(m), ALL_17);
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(again.calls.filter(mutating), []);
});

test("a plugin of the same name from another marketplace is left as it is and noted with how to uninstall it by hand", async () => {
  const m = machine();
  installedPlugin(m, "codex", "oneezy", {
    marketplace: "created-by-me-remote",
    version: "0.43.1",
    skills: ["oneezy-merge", "oneezy-status"],
  });
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.filter((c) => c[2] === "remove").length, 0, JSON.stringify(r.calls));
  const note = actions(r).find((a) => a.path === "Codex: plugin oneezy@created-by-me-remote");
  assert.equal(note?.kind, "note");
  assert.equal(
    note?.note,
    "lists every skill of oneezy a second time beside oneezy@oneezy-skills; uninstall it by hand: ChatGPT > Plugins > Installed > Uninstall plugin, or codex plugin remove oneezy@created-by-me-remote",
  );
  assert.deepEqual(installed(m), [
    ALL_17[0],
    ["oneezy@created-by-me-remote", "0.43.1", true, "local"],
    ...ALL_17.slice(1),
  ]);
  // until Justin removes it, status says the skills are listed twice
  const s = await cli(m, ["status", "--json"]);
  assert.equal(s.status, 1);
  assert.deepEqual(
    (s.json as unknown as StatusJson).harnesses.codex.duplicates.map((d) => d.skill),
    ["oneezy-merge", "oneezy-status"],
  );
});

test("--plan lists every action and changes nothing: no file, no link, no plugin command that writes", async () => {
  const m = machine();
  oldSkillsSync(m);
  const link = looseLink(m, "codex", "oneezy-status");
  const copy = releaseCopy(m, "codex", "grilling", r17, codexLegacySkills(m));
  const own = skillFolder(m, "codex", "my-own", codexLegacySkills(m));
  const before = snapshot(m.home);
  const r = await cli(m, ["--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    actions(r).map((a) => [a.kind, a.path]),
    [
      ["write", path.join(m.codexHome, "AGENTS.md")],
      ["install", `Codex: marketplace ${MKT}`],
      ["install", "Codex: plugin matt-pocock@oneezy-skills"],
      ["install", "Codex: plugin oneezy@oneezy-skills"],
      ["install", "Codex: plugin play@oneezy-skills"],
      ["remove", link],
      ["delete", copy],
      ["note", own],
    ],
  );
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual(r.calls.filter(mutating), [], JSON.stringify(r.calls));
  assert.deepEqual(installed(m), []);
  assert.deepEqual(marketplaces(m), []);
  const text = await cli(m, ["--plan"]);
  assert.equal(lines(text).at(-1), "plan: 7 would change, 0 already right, 0 left alone");
  assert.deepEqual(snapshot(m.home), before);
});

test("a library plugin Codex has disabled is left disabled and noted; its copies stay", async () => {
  const m = machine();
  oldSkillsSync(m);
  const link = looseLink(m, "codex", "oneezy-status");
  // installed as the user would, then switched off in Codex
  assert.equal(fakeCli(m, "codex", ["plugin", "marketplace", "add", "oneezy/skills", "--json"]).status, 0);
  assert.equal(fakeCli(m, "codex", ["plugin", "add", "oneezy@oneezy-skills", "--json"]).status, 0);
  codexPluginEnabled(m, "oneezy@oneezy-skills", false);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const note = actions(r).find((a) => a.path === "Codex: plugin oneezy@oneezy-skills");
  assert.deepEqual([note?.kind, note?.note], ["note", "installed but disabled; left as it is, its copies stay"]);
  assert.ok(isLink(link));
  assert.equal(calls(r, addPlugin("oneezy")), 0);
  assert.deepEqual(installed(m), [
    ["matt-pocock@oneezy-skills", "1.3.1", true, "git"],
    ["oneezy@oneezy-skills", "0.43.1", false, "git"],
    ["play@oneezy-skills", "0.43.0", true, "git"],
  ]);
});

test("a plugin Codex cannot show loading its skills is installed but not verified: a conflict, its copies stay", async () => {
  const m = machine();
  oldSkillsSync(m);
  const link = looseLink(m, "codex", "oneezy-status");
  const r = await cli(m, ["--json"], { FAKE_HARNESS_FAIL_PROMPT: "codex" });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(installed(m), ALL_17);
  const conflicts = actions(r).filter((a) => a.kind === "conflict");
  assert.equal(conflicts.length, 3, JSON.stringify(conflicts));
  assert.ok(
    conflicts.every(
      (a) => a.note === "installed but not verified (codex cannot list its plugin skills); its copies stay",
    ),
    JSON.stringify(conflicts),
  );
  assert.ok(isLink(link));
});

test("without the release, or without a codex that lists plugins, nothing is installed or removed and the run says why", async () => {
  const offline = machine({ github: null });
  oldSkillsSync(offline);
  const link = looseLink(offline, "codex", "oneezy-status");
  const r = await cli(offline, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  const note = actions(r).find((a) => a.path === "Codex: plugins from GitHub");
  assert.deepEqual([note?.kind, note?.note], ["note", "latest release not read; nothing installed, nothing removed"]);
  assert.ok(isLink(link));
  assert.deepEqual(r.calls.filter(mutating), []);
  assert.deepEqual(installed(offline), []);

  const old = machine();
  oldSkillsSync(old);
  const kept = looseLink(old, "codex", "oneezy-status");
  const o = await cli(old, ["--json"], { FAKE_HARNESS_OLD: "codex" });
  assert.equal(o.status, 1, o.stderr);
  const conflict = actions(o).find((a) => a.path === "Codex: plugins from GitHub");
  assert.deepEqual(
    [conflict?.kind, conflict?.note],
    ["conflict", "codex cannot list its plugins; nothing installed, nothing removed"],
  );
  assert.ok(isLink(kept));
  assert.deepEqual(o.calls.filter(mutating), []);
});
