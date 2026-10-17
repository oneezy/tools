// Ordinary sync and release packaging beside Development projects (tools#215), through the built CLI on a pretend
// machine with both Harness adapters switched on for the test. The machine has a Library with the Plugin play, two
// Development projects (a and b) and an ordinary one (plain); Claude Code gets the released play from the claude.ai
// account (play@synced), Codex from the library's GitHub marketplace, which sync itself installs. Each test asserts what
// a chat in each project would load (the fake claude's `plugin details`, the fake codex's `debug prompt-input`), the
// Harness commands the tool ran, the files on disk and the exit codes. Nothing here is a real Harness or a real
// release: that proof is #217's runbook (notes/215-sync.md).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { startFakeGithub, type FakeGithub, type FixtureRelease } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  destroy,
  githubClone,
  installedPlugin,
  pretendMachine,
  snapshot,
  syncedPlugin,
  write,
  type PretendMachine,
  type Run,
} from "./machine.js";

const ON = { SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS: "claude-code,codex" };
const CLAUDE_DEV = "oneezy-skills-development";
const CODEX_DEV = "oneezy-skills-dev";

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

const skill = (name: string, body = `${name} body`) => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/**
 * The machine: the Library (Plugins oneezy and play) at <base>/library, git projects a, b and plain (a and b trusted in
 * Codex), play@synced delivered by the account and an older tool's play@oneezy-skills still installed in Claude Code,
 * an unrelated Claude Plugin, and the library at release-17 on the pretend GitHub for Codex.
 */
