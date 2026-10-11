// unlink takes away what this tool put on the machine, and only that: the plugins it installed from the library's
// catalog (and the catalog's registration once none is left), its loose links (to a library copy, or dangling) in every
// harness skills folder, Codex's old one included, and the skills block in each global instructions file (the file too
// when it held nothing else). An account plugin, a plugin from another marketplace, a link to somewhere else, a real
// skill folder, a hook entry someone else wrote, Codex's trust record and the text around the block stay byte for byte;
// the tool's own session hook entry goes (the hooks file too when it held nothing else). --plan removes nothing and runs
// no plugin command that changes anything; a second unlink has nothing to do.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { isLink, lexists } from "../src/fs.js";
import { HOOK_COMMAND } from "../src/hooks.js";
import { libraryCopy as isLibraryCopy } from "../src/machine.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  blockIn,
  cli,
  codexLegacySkills,
  codexTrust,
  destroy,
  githubClone,
  globalFile,
  hermesConfig,
  hermesPlugin,
  hookEntry,
  installedPlugin,
  libraryCopy,
  looseLink,
  pretendMachine,
  skillFolder,
  snapshot,
  syncedPlugin,
  write,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  target?: string;
  note?: string;
  failed?: boolean;
}

const START = "<!-- skills-sync:skills:start -->";
const END = "<!-- skills-sync:skills:end -->";

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
const state = (dir: string) =>
  JSON.parse(read(path.join(dir, "fake-harness.json"))) as {
    marketplaces: Record<string, string>;
    plugins: Record<string, unknown>;
  };
/** A plugin write through a harness CLI: install, add, uninstall, remove, or a marketplace change. */
const pluginWrite = (c: string[]) =>
  !c.includes("--help") && c.some((w) => ["install", "add", "uninstall", "remove", "update", "upgrade"].includes(w));
/** `text` without its skills block and the newline that closed it: what unlink must leave of a file. */
const without = (text: string) => text.slice(0, text.indexOf(START)) + text.slice(text.indexOf(END) + END.length + 1);

interface Seeded {
  m: PretendMachine;
  claudeSettings: string;
  /** Claude Code's settings.json before the tool's entry joined the user's: what unlink must leave */
  settingsBefore: string;
  codexHooks: string;
  codexConfig: string;
  claudeMd: string;
  codexMd: string;
  mine: string;
  real: string;
  grilling: string;
  gone: string;
  tdd: string;
}

/** A machine the old tool left full: the tool's plugins and links beside a user's own, the blocks, a foreign hook. */
async function seeded(): Promise<Seeded> {
  const m = machine();
  libraryCopy(m);
  const r17 = gh.fixture.releases.find((r) => r.number === 17)!;
  // the library on the pretend GitHub: the sync after unlink gives Codex its plugins from there
  githubClone(m, r17);
  // Claude Code: the account plugin (stays), the tool's plugin from the library's catalog, one from another marketplace
  syncedPlugin(m, "oneezy", { files: r17.plugins.oneezy.files });
  installedPlugin(m, "claude-code", "oneezy", { files: r17.plugins.oneezy.files });
  installedPlugin(m, "claude-code", "tools", { marketplace: "someone-else", version: "2.0.0", skills: ["one"] });
  // Codex: two of the tool's plugins
  installedPlugin(m, "codex", "matt-pocock", { files: r17.plugins["matt-pocock"].files });
  installedPlugin(m, "codex", "play", { files: r17.plugins.play.files });
  // links: to the library copy, dangling, the user's own (outside any library), and a real folder
  const grilling = looseLink(m, "claude-code", "grilling");
  const gone = looseLink(m, "claude-code", "gone");
  fs.rmSync(path.join(m.base, "old-library", ".agents", "skills", "gone"), { recursive: true });
  const mine = looseLink(m, "claude-code", "mine", path.join(m.base, "mine", "mine"));
  const real = skillFolder(m, "claude-code", "real");
  const tdd = looseLink(m, "codex", "tdd", undefined, codexLegacySkills(m));
  // a hook entry someone else wrote, then the tool's own in both harnesses (as a sync left them); Codex trusted the tool's
  const claudeSettings = hookEntry(m, "claude-code", "echo hello");
  const settingsBefore = read(claudeSettings);
  hookEntry(m, "claude-code", HOOK_COMMAND);
  const codexHooks = hookEntry(m, "codex", HOOK_COMMAND);
  const codexConfig = codexTrust(m, 0);
  // the blocks, as a sync left them: Claude's among the user's own text, Codex's alone in its file (a sync here would
  // already take the tool's plugin off Claude Code: the account plugin above outranks it)
  const claudeMd = globalFile(m, "claude-code");
  write(claudeMd, "# Mine\n\nAbove the block.\n");
  blockIn(claudeMd, "skills", "the skills block");
  fs.appendFileSync(claudeMd, "\nBelow the block.\n");
  const codexMd = blockIn(globalFile(m, "codex"), "skills", "the skills block");
  assert.ok(read(codexMd).startsWith(START) && read(codexMd).endsWith(`${END}\n`));
  return {
    m,
    claudeSettings,
    settingsBefore,
    codexHooks,
    codexConfig,
    claudeMd,
    codexMd,
    mine,
    real,
    grilling,
    gone,
    tdd,
  };
}

