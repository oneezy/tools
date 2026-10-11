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
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { lexists } from "../src/fs.js";
import { HOOK_COMMAND } from "../src/hooks.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  blockIn,
  cli,
  codexLegacySkills,
  codexTrust,
  destroy,
  globalFile,
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
  // and a sync afterwards puts the blocks and the hook entries back, nothing else of the old state
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
