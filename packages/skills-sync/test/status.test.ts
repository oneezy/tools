// status: the first machine command. On a machine with no library it reads the latest oneezy/skills release from
// GitHub (the fake one, through SKILLS_SYNC_GITHUB_API) and shows, per detected harness, its form, each plugin against
// the latest release, and every skill name listed twice. The CLI runs as a process on the pretend machine
// (test/machine.ts); the tests assert only output, --json and exit codes, and that nothing was cloned or linked. The
// hook, block, checkout and manual-step lines (tools#155) have their own file, test/status-done.test.ts; here each
// harness starts with its hook entry and block in place (doneHarness) so only the plugin lines are under test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { lexists, linkTarget } from "../src/fs.js";
import { VERSION } from "../src/version.js";
import { fixtureRelease, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  codexLegacySkills,
  destroy,
  doneHarness,
  globalFile,
  hooksFile,
  installedPlugin,
  looseLink,
  pretendMachine,
  skillFolder,
  snapshot,
  syncedPlugin,
  write,
  type PretendMachine,
} from "./machine.js";

interface Line {
  ok: boolean;
  text: string;
}
interface HarnessJson {
  name: string;
  form: string;
  note?: string;
  plugins: {
    synced: Array<{
      id: string;
      version: string | null;
      latest: string | null;
      current: boolean;
      skills: string[];
      enabled: boolean;
    }>;
    installed: Array<{
      id: string;
      marketplace: string;
      version: string | null;
      latest: string | null;
      current: boolean;
      skills: string[] | null;
    }>;
    other: Array<{ id: string; marketplace: string | null }>;
  };
  loose: Array<{ name: string; target: string }>;
  folders: Array<{ name: string }>;
  duplicates: Array<{ skill: string; in: string[] }>;
  lines: Line[];
}
interface StatusJson {
  release: { repo: string; tag: string; number: number; commit: string; tool: string | null } | null;
  error?: string;
  cloud: boolean;
  harnesses: Record<string, HarnessJson>;
  lines: Line[];
  manualSteps: Array<{ id: string }>;
  ok: boolean;
}

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

/** A machine whose harnesses have their hook entry and block in place already: the plugin lines alone are under test. */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, ...options });
  machines.push(m);
  for (const h of options.harnesses ?? ["claude-code", "codex"]) if (h !== "hermes") doneHarness(m, h);
  return m;
}

const red = (lines: Line[]) => lines.filter((l) => !l.ok).map((l) => l.text);
/** The two green lines every done harness shows after its plugin and duplicate lines. */
const done = (m: PretendMachine, h: "claude-code" | "codex") => [
  `= session hook in ${hooksFile(m, h)}`,
  `= global block in ${globalFile(m, h)} current`,
];
const NO_CHECKOUT =
  ". no checkout of oneezy/skills or oneezy/tools in reach (the repository here and the folders beside it)";

test("status on a machine with no library reads the latest release and says what each harness lacks, cloning and linking nothing", async () => {
  const m = machine();
  const before = snapshot(m.home);
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const s = r.json as unknown as StatusJson;
  assert.deepEqual(s.release, {
    repo: "oneezy/skills",
    tag: "release-17",
    number: 17,
    commit: "1717171717171717171717171717171717171717",
    tool: null,
  });
  assert.equal(s.cloud, false);
  assert.deepEqual(Object.keys(s.harnesses).sort(), ["claude-code", "codex"]);
  assert.equal(s.harnesses["claude-code"].form, "account-plugins");
  assert.equal(s.harnesses.codex.form, "github-plugins");
  for (const id of ["claude-code", "codex"])
    assert.deepEqual(red(s.harnesses[id].lines), ["no plugins installed (latest release-17)"], id);
  assert.equal(s.ok, false);
  // nothing cloned, nothing linked, nothing remembered: the home is as it was and GitHub was only read
  assert.equal(lexists(path.join(m.home, ".skills-sync")), false);
  assert.deepEqual(snapshot(m.home), before);
  assert.ok(r.requests.length > 0 && r.requests.every((q) => q.method === "GET"), JSON.stringify(r.requests));
  assert.ok(r.requests.some((q) => q.path === "/repos/oneezy/skills/releases/latest"));
  assert.ok(!fs.existsSync(path.join(m.home, "skills")));
});

