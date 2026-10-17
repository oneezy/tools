// The Codex adapter of develop setup, status and remove, against the fake codex in its config.toml mode (the switches
// codex-cli 0.163.0 keeps in <CODEX_HOME>/config.toml and a trusted project's .codex/config.toml). A test asserts what
// Codex would load in each project (`codex -C <project> debug prompt-input`), the user and project config files on
// disk, and the codex commands run. Nothing here proves Codex in the ChatGPT desktop app: that is #217's runbook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { codexAdapter } from "../src/develop-codex.js";
import { develop } from "../src/develop.js";
import { buildDevelopment } from "../src/develop-build.js";
import { projectStatus, removeProject, setupProject } from "../src/develop-project.js";
import { Library } from "../src/library.js";
import { cli, destroy, pretendMachine, snapshot, write, type PretendMachine } from "./machine.js";

const machines: PretendMachine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

const skill = (name: string, body = `${name} body`) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * A pretend machine with a Library (Plugins oneezy and play), its release marketplace `oneezy-skills` added to Codex
 * with play and oneezy installed from it, an unrelated plugin `other@elsewhere`, and git projects a, b (both trusted in
 * Codex) and plain.
 */
function codexMachine(options: { trust?: ("a" | "b")[]; libraryInA?: boolean } = {}) {
  const m = pretendMachine();
  machines.push(m);
  const env = { ...m.env, FAKE_HARNESS_CODEX_CONFIG: "1" };
  const codexFile = path.join(m.bin, "codex");
  const codex = (...args: string[]) => {
    const r = spawnSync(codexFile, args, { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, `codex ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const project = (name: string) => {
    const dir = path.join(m.base, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    write(path.join(dir, "README.md"), `${name}\n`);
    return dir;
  };
  const a = project("a");
  const b = project("b");
  const plain = project("plain");
  // libraryInA: the tools monorepo's case, a workspace holding the Library, where pnpm skills:dev runs too
  const lib = options.libraryInA ? path.join(a, "packages", "skills") : path.join(m.base, "library");
  write(
    path.join(lib, "skills-sync.json"),
    JSON.stringify({
      version: 1,
      library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills", version: "1.2.3" },
      sources: {},
      plugins: {
        oneezy: { displayName: "Oneezy", description: "Justin's own skills.", group: "oneezy" },
        play: { displayName: "Play", description: "The playground.", group: "play" },
      },
    }) + "\n",
  );
  write(path.join(lib, "skills-sync.lock.json"), JSON.stringify({ version: 2, sources: {} }) + "\n");
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello"));
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi", "development greeting"));
  // the released copies, from a marketplace of their own, as `codex plugin marketplace add oneezy/skills` gives them
  const market = (name: string, plugins: string[]) => {
    const root = path.join(m.base, name);
    write(
      path.join(root, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({ name, plugins: plugins.map((p) => ({ name: p, source: `./plugins/${p}` })) }),
    );
    for (const p of plugins) {
      write(
        path.join(root, "plugins", p, ".codex-plugin", "plugin.json"),
        JSON.stringify({ name: p, version: "1.2.3" }),
      );
      write(path.join(root, "plugins", p, "skills", `${p}-hi`, "SKILL.md"), skill(`${p}-hi`, "released greeting"));
    }
    codex("plugin", "marketplace", "add", root, "--json");
    for (const p of plugins) codex("plugin", "add", `${p}@${name}`, "--json");
  };
  market("oneezy-skills", ["play", "oneezy"]);
  market("elsewhere", ["other"]);
  const userConfig = path.join(m.codexHome, "config.toml");
  for (const p of (options.trust ?? ["a", "b"]).map((n) => ({ a, b })[n]))
    fs.appendFileSync(userConfig, `\n[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`);
  const adapter = (extra: Record<string, string> = {}) =>
    codexAdapter({ codex: codexFile, env: { ...env, ...extra }, verified: true });
  /** what Codex loads in `project`: <plugin>:<skill> from <marketplace>, sorted */
  const loaded = (project: string): string[] => {
    const out = codex("-C", project, "debug", "prompt-input");
    const lines = [...out.matchAll(/- ([\w-]+):([\w-]+): [^\n]*?\(file: ([^)]+)\)/g)];
    return lines
      .map(([, plugin, s, file]) => {
        const parts = file.split(/[\\/]/);
        return `${plugin}:${s} from ${parts[parts.indexOf("cache") + 1]}`;
      })
      .sort();
  };
  return { m, lib, a, b, plain, codex, adapter, loaded, userConfig, library: new Library(lib) };
}

test("setup loads the development copy in the project only: the released copy stays everywhere else, unrelated plugins stay on", () => {
  const { a, plain, adapter, loaded, library } = codexMachine();
  assert.deepEqual(loaded(a), [
    "oneezy:oneezy-hi from oneezy-skills",
    "other:other-hi from elsewhere",
    "play:play-hi from oneezy-skills",
  ]);

  const r = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.deepEqual(r.conflicts(), []);
  assert.deepEqual(loaded(a), [
    "oneezy:oneezy-hi from oneezy-skills",
    "other:other-hi from elsewhere",
    "play:play-hi from oneezy-skills-dev",
  ]);
  assert.deepEqual(loaded(plain), [
    "oneezy:oneezy-hi from oneezy-skills",
    "other:other-hi from elsewhere",
    "play:play-hi from oneezy-skills",
  ]);
});

const calls = (m: PretendMachine): string[] =>
  fs.existsSync(m.log)
    ? fs
        .readFileSync(m.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as string[]).slice(1).join(" "))
        .filter((c) => !/^(-C \S+ )?debug|plugin (list|marketplace list)/.test(c))
    : [];

test("each add switches the development copy on for every project; setup switches it off again at once, and an unchanged build adds nothing", () => {
  const { m, a, adapter, userConfig, library } = codexMachine();
  fs.rmSync(m.log, { force: true });

  const r = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.deepEqual(r.conflicts(), []);
  assert.deepEqual(calls(m), [
    `plugin marketplace add ${path.join(library.root, "dist", "development")} --json`,
    "plugin add play@oneezy-skills-dev --json",
  ]);
  assert.match(fs.readFileSync(userConfig, "utf8"), /\[plugins\."play@oneezy-skills-dev"\]\nenabled = false\n/);
  assert.match(fs.readFileSync(userConfig, "utf8"), /\[plugins\."play@oneezy-skills"\]\nenabled = true\n/);
  const notes = r.actions.map((x) => x.note ?? "").join("\n");
  assert.match(notes, /on for every project for \d+ ms, until switched off again/);
  assert.match(notes, /restart the ChatGPT desktop app/);

  const files = [fs.readFileSync(userConfig, "utf8"), fs.readFileSync(path.join(a, ".codex", "config.toml"), "utf8")];
  fs.rmSync(m.log, { force: true });
  const again = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.deepEqual(again.conflicts(), []);
  assert.deepEqual(calls(m), [], "nothing to add: Codex's copy is the build");
  assert.deepEqual(
    [fs.readFileSync(userConfig, "utf8"), fs.readFileSync(path.join(a, ".codex", "config.toml"), "utf8")],
    files,
  );
  assert.match(again.actions.map((x) => x.note ?? "").join("\n"), /already active here; no restart needed/);
});

test("plan reads Codex but runs no codex command and writes nothing", () => {
  const { m, a, adapter, userConfig, library } = codexMachine();
  const before = fs.readFileSync(userConfig, "utf8");
  fs.rmSync(m.log, { force: true });

  const r = setupProject(a, library, ["play"], { plan: true, adapters: [adapter()] });

  assert.deepEqual(r.conflicts(), []);
  assert.deepEqual(calls(m), []);
  assert.equal(fs.readFileSync(userConfig, "utf8"), before);
  assert.equal(fs.existsSync(path.join(a, ".codex")), false);
  const planned = r.actions.map((x) => `${x.kind} ${x.note ?? x.path}`).join("\n");
  assert.match(planned, /install codex plugin add play@oneezy-skills-dev, then switched off again/);
  assert.match(planned, new RegExp(`write ${path.join(a, ".codex", "config.toml").replace(/[\\.]/g, "\\$&")}`));
});

test("a source edit reaches Codex only when setup adds the rebuilt Plugin again; status tells the stale copy from the active one", () => {
  const { m, lib, a, adapter, userConfig, library } = codexMachine();
  setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });
  const cached = path.join(m.codexHome, "plugins", "cache", "oneezy-skills-dev", "play", "1.2.3", "skills", "play-hi");
  assert.match(fs.readFileSync(path.join(cached, "SKILL.md"), "utf8"), /development greeting/);
  assert.equal(projectStatus(a, null, [adapter()]).harnesses.find((h) => h.harness === "codex")?.state, "active");

  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi", "edited greeting"));
  write(path.join(lib, "skills", "play", "play-hi", "notes.md"), "new supporting file\n");
  setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.match(fs.readFileSync(path.join(cached, "SKILL.md"), "utf8"), /edited greeting/);
  assert.ok(fs.existsSync(path.join(cached, "notes.md")));
  assert.match(fs.readFileSync(userConfig, "utf8"), /\[plugins\."play@oneezy-skills-dev"\]\nenabled = false\n/);

  // a build made after the add (the watcher's): Codex still has the copy it was given
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi", "third greeting"));
  buildDevelopment(library, { plugins: ["play"] });
  const s = projectStatus(a, null, [adapter()]).harnesses.find((h) => h.harness === "codex")!;
  assert.equal(s.state, "stale");
  assert.match(s.note, /develop setup adds it again, then restart the ChatGPT desktop app/);
});

test("remove switches a project back to the released copies, and the last project to leave takes the development copies out of Codex", () => {
  const { m, a, b, plain, adapter, loaded, userConfig, library } = codexMachine();
  const userBefore = fs.readFileSync(userConfig, "utf8");
  const released = loaded(plain);
  setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });
  setupProject(b, library, ["play", "oneezy"], { plan: false, adapters: [adapter()] });
  assert.deepEqual(loaded(b), [
    "oneezy:hello from oneezy-skills-dev",
    "other:other-hi from elsewhere",
    "play:play-hi from oneezy-skills-dev",
  ]);

  fs.rmSync(m.log, { force: true });
  const first = removeProject(a, { plan: false, adapters: [adapter()] });

  assert.deepEqual(first.conflicts(), []);
  assert.deepEqual(calls(m), [], "b still loads play from the development marketplace");
  assert.equal(fs.existsSync(path.join(a, ".codex")), false, "setup made .codex; remove takes it back");
  assert.deepEqual(loaded(a), released);
  assert.equal(loaded(b).filter((x) => x.endsWith("oneezy-skills-dev")).length, 2);

  const last = removeProject(b, { plan: false, adapters: [adapter()] });

  assert.deepEqual(last.conflicts(), []);
  assert.deepEqual(calls(m), [
    "plugin remove oneezy@oneezy-skills-dev --json",
    "plugin remove play@oneezy-skills-dev --json",
    "plugin marketplace remove oneezy-skills-dev --json",
  ]);
  assert.deepEqual(loaded(b), released);
  assert.equal(fs.readFileSync(userConfig, "utf8"), userBefore, "the released copies' switches are as they were");
  assert.match(last.actions.map((x) => x.note ?? "").join("\n"), /back to the released copies here; restart/);
});

test("switch-off keeps what a person added to .codex/config.toml since setup, and a changed block entirely", () => {
  const { a, b, adapter, library } = codexMachine();
  const config = (p: string) => path.join(p, ".codex", "config.toml");
  write(config(a), 'model = "gpt-5"\n');
  setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });
  setupProject(b, library, ["play"], { plan: false, adapters: [adapter()] });
  fs.appendFileSync(config(a), '\n[mcp_servers.docs]\ncommand = "docs"\n');
  fs.writeFileSync(config(b), fs.readFileSync(config(b), "utf8").replace("enabled = false", "enabled = true"));
  const changed = fs.readFileSync(config(b), "utf8");

  assert.deepEqual(removeProject(a, { plan: false, adapters: [adapter()] }).conflicts(), []);
  const kept = removeProject(b, { plan: false, adapters: [adapter()] });

  assert.equal(fs.readFileSync(config(a), "utf8"), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs"\n');
  assert.equal(fs.readFileSync(config(b), "utf8"), changed);
  assert.match(kept.actions.map((x) => x.note ?? "").join("\n"), /block changed since setup; kept/);
});

const conflictNotes = (r: { conflicts(): { note?: string }[] }) =>
  r
    .conflicts()
    .map((x) => x.note)
    .join("\n");

test("a switch for the same copy outside setup's block, or a tracked .codex/config.toml, stops activation before anything changes", () => {
  const { m, a, b, adapter, userConfig, library } = codexMachine();
  write(path.join(a, ".codex", "config.toml"), '[plugins."play@oneezy-skills"]\nenabled = true\n');
  write(path.join(b, ".codex", "config.toml"), 'model = "gpt-5"\n');
  gitIn(b, "add", ".codex/config.toml");
  const before = [fs.readFileSync(userConfig, "utf8"), snapshot(a), snapshot(b)];
  fs.rmSync(m.log, { force: true });

  const set = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });
  const tracked = setupProject(b, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.match(conflictNotes(set), /play@oneezy-skills is set outside develop setup's block; merge it by hand/);
  assert.match(conflictNotes(tracked), /git tracks \.codex\/config\.toml: .* reach cloud sessions; not activated/);
  assert.deepEqual(calls(m), []);
  assert.deepEqual([fs.readFileSync(userConfig, "utf8"), snapshot(a), snapshot(b)], before);
});

test("a same-name copy from a ChatGPT workspace, which a project cannot switch off, stops activation: a decision for Justin", () => {
  const { m, a, adapter, library } = codexMachine();
  // a signed-in Codex lists a workspace-managed copy as installed from a remote marketplace it never added
  const state = JSON.parse(fs.readFileSync(path.join(m.codexHome, "fake-harness.json"), "utf8"));
  state.plugins["play@workspace-directory"] = { version: "1.2.3", enabled: true, dir: m.base, skills: [] };
  fs.writeFileSync(path.join(m.codexHome, "fake-harness.json"), JSON.stringify(state));
  const before = snapshot(a);

  const r = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.match(
    conflictNotes(r),
    /play@workspace-directory reaches Codex from the ChatGPT account or workspace.* not activated: a decision for Justin/,
  );
  assert.deepEqual(snapshot(a), before);
  assert.equal(fs.existsSync(path.join(a, ".agents")), false, "core applies nothing on a conflict");
});

test("when the development copy cannot be switched off again after its add, setup takes it out of Codex and activates nothing", () => {
  const { m, a, plain, adapter, loaded, userConfig, library } = codexMachine();
  const released = loaded(plain);
  // another skills-sync run holds the user config.toml: the switch-off write cannot happen
  write(`${userConfig}.skills-sync.lock`, "4242\n");
  fs.rmSync(m.log, { force: true });

  const r = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.match(
    conflictNotes(r),
    /play@oneezy-skills-dev: codex plugin add switched it on for every project and it could not be switched off again .*removed it from Codex/,
  );
  assert.ok(r.conflicts().some((x) => x.failed));
  assert.deepEqual(calls(m), [
    `plugin marketplace add ${path.join(library.root, "dist", "development")} --json`,
    "plugin add play@oneezy-skills-dev --json",
    "plugin remove play@oneezy-skills-dev --json",
    "plugin marketplace remove oneezy-skills-dev --json",
  ]);
  assert.deepEqual(loaded(plain), released, "no project loads the development copy");
  assert.equal(fs.existsSync(path.join(a, ".codex")), false, "the project block is never written");
  assert.equal(
    fs.existsSync(path.join(a, ".agents", "skills-sync-project.json")),
    false,
    "no record: the next setup retries",
  );

  fs.rmSync(`${userConfig}.skills-sync.lock`);
  assert.deepEqual(setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] }).conflicts(), []);
  assert.ok(loaded(a).includes("play:play-hi from oneezy-skills-dev"));
});

test("in a workspace where pnpm skills:dev already switches the released copies off, setup leaves those switches to it, and either can run again", () => {
  const { m, a, adapter, loaded, library } = codexMachine({ libraryInA: true });
  const config = path.join(a, ".codex", "config.toml");
  const skillsDev = () => develop(library, a, { plan: false, home: m.home, codexHome: m.codexHome });
  assert.deepEqual(skillsDev().conflicts(), []);
  assert.match(fs.readFileSync(config, "utf8"), /\[plugins\."play@oneezy-skills"\]\nenabled = false/);

  const r = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.deepEqual(r.conflicts(), []);
  assert.ok(loaded(a).includes("play:play-hi from oneezy-skills-dev"), "Codex reads the file: no key is set twice");
  const block = /# skills-sync:development-plugins:start[\s\S]*?# skills-sync:development-plugins:end/.exec(
    fs.readFileSync(config, "utf8"),
  )![0];
  assert.doesNotMatch(block, /oneezy-skills"/, "the released copy's switch stays pnpm skills:dev's");

  // pnpm skills:dev again, now with the development copy in Codex's cache: it keeps setup's block and leaves that copy alone
  assert.deepEqual(skillsDev().conflicts(), []);
  const text = fs.readFileSync(config, "utf8");
  assert.ok(text.includes(block));
  assert.doesNotMatch(text.replace(block, ""), /oneezy-skills-dev/);
  assert.ok(loaded(a).includes("play:play-hi from oneezy-skills-dev"));

  assert.deepEqual(removeProject(a, { plan: false, adapters: [adapter()] }).conflicts(), []);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /development-plugins/);
  assert.match(fs.readFileSync(config, "utf8"), /# skills-sync:development:start/);
});

test("pnpm skills:dev in a Development project keeps setup's block and repeats none of its switches", () => {
  const { m, a, adapter, loaded, library } = codexMachine({ libraryInA: true });
  const config = path.join(a, ".codex", "config.toml");
  assert.deepEqual(setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] }).conflicts(), []);
  const ours = fs.readFileSync(config, "utf8");

  const r = develop(library, a, { plan: false, home: m.home, codexHome: m.codexHome });

  assert.deepEqual(r.conflicts(), []);
  const text = fs.readFileSync(config, "utf8");
  assert.ok(text.startsWith(ours));
  assert.match(text.slice(ours.length), /\[plugins\."oneezy@oneezy-skills"\]\nenabled = false/);
  assert.doesNotMatch(text.slice(ours.length), /play@oneezy-skills|oneezy-skills-dev/);
  assert.ok(loaded(a).includes("play:play-hi from oneezy-skills-dev"));
});

test("status reads what Codex loads: an untrusted project keeps the released copy, and a copy left on for every project is named", () => {
  const { m, a, b, adapter, loaded, userConfig, library } = codexMachine({ trust: ["b"] });
  const codexStatus = (p: string) => projectStatus(p, null, [adapter()]).harnesses.find((h) => h.harness === "codex")!;

  const untrusted = setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });

  assert.deepEqual(untrusted.conflicts(), []);
  assert.match(
    untrusted.actions.map((x) => x.note ?? "").join("\n"),
    /only in a trusted project: trust .*\/a in Codex/,
  );
  assert.ok(loaded(a).includes("play:play-hi from oneezy-skills"));
  assert.equal(codexStatus(a).state, "released copy loaded");
  assert.match(codexStatus(a).note, /does not trust this project/);

  setupProject(b, library, ["play"], { plan: false, adapters: [adapter()] });
  assert.equal(codexStatus(b).state, "active");
  // a run that died between its add and the switch-off: the development copy is on for every project
  fs.writeFileSync(
    userConfig,
    fs
      .readFileSync(userConfig, "utf8")
      .replace(/(\[plugins\."play@oneezy-skills-dev"\]\n)enabled = false/, "$1enabled = true"),
  );
  assert.equal(codexStatus(b).state, "on everywhere");
  assert.match(codexStatus(b).note, /switched on for every project .*develop setup switches it off/);

  fs.rmSync(m.log, { force: true });
  assert.deepEqual(setupProject(b, library, ["play"], { plan: false, adapters: [adapter()] }).conflicts(), []);
  assert.deepEqual(calls(m), [], "the copy is current: only the switch is put back");
  assert.equal(codexStatus(b).state, "active");
});

test("a failed first build keeps the project's selection in Codex; a later failure keeps the last good build; a dropped Plugin leaves Codex", () => {
  const { m, lib, a, adapter, loaded, library } = codexMachine();
  const config = path.join(a, ".codex", "config.toml");
  setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] });
  const selected = [fs.readFileSync(config, "utf8"), loaded(a)];
  const broken = path.join(lib, "skills", "oneezy", "hello", "SKILL.md");
  fs.writeFileSync(broken, "no frontmatter\n");

  const failed = setupProject(a, library, ["oneezy", "play"], { plan: false, adapters: [adapter()] });

  assert.match(conflictNotes(failed), /oneezy: development build failed: .*; nothing activated/);
  assert.deepEqual([fs.readFileSync(config, "utf8"), loaded(a)], selected);

  fs.writeFileSync(broken, skill("hello"));
  assert.deepEqual(
    setupProject(a, library, ["oneezy", "play"], { plan: false, adapters: [adapter()] }).conflicts(),
    [],
  );
  assert.ok(loaded(a).includes("oneezy:hello from oneezy-skills-dev"));
  fs.writeFileSync(broken, "no frontmatter\n");
  const stale = setupProject(a, library, ["oneezy", "play"], { plan: false, adapters: [adapter()] });
  assert.deepEqual(stale.conflicts(), []);
  assert.match(
    stale.actions.map((x) => x.note ?? "").join("\n"),
    /oneezy: development build failed .*last successful build is used/,
  );
  assert.ok(loaded(a).includes("oneezy:hello from oneezy-skills-dev"));

  fs.rmSync(m.log, { force: true });
  assert.deepEqual(setupProject(a, library, ["play"], { plan: false, adapters: [adapter()] }).conflicts(), []);
  assert.deepEqual(calls(m), ["plugin remove oneezy@oneezy-skills-dev --json"]);
  assert.ok(loaded(a).includes("oneezy:oneezy-hi from oneezy-skills"), "back to the released oneezy");
});

test("the CLI: unverified, Codex is left alone; switched on for tests, two projects load the development copy and a normal one the released copy", async () => {
  const { m, lib, a, b, plain, loaded, userConfig } = codexMachine();
  const run = (cwd: string, on: boolean, ...args: string[]) =>
    cli(
      m,
      ["develop", ...args],
      { FAKE_HARNESS_CODEX_CONFIG: "1", ...(on ? { SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS: "codex" } : {}) },
      cwd,
    );
  const userBefore = fs.readFileSync(userConfig, "utf8");
  const released = loaded(plain);

  const off = await run(a, false, "setup", "play", "--repo", lib);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.match(off.stdout, /codex: not activated: its adapter is not verified/);
  assert.deepEqual(off.calls, []);
  assert.equal(fs.existsSync(path.join(a, ".codex")), false);

  for (const p of [a, b]) {
    const r = await run(p, true, "setup", "play", "--repo", lib);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /restart the ChatGPT desktop app/);
  }
  assert.match(fs.readFileSync(path.join(a, ".git", "info", "exclude"), "utf8"), /^\/\.codex\/config\.toml$/m);
  assert.equal(gitIn(a, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
  for (const p of [a, b]) assert.ok(loaded(p).includes("play:play-hi from oneezy-skills-dev"));
  assert.deepEqual(loaded(plain), released);
  const status = await run(a, true, "status", "--json");
  assert.equal(status.status, 0, status.stdout);
  const codex = (status.json as { harnesses: { harness: string; state: string; note: string }[] }).harnesses.find(
    (h) => h.harness === "codex",
  )!;
  assert.equal(codex.state, "active");
  assert.match(codex.note, /Visible but inactive elsewhere: play@oneezy-skills-dev/);

  for (const p of [a, b]) {
    const r = await run(p, true, "remove");
    assert.equal(r.status, 0, r.stdout + r.stderr);
  }
  for (const p of [a, b, plain]) assert.deepEqual(loaded(p), released);
  assert.equal(fs.readFileSync(userConfig, "utf8"), userBefore);
  assert.equal(fs.existsSync(path.join(a, ".codex")), false);
});