function machine(options: { account?: boolean } = {}) {
  const m = pretendMachine({ github: gh, git: true, env: { FAKE_HARNESS_CODEX_CONFIG: "1" } });
  machines.push(m);
  githubClone(m, r17);
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
  if (options.account !== false) syncedPlugin(m, "play", { skills: ["play-unslop"] });
  installedPlugin(m, "claude-code", "play", { marketplace: "oneezy-skills", skills: ["play-unslop"] });
  installedPlugin(m, "claude-code", "tools", { marketplace: "elsewhere", skills: ["tool"] });
  const project = (name: string) => {
    const dir = path.join(m.base, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    write(path.join(dir, "README.md"), `${name}\n`);
    return dir;
  };
  const [a, b, plain] = ["a", "b", "plain"].map(project);
  const userToml = path.join(m.codexHome, "config.toml");
  for (const p of [a, b]) fs.appendFileSync(userToml, `\n[projects.${JSON.stringify(p)}]\ntrust_level = "trusted"\n`);
  const sync = (cwd = m.home, args: string[] = []) => cli(m, args, ON, cwd);
  const develop = (cwd: string, args: string[]) => cli(m, ["develop", ...args], ON, cwd);
  const env = { ...process.env, ...m.env, FAKE_HARNESS_LOG: "" };
  const fake = (host: "claude" | "codex", cwd: string, args: string[]) => {
    const win = process.platform === "win32";
    // Windows runs the .cmd shim through the shell, which needs every path quoted
    const q = (x: string) => (win ? `"${x}"` : x);
    const bin = path.join(m.bin, win ? `${host}.cmd` : host);
    const r = spawnSync(q(bin), args.map(q), { cwd, env, encoding: "utf8", shell: win });
    assert.equal(r.status, 0, `${host} ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  /** what a new chat in `cwd` loads, per Harness: claude's play Source line, Codex's play skills by marketplace */
  const loads = (cwd: string) => {
    const claude = /Source: (\S+)/.exec(fake("claude", cwd, ["plugin", "details", "play"]))?.[1];
    const codex = [
      // the inventory is JSON, so read its text before splitting paths: escaped Windows backslashes come doubled
      ...(JSON.parse(fake("codex", cwd, ["-C", cwd, "debug", "prompt-input"])) as { content: { text: string }[] }[])
        .flatMap((x) => x.content.map((c) => c.text))
        .join("\n")
        .matchAll(/- play:([\w-]+): [^\n]*?\(file: ([^)]+)\)/g),
    ]
      .map(([, s, file]) => {
        const parts = file.split(/[\\/]/);
        return `${s} from ${parts[parts.indexOf("cache") + 1]}`;
      })
      .sort();
    return { claude, codex };
  };
  return { m, lib, a, b, plain, sync, develop, loads, fake, userToml };
}

const RELEASED = { claude: "play@synced", codex: ["play-unslop from oneezy-skills"] };
const DEVELOPMENT = { claude: `play@${CLAUDE_DEV}`, codex: [`play-hi from ${CODEX_DEV}`] };

/** The Harness commands of a run that change something: installs, removals, marketplace changes, upgrades. */
const writes = (r: Run) =>
  r.calls
    .map((c) => c.join(" "))
    .filter((c) => /\b(add|remove|upgrade|install|uninstall|enable|disable)\b/.test(c) && !c.includes("--help"));

test("sync beside two Development projects: they keep the development copies, the ordinary project gets the released ones, and the development copies stay installed and off elsewhere", async () => {
  const { a, b, plain, sync, develop, loads } = machine();
  // a is set up before sync has installed anything for Codex: the release copy sync adds afterwards must not compete
  const setupA = await develop(a, ["setup", "play", "--repo", path.join(a, "..", "..", "library")]);
  assert.equal(setupA.status, 0, setupA.stdout + setupA.stderr);

  const first = await sync();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.ok(
    writes(first).includes("claude plugin uninstall play@oneezy-skills --scope user --json"),
    JSON.stringify(writes(first)),
  );
  const setupB = await develop(b, ["setup", "play", "--repo", path.join(a, "..", "..", "library")]);
  assert.equal(setupB.status, 0, setupB.stdout + setupB.stderr);

  for (const cwd of [plain, a]) {
    const again = await sync(cwd);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(writes(again), [], `a repeated sync from ${cwd} changes no Harness`);
    assert.doesNotMatch(again.stdout, new RegExp(`(remove|uninstall)[^\\n]*play@(${CODEX_DEV}|${CLAUDE_DEV})`));
  }

  assert.deepEqual(loads(a), DEVELOPMENT);
  assert.deepEqual(loads(b), DEVELOPMENT);
  assert.deepEqual(loads(plain), RELEASED);
  for (const project of [a, b]) {
    const s = await develop(project, ["status", "--json"]);
    assert.equal(s.status, 0, s.stdout);
  }
});

test("switch-off after sync gives the project its released copies back, keeps the other Development project, and the next sync changes nothing; setup and remove repeat cleanly", async () => {
  const { m, lib, a, b, plain, sync, develop, loads, fake } = machine();
  assert.equal((await sync()).status, 0);
  for (const p of [a, b]) assert.equal((await develop(p, ["setup", "play", "--repo", lib])).status, 0);
  const settings = path.join(a, ".claude", "settings.local.json");
  // a person's own local setting, written after setup: switch-off keeps it
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  fs.writeFileSync(settings, JSON.stringify({ ...s, permissions: { allow: ["Bash(ls)"] } }, null, 2) + "\n");

  const again = await develop(a, ["setup", "play", "--repo", lib]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(writes(again), [], "a repeated setup runs no Harness write");

  const off = await develop(a, ["remove"]);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.deepEqual(loads(a), RELEASED);
  assert.deepEqual(loads(b), DEVELOPMENT);
  assert.deepEqual(loads(plain), RELEASED);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { permissions: { allow: ["Bash(ls)"] } });
  assert.equal(fs.existsSync(path.join(a, ".codex")), false);
  // the released Plugins stay installed, and so do b's development copies
  const codexIds = (JSON.parse(fake("codex", m.home, ["plugin", "list", "--json"])).installed as { pluginId: string }[])
    .map((p) => p.pluginId)
    .sort();
  assert.deepEqual(codexIds, [
    "matt-pocock@oneezy-skills",
    "oneezy@oneezy-skills",
    "play@oneezy-skills",
    `play@${CODEX_DEV}`,
  ]);

  const removeAgain = await develop(a, ["remove"]);
  assert.equal(removeAgain.status, 0, removeAgain.stdout + removeAgain.stderr);
  assert.deepEqual(writes(removeAgain), [], "a second remove has nothing to take back");

  for (const cwd of [m.home, a, b]) {
    const r = await sync(cwd);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(writes(r), []);
  }
  assert.deepEqual(loads(a), RELEASED);
  assert.deepEqual(loads(b), DEVELOPMENT);
});

test("without an account copy, sync keeps the released Claude Code install for the user; a Development project's local false keys outrank it there", async () => {
  const { lib, a, plain, sync, develop, loads } = machine({ account: false });
  assert.equal((await develop(a, ["setup", "play", "--repo", lib])).status, 0);
  const local = fs.readFileSync(path.join(a, ".claude", "settings.local.json"), "utf8");

  const r = await sync(a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(
    writes(r).filter((c) => c.startsWith("claude")),
    [],
    "sync removes only an install the account copy replaces",
  );
  assert.equal(fs.readFileSync(path.join(a, ".claude", "settings.local.json"), "utf8"), local);
  assert.deepEqual(loads(a).claude, `play@${CLAUDE_DEV}`);
  assert.deepEqual(loads(plain).claude, "play@oneezy-skills");
});

test("a development copy someone switched on for every project: sync names it red and changes nothing; develop setup switches it off again, and sync is clean", async () => {
  const { m, lib, a, plain, sync, develop, loads, fake } = machine();
  assert.equal((await sync()).status, 0);
  assert.equal((await develop(a, ["setup", "play", "--repo", lib])).status, 0);
  // a `codex plugin add` from outside the adapter switches the copy on in the user config
  fake("codex", m.home, ["plugin", "add", `play@${CODEX_DEV}`, "--json"]);
  assert.deepEqual(loads(plain).codex, [`play-hi from ${CODEX_DEV}`, "play-unslop from oneezy-skills"]);

  const r = await sync();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(writes(r), []);
  assert.match(r.stdout, new RegExp(`Codex: plugin play@${CODEX_DEV}[^\\n]*on for every project[^\\n]*develop setup`));
  const status = await cli(m, ["status"], ON);
  assert.match(status.stdout, /develop setup/);
  assert.doesNotMatch(status.stdout, new RegExp(`codex plugin remove play@${CODEX_DEV}`));

  assert.equal((await develop(a, ["setup", "play", "--repo", lib])).status, 0);
  assert.deepEqual(loads(plain), RELEASED);
  assert.deepEqual(loads(a), DEVELOPMENT);
  const clean = await sync();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});

test("failure recovery: a sync that cannot list or install leaves the Development projects as they are, and the next sync finishes; a failed first development build leaves sync's released copies in place", async () => {
  const { m, lib, a, b, plain, sync, develop, loads } = machine();
  assert.equal((await develop(a, ["setup", "play", "--repo", lib])).status, 0);
  const before = snapshot(a);

  const unlisted = await cli(m, [], { ...ON, FAKE_HARNESS_FAIL_LIST: "codex" }, m.home);
  assert.equal(unlisted.status, 1, unlisted.stdout);
  const refused = await cli(m, [], { ...ON, FAKE_HARNESS_FAIL_ADD: "play@oneezy-skills" }, m.home);
  assert.equal(refused.status, 1, refused.stdout);
  assert.deepEqual(snapshot(a), before);
  assert.deepEqual(loads(a), { ...DEVELOPMENT });

  const done = await sync();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.ok(writes(done).includes("codex plugin add play@oneezy-skills --json"), JSON.stringify(writes(done)));
  assert.deepEqual(loads(a), DEVELOPMENT);
  assert.deepEqual(loads(plain), RELEASED);

  // b selects oneezy, whose first build fails: nothing is activated there, and b keeps what sync gave it
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), "no frontmatter\n");
  const failed = await develop(b, ["setup", "oneezy", "--repo", lib]);
  assert.equal(failed.status, 1, failed.stdout);
  assert.match(failed.stdout, /oneezy: development build failed/);
  assert.equal(fs.existsSync(path.join(b, ".agents")), false);
  assert.deepEqual(loads(b), RELEASED);
  assert.deepEqual(loads(a), DEVELOPMENT);
  const after = await sync(b);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  assert.deepEqual(writes(after), []);
});

test("release packaging beside Development projects: build --plugins --catalogs --artifacts writes the release outputs only, runs no Harness, and leaves the development output and the projects as they were", async () => {
  const { m, lib, a, b, plain, sync, develop, loads } = machine();
  assert.equal((await sync()).status, 0);
  for (const p of [a, b]) assert.equal((await develop(p, ["setup", "play", "--repo", lib])).status, 0);
  const dev = path.join(lib, "dist", "development");
  const before = { dev: snapshot(dev), a: snapshot(a), b: snapshot(b), home: snapshot(m.home) };

  for (const args of [
    ["build", "--plugins", "--catalogs"],
    ["build", "--artifacts"],
    ["build", "--check"],
  ]) {
    const r = await cli(m, [...args, "--repo", lib], ON, lib);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.calls, [], `${args.join(" ")} runs no Harness command`);
  }

  assert.ok(fs.existsSync(path.join(lib, "plugins", "play", ".claude-plugin", "plugin.json")));
  assert.ok(fs.existsSync(path.join(lib, "artifacts", "releases.json")));
  assert.deepEqual(
    { dev: snapshot(dev), a: snapshot(a), b: snapshot(b), home: snapshot(m.home) },
    before,
    "the development output, both projects and the Harness homes are untouched",
  );
  // the release catalogs point at plugins/, never at the development builds
  for (const file of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"])
    assert.doesNotMatch(fs.readFileSync(path.join(lib, ...file.split("/")), "utf8"), /dist\/development|development/);
  assert.deepEqual(loads(a), DEVELOPMENT);
  assert.deepEqual(loads(b), DEVELOPMENT);
  assert.deepEqual(loads(plain), RELEASED);
});

test("the release build refuses a Hermes rendering that overlaps the development output, and leaves that output alone", async () => {
  const { m, lib, a, develop } = machine();
  assert.equal((await develop(a, ["setup", "play", "--repo", lib])).status, 0);
  const dev = path.join(lib, "dist", "development");
  const before = snapshot(dev);
  const config = JSON.parse(fs.readFileSync(path.join(lib, "skills-sync.json"), "utf8"));
  for (const hermes of ["dist", "dist/development", "dist/development/hermes"]) {
    write(path.join(lib, "skills-sync.json"), JSON.stringify({ ...config, renderings: { hermes } }, null, 2) + "\n");
    for (const args of [
      ["build", "--plugins", "--catalogs"],
      ["build", "--check"],
    ]) {
      const r = await cli(m, [...args, "--repo", lib], ON, lib);
      assert.equal(r.status, 1, `${hermes}, ${args.join(" ")}: ${r.stdout}`);
      assert.match(
        r.stdout,
        new RegExp(`renderings\\.hermes \\(${hermes.replace(/\//g, "\\/")}\\) overlaps dist/development`),
      );
    }
    assert.deepEqual(snapshot(dev), before, hermes);
  }
  // dist/hermes beside it is fine
  write(
    path.join(lib, "skills-sync.json"),
    JSON.stringify({ ...config, renderings: { hermes: "dist/hermes" } }, null, 2) + "\n",
  );
  const ok = await cli(m, ["build", "--plugins", "--catalogs", "--repo", lib], ON, lib);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(fs.existsSync(path.join(lib, "dist", "hermes", "play")));
  assert.deepEqual(snapshot(dev), before);
});

test("development commands publish nothing and leave every release output and marketplace version as it was", async () => {
  const { m, lib, a, b, sync, develop } = machine();
  assert.equal((await sync()).status, 0);
  assert.equal((await cli(m, ["build", "--plugins", "--catalogs", "--artifacts", "--repo", lib], ON, lib)).status, 0);
  const release = () =>
    [
      "skills-sync.json",
      "skills-sync.lock.json",
      "plugins",
      "artifacts",
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
    ].flatMap((rel) => {
      const p = path.join(lib, ...rel.split("/"));
      return fs.statSync(p).isDirectory()
        ? snapshot(p).map((e) => `${rel}/${e}`)
        : [`${rel} ${fs.readFileSync(p, "utf8")}`];
    });
  const installed = () =>
    JSON.parse(fs.readFileSync(path.join(m.codexHome, "fake-harness.json"), "utf8")) as {
      plugins: Record<string, { version: string | null }>;
      sources: Record<string, unknown>;
    };
  const before = release();
  const versions = Object.fromEntries(
    Object.entries(installed().plugins)
      .filter(([id]) => id.endsWith("@oneezy-skills"))
      .map(([id, p]) => [id, p.version]),
  );

  const runs: Run[] = [];
  runs.push(await develop(a, ["build", "--repo", lib]));
  runs.push(await develop(a, ["setup", "play", "--repo", lib]));
  runs.push(await develop(b, ["setup", "play", "oneezy", "--repo", lib]));
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi", "edited greeting"));
  runs.push(await develop(a, ["build", "--repo", lib]));
  runs.push(await develop(a, ["setup", "play", "--repo", lib]));
  runs.push(await develop(a, ["status"]));
  runs.push(await develop(b, ["remove"]));
  runs.push(await develop(a, ["remove"]));

  for (const r of runs) {
    assert.ok(r.status === 0, r.stdout + r.stderr);
    assert.deepEqual(r.requests, [], "no GitHub request");
    const touched = writes(r).filter((c) =>
      /@oneezy-skills\b(?!-)|marketplace (add|upgrade|remove) (oneezy\/skills|oneezy-skills\b(?!-))/.test(c),
    );
    assert.deepEqual(touched, [], "no command on the release marketplace or its plugins");
  }
  assert.deepEqual(
    release(),
    before,
    "plugins/, the catalogs, artifacts/ and the config are as the release build left them",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(installed().plugins)
        .filter(([id]) => id.endsWith("@oneezy-skills"))
        .map(([id, p]) => [id, p.version]),
    ),
    versions,
  );
});
