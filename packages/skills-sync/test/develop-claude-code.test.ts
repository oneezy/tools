// develop setup and remove with the Claude Code adapter switched on, through the built CLI on a pretend machine. The
// fake claude (fixtures/fake-harness) keeps Claude Code 2.1.302's local scope as it was observed against a temporary
// home: --scope local writes the project's .claude/settings.local.json, a local install belongs to one project, `plugin
// list --json` reports each id's enablement in the project it runs in, and `plugin details <name>` names the copy that
// project loads. Tests assert which copy each project resolves, the project's files, git's view of them, the fake's
// calls and state, printed output and exit codes. The adapter is unverified, so every run but one names the test switch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import {
  cli,
  destroy,
  installedPlugin,
  pretendMachine,
  snapshot,
  syncedPlugin,
  write,
  type PretendMachine,
} from "./machine.js";

const machines: PretendMachine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

const ON = { SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS: "claude-code" };
const DEV = "oneezy-skills-development";

function skill(name: string, body = `${name} body`): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * A Library (Groups oneezy and play) at <base>/library, git projects a, b and normal, the released play installed for
 * the user from oneezy-skills, and an unrelated Plugin from another marketplace.
 */
function machine(options: { release?: "marketplace" | "synced" } = {}) {
  const m = pretendMachine({ git: true });
  machines.push(m);
  const lib = path.join(m.base, "library");
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
  if ((options.release ?? "marketplace") === "marketplace")
    installedPlugin(m, "claude-code", "play", { marketplace: "oneezy-skills", skills: ["play-released"] });
  else syncedPlugin(m, "play", { skills: ["play-released"] });
  installedPlugin(m, "claude-code", "tools", { marketplace: "elsewhere", skills: ["tool"] });
  const project = (name: string) => {
    const dir = path.join(m.base, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    write(path.join(dir, "README.md"), `${name}\n`);
    return dir;
  };
  const [a, b, normal] = ["a", "b", "normal"].map(project);
  const develop = (cwd: string, args: string[], env: Record<string, string> = ON) =>
    cli(m, ["develop", ...args], env, cwd);
  /** what `claude plugin details <name>` says a chat in `cwd` loads: its Source line and skills */
  const loads = (cwd: string, name = "play") => fakeClaude(m, cwd, ["plugin", "details", name]);
  return { m, lib, a, b, normal, develop, loads };
}

/** The fake claude run directly in `cwd`, the way a person would in that project. */
function fakeClaude(m: PretendMachine, cwd: string, args: string[]): string {
  const win = process.platform === "win32";
  const bin = path.join(m.bin, win ? "claude.cmd" : "claude");
  // Windows runs the .cmd shim through the shell, which needs every path quoted
  const q = (x: string) => (win ? `"${x}"` : x);
  const r = spawnSync(q(bin), args.map(q), { cwd, env: { ...process.env, ...m.env }, encoding: "utf8", shell: win });
  if (r.status !== 0) return `failed: ${r.stderr}`;
  const source = /Source: (\S+)/.exec(r.stdout)?.[1];
  const skills = /Skills \(\d+\)\s+(.*)/.exec(r.stdout)?.[1]?.trim();
  return `${source} ${skills}`;
}

const settings = (project: string) => path.join(project, ".claude", "settings.local.json");
const readSettings = (project: string) => JSON.parse(fs.readFileSync(settings(project), "utf8"));
const writes = (calls: string[][]) =>
  calls.filter((c) => c[0] === "claude" && !c.includes("--help") && !["list", "details"].some((w) => c.includes(w)));

test("setup puts the development play in one project only; the released copy and unrelated Plugins stay elsewhere", async () => {
  const { m, lib, a, normal, develop, loads } = machine();
  const user = fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8");

  const r = await develop(a, ["setup", "play", "--repo", lib]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(loads(a), `play@${DEV} play-hi`);
  assert.equal(loads(normal), "play@oneezy-skills play-released");
  assert.equal(loads(a, "tools"), "tools@elsewhere tool", "an unrelated Plugin stays on in the project");
  assert.deepEqual(readSettings(a), {
    enabledPlugins: { [`play@${DEV}`]: true, "play@oneezy-skills": false },
    extraKnownMarketplaces: {
      [DEV]: { source: { source: "directory", path: fs.realpathSync(path.join(lib, "dist", "development")) } },
    },
  });
  assert.deepEqual(writes(r.calls), [
    [
      "claude",
      "plugin",
      "marketplace",
      "add",
      fs.realpathSync(path.join(lib, "dist", "development")),
      "--scope",
      "local",
      "--json",
    ],
    ["claude", "plugin", "install", `play@${DEV}`, "--scope", "local", "--json"],
  ]);
  const state = JSON.parse(fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8"));
  assert.deepEqual(
    state.plugins,
    JSON.parse(user).plugins,
    "the user's installs are as they were: released copy included",
  );
  assert.equal(gitIn(a, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
  assert.match(
    r.stdout,
    /claude-code: play@oneezy-skills-development on in this project, play@oneezy-skills off here only/,
  );
  assert.match(r.stdout, /type \/reload-plugins in it or start a new chat/);
});

test("an Account plugin from claude.ai is switched off in the project only", async () => {
  const { lib, a, normal, develop, loads } = machine({ release: "synced" });

  const r = await develop(a, ["setup", "play", "--repo", lib]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(loads(a), `play@${DEV} play-hi`);
  assert.equal(loads(normal), "play@synced play-released");
  assert.equal(readSettings(a).enabledPlugins["play@synced"], false);
});

test("a rebuild is what the project loads next: the development copy is read in place", async () => {
  const { m, lib, a, develop, loads } = machine();
  await develop(a, ["setup", "play", "--repo", lib]);

  write(path.join(lib, "skills", "play", "play-new", "SKILL.md"), skill("play-new"));
  const built = await cli(m, ["develop", "build", "play", "--repo", lib], {}, lib);

  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.equal(loads(a), `play@${DEV} play-hi, play-new`);
});

test("repeated setup changes nothing and runs no Claude Code write", async () => {
  const { lib, a, develop } = machine();
  await develop(a, ["setup", "play", "--repo", lib]);
  const first = snapshot(a);

  const again = await develop(a, ["setup"]);

  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(writes(again.calls), []);
  assert.deepEqual(snapshot(a), first);
});

test("remove gives the project its released copy back and leaves it as it was", async () => {
  const { m, lib, a, b, develop, loads } = machine();
  const before = snapshot(a);
  const exclude = fs.readFileSync(path.join(a, ".git", "info", "exclude"), "utf8");
  await develop(a, ["setup", "play", "--repo", lib]);
  await develop(b, ["setup", "play", "--repo", lib]);

  const r = await develop(a, ["remove"]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(loads(a), "play@oneezy-skills play-released");
  assert.equal(loads(b), `play@${DEV} play-hi`, "the other project keeps its development copy");
  assert.deepEqual(snapshot(a), before);
  assert.equal(fs.readFileSync(path.join(a, ".git", "info", "exclude"), "utf8"), exclude);
  assert.deepEqual(writes(r.calls), [["claude", "plugin", "uninstall", `play@${DEV}`, "--scope", "local", "--json"]]);
  assert.ok(!r.calls.some((c) => c.includes("marketplace") && c.includes("remove")), "never marketplace remove");
  assert.match(r.stdout, /released copies back in this project; .*\/reload-plugins/);
  const state = JSON.parse(fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8"));
  assert.ok(state.plugins["play@oneezy-skills"], "the released copy stayed installed");
  assert.equal((await develop(a, ["remove"])).status, 0, "a second remove has nothing to do");
});

test("remove keeps settings a person changed since setup, and restores the rest", async () => {
  const { lib, a, develop } = machine();
  write(
    settings(a),
    JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, enabledPlugins: { "tools@elsewhere": true } }),
  );
  await develop(a, ["setup", "play", "--repo", lib]);
  const s = readSettings(a);
  s.enabledPlugins["play@oneezy-skills"] = true; // switched back on by hand
  s.model = "opus";
  fs.writeFileSync(settings(a), JSON.stringify(s, null, 2));

  const r = await develop(a, ["remove"]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /play@oneezy-skills is true here since setup switched it off; kept/);
  assert.deepEqual(readSettings(a), {
    permissions: { allow: ["Bash(ls)"] },
    enabledPlugins: { "tools@elsewhere": true, "play@oneezy-skills": true },
    model: "opus",
  });
});

test("a different selection takes back the Plugin no longer selected", async () => {
  const { m, lib, a, develop, loads } = machine();
  installedPlugin(m, "claude-code", "oneezy", { marketplace: "oneezy-skills", skills: ["hello-released"] });
  await develop(a, ["setup", "play", "oneezy", "--repo", lib]);
  assert.equal(loads(a, "oneezy"), `oneezy@${DEV} hello`);

  const r = await develop(a, ["setup", "oneezy"]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(loads(a), "play@oneezy-skills play-released");
  assert.equal(loads(a, "oneezy"), `oneezy@${DEV} hello`);
  assert.equal(readSettings(a).enabledPlugins["play@oneezy-skills"], undefined);
});

test("a failed first build, an identity conflict or a claude without local scope changes nothing", async () => {
  const { m, lib, a, develop, loads } = machine();
  const state = () => fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8");
  const before: [string[], string] = [snapshot(a), state()];
  const source = path.join(lib, "skills", "play", "play-hi", "SKILL.md");

  fs.writeFileSync(source, "no frontmatter\n");
  const broken = await develop(a, ["setup", "play", "--repo", lib]);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /play: development build failed: .*; nothing activated/);
  assert.deepEqual(broken.calls, [], "Claude Code is not even asked");
  assert.deepEqual([snapshot(a), state()], before);
  fs.writeFileSync(source, skill("play-hi", "development greeting"));

  installedPlugin(m, "claude-code", "play", { marketplace: "someone-else", skills: ["theirs"] });
  const clash = await develop(a, ["setup", "play", "--repo", lib]);
  assert.equal(clash.status, 1);
  assert.match(clash.stdout, /play@someone-else has the name play too and is on in this project/);
  assert.deepEqual(writes(clash.calls), []);
  assert.deepEqual(snapshot(a), before[0]);
  fs.writeFileSync(path.join(m.claudeHome, "fake-harness.json"), before[1]);

  const old = await develop(a, ["setup", "play", "--repo", lib], { ...ON, FAKE_HARNESS_NO_LOCAL_SCOPE: "claude" });
  assert.equal(old.status, 1);
  assert.match(old.stdout, /no local plugin scope/);
  assert.deepEqual(writes(old.calls), []);
  assert.deepEqual([snapshot(a), state()], before);

  // a later failure keeps the last successful build, says so, and that build is what the project gets
  fs.writeFileSync(source, "no frontmatter\n");
  const stale = await develop(a, ["setup", "play", "--repo", lib]);
  assert.equal(stale.status, 0, stale.stdout + stale.stderr);
  assert.match(stale.stdout, /play: development build failed \(.*\); its last successful build is used/);
  assert.equal(loads(a), `play@${DEV} play-hi`);
});

test("a failed install takes back what this setup did in Claude Code and writes no record", async () => {
  const { m, lib, a, develop, loads } = machine();
  const state = fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8");

  const r = await develop(a, ["setup", "play", "--repo", lib], {
    ...ON,
    FAKE_HARNESS_FAIL_LOCAL_INSTALL: `play@${DEV}`,
  });

  assert.equal(r.status, 1);
  assert.match(r.stdout, /claude plugin install play@oneezy-skills-development --scope local failed/);
  assert.equal(fs.existsSync(path.join(a, ".agents", "skills-sync-project.json")), false);
  assert.equal(fs.existsSync(settings(a)), false, "the marketplace declaration was taken back");
  assert.equal(loads(a), "play@oneezy-skills play-released");
  const after = JSON.parse(fs.readFileSync(path.join(m.claudeHome, "fake-harness.json"), "utf8"));
  assert.deepEqual(after.plugins, JSON.parse(state).plugins);
});

test("without the test switch the adapter is not verified: setup names it and runs no claude command", async () => {
  const { lib, a, develop } = machine();

  const r = await develop(a, ["setup", "play", "--repo", lib], {});

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /claude-code: not activated: its adapter is not verified/);
  assert.deepEqual(r.calls, []);
  assert.equal(fs.existsSync(settings(a)), false);
});

test("status tells installed for the project apart from what a chat has loaded, and names drift", async () => {
  const { lib, a, develop } = machine();
  await develop(a, ["setup", "play", "--repo", lib]);

  const ok = (await develop(a, ["status", "--json"])).json as {
    harnesses: { harness: string; state: string; note: string }[];
  };
  const claude = ok.harnesses.find((h) => h.harness === "claude-code")!;
  assert.equal(claude.state, "installed");
  assert.match(claude.note, /installed is not loaded: .*\/reload-plugins/);

  const s = readSettings(a);
  s.enabledPlugins["play@oneezy-skills"] = true;
  fs.writeFileSync(settings(a), JSON.stringify(s));
  const drift = (await develop(a, ["status", "--json"])).json as typeof ok;
  assert.deepEqual(
    drift.harnesses.find((h) => h.harness === "claude-code"),
    {
      harness: "claude-code",
      state: "drifted",
      note: "play@oneezy-skills is on here again; develop setup puts it back",
    },
  );
});

test("a refused uninstall keeps the whole setup for a retry, and the retry restores the project", async () => {
  const { lib, a, develop, loads } = machine();
  const before = snapshot(a);
  await develop(a, ["setup", "play", "--repo", lib]);
  const connected = snapshot(a);

  const refused = await develop(a, ["remove"], { ...ON, FAKE_HARNESS_FAIL_UNINSTALL: `play@${DEV}` });

  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /claude plugin uninstall play@oneezy-skills-development --scope local failed/);
  assert.deepEqual(snapshot(a), connected, "settings, alias, record and exclude block all stay");
  assert.equal(loads(a), `play@${DEV} play-hi`);
  const retry = await develop(a, ["remove"]);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.deepEqual(snapshot(a), before);
});