test("account plugins are compared with the release: current ones green, one behind red, in text and --json; all current exits 0", async () => {
  const m = machine({ harnesses: ["claude-code"] });
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"] });
  syncedPlugin(m, "play", { files: r17.plugins.play.files });
  const r = await cli(m, ["status"]);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(
    r.stdout,
    [
      "latest: oneezy/skills release-17 (1717171)",
      "Claude Code  form: account plugins",
      "! matt-pocock@synced 1.3.0 (latest 1.3.1); start a new Claude Code session",
      "= oneezy@synced 0.43.1 (latest 0.43.1)",
      "= play@synced 0.43.0 (latest 0.43.0)",
      ...done(m, "claude-code"),
      NO_CHECKOUT,
      "status: 1 red line",
      "",
    ].join("\n"),
  );
  const j = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(
    j.harnesses["claude-code"].plugins.synced.map((p) => [p.id, p.version, p.latest, p.current, p.skills]),
    [
      ["matt-pocock", "1.3.0", "1.3.1", false, ["grilling", "tdd"]],
      ["oneezy", "0.43.1", "0.43.1", true, ["oneezy-merge", "oneezy-status"]],
      ["play", "0.43.0", "0.43.0", true, ["play-unslop"]],
    ],
  );
  assert.deepEqual(red(j.harnesses["claude-code"].lines), [
    "matt-pocock@synced 1.3.0 (latest 1.3.1); start a new Claude Code session",
  ]);
  // the same claude.ai sync brings matt-pocock up: everything green, exit 0
  syncedPlugin(m, "matt-pocock", { files: r17.plugins["matt-pocock"].files });
  const ok = await cli(m, ["status"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(
    ok.stdout,
    [
      "latest: oneezy/skills release-17 (1717171)",
      "Claude Code  form: account plugins",
      "= matt-pocock@synced 1.3.1 (latest 1.3.1)",
      "= oneezy@synced 0.43.1 (latest 0.43.1)",
      "= play@synced 0.43.0 (latest 0.43.0)",
      ...done(m, "claude-code"),
      NO_CHECKOUT,
      "status: all green",
      "",
    ].join("\n"),
  );
  // a plugin at the right version but missing a skill the release carries is behind too
  fs.rmSync(path.join(m.claudeHome, "plugins", "synced", "org-1111_bucket-2222", "oneezy", "skills", "oneezy-merge"), {
    recursive: true,
  });
  const partial = await cli(m, ["status", "--json"]);
  assert.equal(partial.status, 1);
  assert.deepEqual(red((partial.json as unknown as StatusJson).harnesses["claude-code"].lines), [
    "oneezy@synced 0.43.1 (latest 0.43.1; skills differ: missing oneezy-merge); start a new Claude Code session",
  ]);
});

test("a skill listed twice on a harness is a red line naming each place: a plugin and a loose link, a link and a real folder in Codex's old folder", async () => {
  const m = machine();
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  const link = looseLink(m, "claude-code", "oneezy-status");
  const target = linkTarget(link)!;
  installedPlugin(m, "codex", "oneezy", { files: r17.plugins.oneezy.files, version: "0.43.1" });
  const codexLink = looseLink(m, "codex", "grilling");
  const folder = skillFolder(m, "codex", "grilling", codexLegacySkills(m));
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const s = r.json as unknown as StatusJson;
  const claude = s.harnesses["claude-code"];
  assert.deepEqual(claude.duplicates, [{ skill: "oneezy-status", in: ["oneezy@synced", `loose link -> ${target}`] }]);
  assert.deepEqual(
    claude.loose.map((l) => [l.name, l.target]),
    [["oneezy-status", target]],
  );
  assert.deepEqual(red(claude.lines), [`oneezy-status listed twice: oneezy@synced, loose link -> ${target}`]);
  const codex = s.harnesses.codex;
  assert.deepEqual(codex.duplicates, [
    { skill: "grilling", in: [`loose link -> ${linkTarget(codexLink)!}`, `folder ${folder}`] },
  ]);
  assert.deepEqual(
    codex.folders.map((f) => f.name),
    ["grilling"],
  );
  // the plugin itself is current: only the duplicate is red
  assert.deepEqual(red(codex.lines), [
    `grilling listed twice: loose link -> ${linkTarget(codexLink)!}, folder ${folder}`,
  ]);
  assert.ok(
    codex.lines.some((l) => l.ok && l.text === "oneezy@oneezy-skills 0.43.1 (latest 0.43.1)"),
    JSON.stringify(codex.lines),
  );
  const text = await cli(m, ["status"]);
  assert.ok(
    text.stdout.includes(`\n! oneezy-status listed twice: oneezy@synced, loose link -> ${target}\n`),
    text.stdout,
  );
  // beside the red lines, two manual steps: the account plugins not delivered, and Codex's link and folder (not the
  // library's) to adopt or delete
  assert.ok(text.stdout.endsWith("status: 2 red lines, 2 manual steps\n"), text.stdout);
  // a third place counts: the account plugin, a plugin the tool installed and a real folder, all named
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-merge"] });
  const folder3 = skillFolder(m, "claude-code", "oneezy-merge");
  const three = await cli(m, ["status"]);
  assert.ok(
    three.stdout.includes(`\n! oneezy-merge listed 3 times: oneezy@synced, oneezy@oneezy-skills, folder ${folder3}\n`),
    three.stdout,
  );
});

test("account plugins from other marketplaces, tool-installed plugins and plugins from elsewhere are told apart, per harness", async () => {
  const m = machine();
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  syncedPlugin(m, "data", { version: "1.1.0", skills: ["analyze"], marketplace: "anthropic-plugin-directory" });
  // the PC today: the tool installed the library's plugins through claude, which now hide the account ones
  installedPlugin(m, "claude-code", "oneezy", { version: "c69993a67bba", skills: ["oneezy-merge", "oneezy-status"] });
  installedPlugin(m, "claude-code", "foo", { version: "1.0.0", skills: ["foo-skill"], marketplace: "elsewhere" });
  installedPlugin(m, "codex", "oneezy", { version: "0.43.0", skills: ["oneezy-merge", "oneezy-status"] });
  installedPlugin(m, "codex", "matt-pocock", { version: "1.3.1", skills: ["grilling", "tdd"] });
  installedPlugin(m, "codex", "play", { version: "0.43.0", skills: ["play-unslop"], enabled: false });
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const s = r.json as unknown as StatusJson;
  const claude = s.harnesses["claude-code"];
  assert.deepEqual(
    claude.plugins.synced.map((p) => p.id),
    ["oneezy"],
  );
  assert.deepEqual(
    claude.plugins.installed.map((p) => [p.id, p.marketplace, p.version]),
    [["oneezy", "oneezy-skills", "c69993a67bba"]],
  );
  assert.deepEqual(
    claude.plugins.other.map((p) => [p.id, p.marketplace]),
    [
      ["data", "anthropic-plugin-directory"],
      ["foo", "elsewhere"],
    ],
  );
  assert.deepEqual(red(claude.lines), [
    "oneezy@oneezy-skills c69993a67bba installed by the tool; the form is account plugins",
    "oneezy-merge listed twice: oneezy@synced, oneezy@oneezy-skills",
    "oneezy-status listed twice: oneezy@synced, oneezy@oneezy-skills",
  ]);
  const codex = s.harnesses.codex;
  assert.deepEqual(
    codex.plugins.installed.map((p) => [p.id, p.version, p.latest, p.current]),
    [
      ["matt-pocock", "1.3.1", "1.3.1", true],
      ["oneezy", "0.43.0", "0.43.1", false],
      ["play", "0.43.0", "0.43.0", false],
    ],
  );
  // a disabled plugin loads nothing, whatever its version
  assert.deepEqual(red(codex.lines), [
    "oneezy@oneezy-skills 0.43.0 (latest 0.43.1); run sync",
    "play@oneezy-skills 0.43.0 installed but disabled",
  ]);
  const text = await cli(m, ["status"]);
  assert.ok(
    text.stdout.includes("\n. 2 other plugins left alone: data@synced (anthropic-plugin-directory), foo@elsewhere\n"),
    text.stdout,
  );
  assert.ok(
    text.stdout.includes(
      "\nCodex  form: plugins from GitHub\n= matt-pocock@oneezy-skills 1.3.1 (latest 1.3.1)\n! oneezy@oneezy-skills 0.43.0 (latest 0.43.1); run sync\n! play@oneezy-skills 0.43.0 installed but disabled\n",
    ),
    text.stdout,
  );
});

test("Hermes has the plugin form (plugins from GitHub): with nothing installed it is red, loose links and folders are counted, and hermes itself is never asked (its plugins are read from its files)", async () => {
  const m = machine({ harnesses: ["hermes"], clis: ["hermes"] });
  const empty = await cli(m, ["status"]);
  assert.equal(empty.status, 1, empty.stderr);
  assert.equal(
    empty.stdout,
    [
      "latest: oneezy/skills release-17 (1717171)",
      "Hermes  form: plugins from GitHub",
      "! no plugins installed (latest release-17)",
      NO_CHECKOUT,
      "status: 1 red line",
      "",
    ].join("\n"),
  );
  const link = looseLink(m, "hermes", "grilling");
  const folder = skillFolder(m, "hermes", "oneezy-status");
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const hermes = (r.json as unknown as StatusJson).harnesses.hermes;
  assert.equal(hermes.form, "github-plugins");
  assert.deepEqual(
    hermes.loose.map((l) => [l.name, l.target]),
    [["grilling", linkTarget(link)!]],
  );
  assert.deepEqual(hermes.folders, [{ name: "oneezy-status", path: folder }]);
  assert.deepEqual(hermes.duplicates, []);
  assert.deepEqual(
    hermes.lines.map((l) => [l.ok, l.text]),
    [
      [false, "no plugins installed (latest release-17)"],
      [true, "1 loose link, 1 skill folder"],
    ],
  );
  // Codex's steps (other marketplaces, adopt or delete) are not Hermes's: its form prints its own notes in sync
  assert.deepEqual((r.json as unknown as StatusJson).manualSteps, []);
  assert.deepEqual(r.calls, []);
});

test("when Codex cannot render its prompt input, a plugin's skills are not read: the version alone is judged and the harness says so", async () => {
  const m = machine({ harnesses: ["codex"] });
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  installedPlugin(m, "codex", "oneezy", { files: r17.plugins.oneezy.files, version: "0.43.1" });
  looseLink(m, "codex", "oneezy-status");
  const r = await cli(m, ["status", "--json"], { FAKE_HARNESS_FAIL_PROMPT: "codex" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const codex = (r.json as unknown as StatusJson).harnesses.codex;
  assert.equal(codex.note, "codex cannot list its plugin skills");
  assert.deepEqual(
    codex.plugins.installed.map((p) => [p.id, p.version, p.latest, p.current, p.skills]),
    [["oneezy", "0.43.1", "0.43.1", true, null]],
  );
  // skills nobody could read are no place for a duplicate
  assert.deepEqual(codex.duplicates, []);
  assert.deepEqual(
    codex.lines.map((l) => [l.ok, l.text]),
    [
      [true, "codex cannot list its plugin skills"],
      [true, "oneezy@oneezy-skills 0.43.1 (latest 0.43.1; skills not read)"],
      ...done(m, "codex").map((t) => [true, t.slice(2)]),
      [true, "1 loose link, 0 skill folders"],
    ],
  );
  // a version behind the release is red all the same
  installedPlugin(m, "codex", "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"] });
  const behind = await cli(m, ["status"], { FAKE_HARNESS_FAIL_PROMPT: "codex" });
  assert.equal(behind.status, 1);
  assert.ok(
    behind.stdout.includes("\n! matt-pocock@oneezy-skills 1.3.0 (latest 1.3.1; skills not read); run sync\n"),
    behind.stdout,
  );
});

test("a plugin switched off loads nothing: its skills are no place for a duplicate, and a disabled account plugin is listed, never judged", async () => {
  const m = machine({ harnesses: ["claude-code"] });
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  // another marketplace's plugin, disabled, carrying a skill of the same name as the library's
  installedPlugin(m, "claude-code", "foo", {
    version: "1.0.0",
    skills: ["oneezy-status"],
    marketplace: "elsewhere",
    enabled: false,
  });
  // an account plugin switched off at claude.ai, behind the release, carrying grilling, which a loose link also has
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"], enabled: false });
  const link = looseLink(m, "claude-code", "grilling");
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const claude = (r.json as unknown as StatusJson).harnesses["claude-code"];
  assert.deepEqual(claude.duplicates, []);
  assert.deepEqual(
    claude.plugins.synced.map((p) => [p.id, p.enabled, p.current]),
    [
      ["matt-pocock", false, false],
      ["oneezy", true, true],
    ],
  );
  assert.deepEqual(
    claude.plugins.other.map((p) => [p.id, p.marketplace]),
    [["foo", "elsewhere"]],
  );
  assert.deepEqual(
    claude.lines.map((l) => [l.ok, l.text]),
    [
      [true, "matt-pocock@synced 1.3.0 disabled (latest 1.3.1)"],
      [true, "oneezy@synced 0.43.1 (latest 0.43.1)"],
      ...done(m, "claude-code").map((t) => [true, t.slice(2)]),
      [true, "1 loose link, 0 skill folders"],
      [true, "1 other plugin left alone: foo@elsewhere"],
    ],
  );
  const text = await cli(m, ["status"]);
  assert.ok(text.stdout.includes("\n. matt-pocock@synced 1.3.0 disabled (latest 1.3.1)\n"), text.stdout);
  // switched back on at claude.ai, the same plugin is judged and its skills count
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"], enabled: true });
  const on = await cli(m, ["status", "--json"]);
  assert.equal(on.status, 1);
  assert.deepEqual(red((on.json as unknown as StatusJson).harnesses["claude-code"].lines), [
    "matt-pocock@synced 1.3.0 (latest 1.3.1); start a new Claude Code session",
    `grilling listed twice: matt-pocock@synced, loose link -> ${linkTarget(link)!}`,
  ]);
});

test("--quiet prints only the red lines under their harness and the summary; a green machine prints nothing", async () => {
  const m = machine({ harnesses: ["claude-code"] });
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  for (const id of ["oneezy", "matt-pocock", "play"]) syncedPlugin(m, id, { files: r17.plugins[id].files });
  const green = await cli(m, ["status", "--quiet"]);
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.stdout, "");
  looseLink(m, "claude-code", "oneezy-status");
  const loud = await cli(m, ["status", "--quiet"]);
  assert.equal(loud.status, 1);
  assert.match(
    loud.stdout,
    /^Claude Code  form: account plugins\n! oneezy-status listed twice: .*\nstatus: 1 red line\n$/,
  );
});

test("without the claude CLI the account plugins are read from their folders and the missing CLI is noted", async () => {
  const m = machine({ harnesses: ["claude-code"], clis: ["codex"] });
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  syncedPlugin(m, "matt-pocock", { version: "1.3.0", skills: ["grilling", "tdd"] });
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const claude = (r.json as unknown as StatusJson).harnesses["claude-code"];
  assert.deepEqual(
    claude.plugins.synced.map((p) => [p.id, p.version, p.current]),
    [
      ["matt-pocock", "1.3.0", false],
      ["oneezy", "0.43.1", true],
    ],
  );
  assert.ok(
    claude.lines.some((l) => l.ok && l.text === "no claude on PATH"),
    JSON.stringify(claude.lines),
  );
  assert.deepEqual(r.calls, []);
});

test("when Codex is missing, or cannot list its plugins, its plugins are not read: one red line says so, not that nothing is installed", async () => {
  const absent = machine({ harnesses: ["codex"], clis: ["claude"] });
  const r = await cli(absent, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const codex = (r.json as unknown as StatusJson).harnesses.codex;
  assert.deepEqual(red(codex.lines), ["plugins not read (no codex on PATH; latest release-17)"]);
  const failing = machine({ harnesses: ["codex"] });
  const f = await cli(failing, ["status"], { FAKE_HARNESS_FAIL_LIST: "codex" });
  assert.equal(f.status, 1, f.stderr);
  const out = f.stdout.trimEnd().split("\n");
  assert.ok(out.includes("! plugins not read (codex cannot list its plugins; latest release-17)"), f.stdout);
  assert.ok(!out.some((l) => l.includes("no plugins installed")), f.stdout);
});

test("when GitHub cannot be reached, or the latest release has no release.json, the release line is red and the machine is still described", async () => {
  const m = machine({ github: null, harnesses: ["claude-code"] });
  syncedPlugin(m, "oneezy", { version: "0.43.1", skills: ["oneezy-merge", "oneezy-status"] });
  const r = await cli(m, ["status", "--json"]);
  assert.equal(r.status, 1, r.stderr);
  const s = r.json as unknown as StatusJson;
  assert.equal(s.release, null);
  assert.match(s.error ?? "", /^http:\/\/127\.0\.0\.1:9\/repos\/oneezy\/skills\/releases\/latest: /);
  assert.deepEqual(red(s.lines), [`latest release of oneezy/skills: ${s.error}`]);
  assert.deepEqual(
    s.harnesses["claude-code"].plugins.synced.map((p) => [p.id, p.version, p.latest, p.current]),
    [["oneezy", "0.43.1", null, false]],
  );
  assert.deepEqual(red(s.harnesses["claude-code"].lines), []);
  const text = await cli(m, ["status"]);
  assert.equal(
    text.stdout.replace(/^! latest release of oneezy\/skills: .*\n/, "! latest release\n"),
    [
      "! latest release",
      "Claude Code  form: account plugins",
      ". oneezy@synced 0.43.1 (latest unknown)",
      ...done(m, "claude-code"),
      NO_CHECKOUT,
      "status: 1 red line",
      "",
    ].join("\n"),
  );

  const bare = await startFakeGithub({
    repo: "oneezy/skills",
    releases: [
      {
        ...fixtureRelease({
          number: 18,
          commit: "1818181818181818181818181818181818181818",
          plugins: {},
          toolVersion: "0.8.0",
        }),
        noReleaseJson: true,
      },
    ],
  });
  try {
    const m2 = machine({ github: bare, harnesses: ["claude-code"] });
    const r2 = await cli(m2, ["status", "--json"]);
    assert.equal(r2.status, 1);
    assert.equal((r2.json as unknown as StatusJson).error, "oneezy/skills release-18: no release.json asset");
  } finally {
    await bare.close();
  }
});

test("--library names another release repo; a token from the environment is sent as a bearer; anything but owner/repo is a usage error", async () => {
  const other = await startFakeGithub({
    repo: "someone/library",
    token: "fixture-token",
    releases: [
      fixtureRelease({
        repo: "someone/library",
        number: 3,
        commit: "0303030303030303030303030303030303030303",
        plugins: { tools: { version: "2.0.0", skills: ["one"] } },
        toolVersion: "0.8.0",
      }),
    ],
  });
  try {
    const m = machine({ github: other, harnesses: ["claude-code"] });
    syncedPlugin(m, "tools", { version: "2.0.0", skills: ["one"] });
    const anonymous = await cli(m, ["status", "--json", "--library", "someone/library"]);
    assert.equal(anonymous.status, 1);
    assert.match((anonymous.json as unknown as StatusJson).error ?? "", /releases\/latest: 401 Bad credentials$/);
    const r = await cli(m, ["status", "--json", "--library", "someone/library"], { GITHUB_TOKEN: "fixture-token" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const s = r.json as unknown as StatusJson;
    assert.deepEqual(s.release, {
      repo: "someone/library",
      tag: "release-3",
      number: 3,
      commit: "0303030303030303030303030303030303030303",
      tool: "0.8.0",
    });
    assert.ok(
      r.requests.every(
        (q) =>
          q.headers.authorization === "Bearer fixture-token" && q.headers["user-agent"] === `skills-sync/${VERSION}`,
      ),
      JSON.stringify(r.requests),
    );
    assert.deepEqual(
      r.requests.map((q) => q.path),
      [
        "/repos/someone/library/releases/latest",
        "/repos/someone/library/releases/assets/3001",
        "/_download/3001",
        "/repos/someone/library/contents/skills-sync.json?ref=0303030303030303030303030303030303030303",
      ],
    );
    const viaGh = await cli(m, ["status", "--json", "--library", "someone/library"], { GH_TOKEN: "fixture-token" });
    assert.equal(viaGh.status, 0, viaGh.stdout);
    const bad = await cli(m, ["status", "--library", "https://github.com/someone/library.git"]);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /owner\/repo/);
    assert.equal(bad.stdout, "");
  } finally {
    await other.close();
  }
});

test("inside a checkout, status still ignores the library and check still runs there without asking GitHub anything", async () => {
  const m = machine({ harnesses: ["claude-code"] });
  const library = path.join(m.base, "checkout");
  write(
    path.join(library, "skills", "oneezy", "oneezy-status", "SKILL.md"),
    "---\nname: oneezy-status\ndescription: status\n---\nbody\n",
  );
  write(path.join(library, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }) + "\n");
  const status = await cli(m, ["status", "--json"], {}, library);
  assert.equal(status.status, 1, status.stderr);
  const s = status.json as unknown as StatusJson;
  assert.equal(s.release?.tag, "release-17");
  assert.ok(!("library" in s) && !("own" in s), "no library facts in a machine command's report");
  assert.equal(lexists(path.join(m.home, ".skills-sync")), false);
  const check = await cli(m, ["check", "--json"], {}, library);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal((check.json as { check?: boolean })?.check, true);
  assert.deepEqual(check.requests, []);
});