test("unlink removes the tool's plugins, its marketplace registration, its links, its hook entries and its blocks, and nothing else; --plan changes nothing; a second unlink has nothing to do", async () => {
  const s = await seeded();
  const { m } = s;
  const claudeBefore = read(s.claudeMd);
  const configBefore = read(s.codexConfig);
  const before = snapshot(m.home);
  const claudeState = state(m.claudeHome);
  const codexState = state(m.codexHome);

  const plan = await cli(m, ["unlink", "--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual(state(m.claudeHome), claudeState);
  assert.deepEqual(state(m.codexHome), codexState);
  assert.equal(plan.calls.filter(pluginWrite).length, 0, JSON.stringify(plan.calls));
  assert.equal(plan.requests.length, 0, "unlink reads no release");
  const planned = (plan.json as { actions: ActionJson[] }).actions;
  assert.deepEqual(
    planned.filter((a) => a.kind !== "note").map((a) => [a.kind, a.path, a.note]),
    [
      ["uninstall", "Claude Code: plugin oneezy@oneezy-skills", "installed by this tool"],
      ["uninstall", "Claude Code: marketplace oneezy-skills", "registered by this tool"],
      ["remove", s.gone, "a dangling link"],
      ["remove", s.grilling, "a link to a library copy"],
      ["write", s.claudeSettings, "session hook removed"],
      ["write", s.claudeMd, "skills-sync block (skills) removed"],
      ["uninstall", "Codex: plugin matt-pocock@oneezy-skills", "installed by this tool"],
      ["uninstall", "Codex: plugin play@oneezy-skills", "installed by this tool"],
      ["uninstall", "Codex: marketplace oneezy-skills", "registered by this tool"],
      ["remove", s.tdd, "a link to a library copy"],
      ["delete", s.codexHooks, "held only the skills-sync session hook (Codex)"],
      ["delete", s.codexMd, "held only the skills-sync block (skills)"],
    ],
  );

  const r = await cli(m, ["unlink"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  // the plugins: the tool's gone with its marketplace, the other marketplace's and the account plugin stay
  assert.deepEqual(Object.keys(state(m.claudeHome).plugins), ["tools@someone-else"]);
  assert.deepEqual(Object.keys(state(m.claudeHome).marketplaces), ["someone-else"]);
  assert.deepEqual(state(m.codexHome), { marketplaces: {}, plugins: {} });
  assert.ok(fs.existsSync(path.join(m.claudeHome, "plugins", "synced")), "the account plugin's folder stays");
  assert.deepEqual(
    r.calls.filter(pluginWrite).map((c) => c.join(" ")),
    [
      "claude plugin uninstall oneezy@oneezy-skills --scope user --json",
      "claude plugin marketplace remove oneezy-skills --json",
      "codex plugin remove matt-pocock@oneezy-skills --json",
      "codex plugin remove play@oneezy-skills --json",
      "codex plugin marketplace remove oneezy-skills --json",
    ],
  );
  // the links: the tool's gone, the user's link and folder stay
  for (const gone of [s.grilling, s.gone, s.tdd]) assert.equal(lexists(gone), false, gone);
  assert.ok(lexists(s.mine) && fs.existsSync(path.join(s.mine, "SKILL.md")), "the user's link stays");
  assert.ok(fs.existsSync(path.join(s.real, "SKILL.md")), "a real folder stays");
  // the blocks: Claude's text around it byte for byte, Codex's file gone, the hook file untouched
  assert.equal(read(s.claudeMd), without(claudeBefore));
  assert.equal(read(s.claudeMd), "# Mine\n\nAbove the block.\n\nBelow the block.\n");
  assert.equal(fs.existsSync(s.codexMd), false);
  // the hook entries: the user's stays as it was written, the tool's went with the file it alone wrote; Codex's trust
  // record is Codex's
  assert.equal(read(s.claudeSettings), s.settingsBefore);
  assert.equal(fs.existsSync(s.codexHooks), false);
  assert.equal(read(s.codexConfig), configBefore);
  assert.equal(r.stdout.trimEnd().split("\n").at(-1), "12 changed, 0 already right, 0 left alone");

  const again = await cli(m, ["unlink", "--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.calls.filter(pluginWrite).length, 0, JSON.stringify(again.calls));
  assert.deepEqual(
    (again.json as { actions: ActionJson[] }).actions.filter((a) => a.kind !== "note"),
    [],
  );
  const quiet = await cli(m, ["unlink", "--quiet"]);
  assert.equal(quiet.stdout + quiet.stderr, "");
  // and a sync afterwards puts the blocks and the hook entries back (and Codex's plugins, from GitHub), nothing else of
  // the old state
  const sync = await cli(m, ["--json"]);
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(
    (sync.json as { actions: ActionJson[] }).actions
      .filter((a) => a.kind === "write")
      .map((a) => path.basename(a.path)),
    ["CLAUDE.md", "settings.json", "AGENTS.md", "hooks.json"],
  );
  assert.equal(read(s.claudeMd).includes("Above the block."), true);
});

test("a plugin the CLI refuses to uninstall is one red line with the CLI's words, the marketplace registration stays, the rest still goes; exit 1", async () => {
  const s = await seeded();
  const { m } = s;
  const r = await cli(m, ["unlink", "--json"], { FAKE_HARNESS_FAIL_UNINSTALL: "oneezy@oneezy-skills" });
  assert.equal(r.status, 1, r.stderr);
  const actions = (r.json as { actions: ActionJson[] }).actions;
  const refused = actions.find((a) => a.path === "Claude Code: plugin oneezy@oneezy-skills")!;
  assert.equal(refused.kind, "conflict");
  assert.equal(refused.failed, true);
  assert.equal(refused.note, "claude could not uninstall it");
  assert.ok(!actions.some((a) => a.path === "Claude Code: marketplace oneezy-skills"), JSON.stringify(actions));
  assert.deepEqual(Object.keys(state(m.claudeHome).marketplaces).sort(), ["oneezy-skills", "someone-else"]);
  assert.deepEqual(state(m.codexHome), { marketplaces: {}, plugins: {} }, "Codex's went");
  assert.equal(lexists(s.grilling), false, "the links went");
  assert.equal(fs.existsSync(s.codexMd), false);
});

test("without the harness CLIs only the links and the blocks go: nothing is uninstalled, nothing is asked; a global file with broken markers is left alone and red", async () => {
  const m = machine({ clis: [] });
  libraryCopy(m);
  const grilling = looseLink(m, "claude-code", "grilling");
  const claudeMd = globalFile(m, "claude-code");
  write(claudeMd, `Mine\n${START}\nhalf a block\n`);
  const codexMd = blockIn(globalFile(m, "codex"), "skills", "the skills block");
  const r = await cli(m, ["unlink"]);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.equal(lexists(grilling), false);
  assert.equal(fs.existsSync(codexMd), false);
  assert.equal(read(claudeMd), `Mine\n${START}\nhalf a block\n`);
  assert.ok(
    r.stdout
      .split("\n")
      .some((l) => l.startsWith("!") && l.includes(claudeMd) && l.includes("incomplete managed block")),
    r.stdout,
  );
});

test("when a harness cannot list its plugins, unlink leaves its marketplace registration (Claude Code's remove would take every plugin from it, unseen) and says so; the other harness still goes", async () => {
  const m = machine();
  installedPlugin(m, "claude-code", "oneezy", { version: "1.0.0", skills: ["a"] });
  installedPlugin(m, "codex", "play", { version: "1.0.0", skills: ["b"] });
  const r = await cli(m, ["unlink", "--json"], { FAKE_HARNESS_FAIL_LIST: "claude" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const actions = (r.json as { actions: ActionJson[] }).actions;
  assert.deepEqual(
    actions.filter((a) => a.path.startsWith("Claude Code")).map((a) => [a.kind, a.path, a.note]),
    [
      [
        "note",
        "Claude Code: marketplace oneezy-skills",
        "plugins could not be listed; marketplace left (removing it would take every plugin from it, unseen)",
      ],
    ],
  );
  assert.ok(!r.calls.some((c) => c[0] === "claude" && c.includes("remove")), JSON.stringify(r.calls));
  assert.deepEqual(Object.keys(state(m.claudeHome).plugins), ["oneezy@oneezy-skills"]);
  assert.deepEqual(Object.keys(state(m.claudeHome).marketplaces), ["oneezy-skills"]);
  assert.deepEqual(Object.keys(state(m.codexHome).plugins), []);
  assert.deepEqual(Object.keys(state(m.codexHome).marketplaces), []);
});

test("unlink --library acme/skills takes the acme-skills plugins and registration and the links into an acme checkout; the oneezy-skills ones stay", async () => {
  const m = machine();
  libraryCopy(m, "acme/skills");
  installedPlugin(m, "claude-code", "x", { marketplace: "acme-skills", version: "1.0.0", skills: ["x"] });
  installedPlugin(m, "claude-code", "oneezy", { version: "1.0.0", skills: ["a"] });
  const link = looseLink(m, "claude-code", "x");
  const r = await cli(m, ["unlink", "--library", "acme/skills", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(r.stderr, "");
  const actions = (r.json as { actions: ActionJson[] }).actions;
  assert.deepEqual(
    actions.filter((a) => a.kind !== "note").map((a) => [a.kind, a.path]),
    [
      ["uninstall", "Claude Code: plugin x@acme-skills"],
      ["uninstall", "Claude Code: marketplace acme-skills"],
      ["remove", link],
    ],
  );
  assert.deepEqual(Object.keys(state(m.claudeHome).plugins), ["oneezy@oneezy-skills"]);
  assert.deepEqual(Object.keys(state(m.claudeHome).marketplaces), ["oneezy-skills"]);
  assert.equal(lexists(link), false);
});

test("an older claude whose write commands take no --json: unlink asks each command's help once and sends the uninstall and the marketplace remove without it", async () => {
  const m = machine({ clis: ["claude"] });
  installedPlugin(m, "claude-code", "oneezy", { version: "1.0.0", skills: ["a"] });
  const r = await cli(m, ["unlink"], { FAKE_HARNESS_NO_WRITE_JSON: "claude" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const writes = r.calls.filter((c) => c[0] === "claude" && pluginWrite(c));
  assert.deepEqual(writes, [
    ["claude", "plugin", "uninstall", "oneezy@oneezy-skills", "--scope", "user"],
    ["claude", "plugin", "marketplace", "remove", "oneezy-skills"],
  ]);
  assert.ok(
    r.calls.some((c) => c.slice(0, 4).join(" ") === "claude plugin uninstall --help"),
    JSON.stringify(r.calls),
  );
  assert.ok(
    r.calls.some((c) => c.slice(0, 5).join(" ") === "claude plugin marketplace remove --help"),
    JSON.stringify(r.calls),
  );
  assert.deepEqual(Object.keys(state(m.claudeHome).plugins), []);
  assert.deepEqual(Object.keys(state(m.claudeHome).marketplaces), []);
});

test("a block sync appended to a file goes with the blank line sync put before it, so the file is as it was; a link whose target cannot be read is nobody's leftover", async () => {
  const m = machine({ clis: [] });
  const agents = globalFile(m, "codex");
  write(agents, "mine\n");
  const synced = await cli(m, ["--quiet"]);
  assert.equal(synced.status, 0, synced.stderr + synced.stdout);
  assert.ok(read(agents).startsWith(`mine\n\n${START}`), read(agents));
  const r = await cli(m, ["unlink", "--quiet"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(agents), "mine\n");
  // the rule unlink and the forms share: an empty target (the link could not be read) is never a dangling link
  assert.equal(isLibraryCopy("", "oneezy/skills", m.home), false);
  assert.equal(isLibraryCopy(path.join(m.base, "nowhere"), "oneezy/skills", m.home), true);
});

test("Hermes: unlink removes the plugins hermes recorded as installed from the library (hermes plugins remove) and the tool's links; a folder hermes did not record, one from another repository and a link to somewhere else stay; --plan runs no remove; without hermes on PATH the plugins are named and stay", async () => {
  const m = machine({ harnesses: ["hermes"], clis: ["hermes"] });
  libraryCopy(m);
  const oneezy = hermesPlugin(m, "oneezy", { version: "0.43.1", skills: ["oneezy-merge", "oneezy-status"] });
  const play = hermesPlugin(m, "play", { version: "0.43.1", skills: ["play-unslop"] });
  const copied = hermesPlugin(m, "copied", { version: "1.0.0", skills: ["one"], recorded: false });
  const acme = hermesPlugin(m, "acme", {
    version: "2.0.0",
    skills: ["two"],
    source: "https://github.com/acme/skills.git#dist/hermes/acme",
  });
  const grilling = looseLink(m, "hermes", "grilling");
  const gone = looseLink(m, "hermes", "gone");
  fs.rmSync(path.join(m.base, "old-library", ".agents", "skills", "gone"), { recursive: true });
  const mine = looseLink(m, "hermes", "mine", path.join(m.base, "mine", "mine"));
  const before = snapshot(m.home);
  const plan = await cli(m, ["unlink", "--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stderr + plan.stdout);
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual(plan.calls.filter(pluginWrite), []);
  const planned = (plan.json as unknown as { actions: ActionJson[] }).actions;
  assert.deepEqual(
    planned.filter((a) => a.kind === "uninstall").map((a) => [a.path, a.note]),
    [
      ["Hermes: plugin oneezy", "installed by this tool from oneezy/skills"],
      ["Hermes: plugin play", "installed by this tool from oneezy/skills"],
    ],
  );
  assert.deepEqual(
    planned.filter((a) => a.kind === "remove").map((a) => a.path),
    [gone, grilling],
  );
  assert.ok(!planned.some((a) => a.path === mine || a.path.includes("copied") || a.path.includes("acme")));
  const r = await cli(m, ["unlink", "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(r.calls.filter(pluginWrite), [
    ["hermes", "plugins", "remove", "oneezy"],
    ["hermes", "plugins", "remove", "play"],
  ]);
  assert.equal(lexists(oneezy), false);
  assert.equal(lexists(play), false);
  assert.ok(lexists(copied) && lexists(acme), "not the tool's: left alone");
  assert.equal(lexists(grilling), false);
  assert.equal(lexists(gone), false);
  assert.ok(isLink(mine), "a link to somewhere else stays");
  const meta = JSON.parse(read(path.join(m.hermesHome, "plugins", ".install-metadata.json"))) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(meta).sort(), ["acme"]);
  const config = YAML.parse(read(hermesConfig(m))) as { plugins: { enabled: string[]; disabled: string[] } };
  assert.deepEqual(config.plugins.enabled, ["acme", "copied"]);
  assert.equal((r.json as unknown as { actions: ActionJson[] }).actions.length, 4, r.stdout);
  const again = await cli(m, ["unlink"]);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.ok(again.stdout.trimEnd().endsWith("0 changed, 0 already right, 0 left alone"), again.stdout);
  // without hermes on PATH the tool's plugins cannot be removed through hermes: one line names them, exit 0
  const m2 = machine({ harnesses: ["hermes"], clis: [] });
  hermesPlugin(m2, "oneezy", { version: "0.43.1", skills: ["oneezy-status"] });
  const r2 = await cli(m2, ["unlink", "--json"]);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.deepEqual(
    (r2.json as unknown as { actions: ActionJson[] }).actions.map((a) => [a.kind, a.path, a.note]),
    [["note", "Hermes: plugins", "no hermes on PATH; oneezy installed from oneezy/skills stay"]],
  );
  assert.ok(lexists(path.join(m2.hermesHome, "plugins", "oneezy")));
});
