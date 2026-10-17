// develop watch: the one Development watcher of a Library, owned by the terminal that started it. Each test runs the
// built CLI on a pretend machine (temporary home, fake Harnesses), inside a fake terminal process (fixtures/fake-terminal)
// that a test can close by killing it. The Library has two own Groups; projects a and b are connected to it with play,
// so their Source aliases are two ways into the one source. Tests assert the processes alive, what the watcher printed,
// the development output and status.json on disk, and develop status --json.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { cli, cliEnv, destroy, pretendMachine, write, type PretendMachine } from "./machine.js";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const TERMINAL = path.resolve(import.meta.dirname, "fixtures", "fake-terminal", "fake-terminal.mjs");
/** a quick heartbeat, so a watcher left without its terminal notices within a second */
const FAST = { SKILLS_SYNC_WATCH_HEARTBEAT_MS: "150" };

const machines: PretendMachine[] = [];
const terminals: ChildProcess[] = [];
const watchers: number[] = [];
afterEach(() => {
  for (const t of terminals.splice(0)) t.kill("SIGKILL");
  for (const pid of watchers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const m of machines.splice(0)) destroy(m);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, condition: () => boolean, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (condition()) return;
  throw new Error(`timed out waiting for ${what}`);
}

function skill(name: string, body = `${name} body`): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

function gitIn(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

/** A pretend machine with a Library (Groups oneezy and play) and git projects a and b, both set up with play. */
async function connectedMachine() {
  const m = pretendMachine({ env: FAST });
  machines.push(m);
  const lib = path.join(m.base, "library");
  write(
    path.join(lib, "skills-sync.json"),
    JSON.stringify(
      {
        version: 1,
        library: { name: "skills", owner: "oneezy", homepage: "https://github.com/oneezy/skills", version: "1.2.3" },
        sources: {},
        plugins: {
          oneezy: { displayName: "Oneezy", description: "Justin's own skills.", group: "oneezy" },
          play: { displayName: "Play", description: "The playground.", group: "play" },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(path.join(lib, "skills-sync.lock.json"), JSON.stringify({ version: 2, sources: {} }) + "\n");
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello"));
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi"));
  const project = async (name: string) => {
    const dir = path.join(m.base, "projects", name);
    fs.mkdirSync(dir, { recursive: true });
    gitIn(dir, "init", "-q");
    const r = await cli(m, ["develop", "setup", "play", "--repo", lib], {}, dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return dir;
  };
  const a = await project("a");
  const b = await project("b");
  const output = path.join(lib, "dist", "development");
  /** the play-hi SKILL.md as the development build has it */
  const built = (rel = "play-hi/SKILL.md") => {
    const file = path.join(output, "plugins", "play", "skills", ...rel.split("/"));
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  /** the source file, edited through a project's Source alias */
  const via = (project: string, rel: string) => path.join(project, ".agents", "skills-library", ...rel.split("/"));
  return { m, lib, a, b, output, built, via };
}

interface Terminal {
  process: ChildProcess;
  /** everything the command printed so far */
  log(): string;
  /** the command's exit code, once the terminal has closed */
  exited: Promise<number | null>;
}

/**
 * `skills-sync develop watch <args>` in a new fake terminal, in `cwd`: a shell's by default, or run by a Node parent
 * (pnpm) with `kind` "node" (see fixtures/fake-terminal for why that differs on Windows).
 */
function terminal(m: PretendMachine, cwd: string, ...args: string[]): Terminal {
  return terminalOf("shell", m, cwd, ...args);
}

function terminalOf(kind: "shell" | "node", m: PretendMachine, cwd: string, ...args: string[]): Terminal {
  const log = path.join(m.base, `terminal-${terminals.length}.log`);
  fs.writeFileSync(log, "");
  const child = spawn(process.execPath, [TERMINAL, log, kind, process.execPath, CLI, "develop", "watch", ...args], {
    cwd,
    env: cliEnv(m),
    stdio: "ignore",
  });
  terminals.push(child);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { process: child, log: () => fs.readFileSync(log, "utf8"), exited };
}

/** The watcher's pid, as its start line prints it. */
async function ownerPid(t: Terminal): Promise<number> {
  await until("the watcher to start", () => /owns the watcher \(pid \d+\)/.test(t.log()));
  const pid = Number(/owns the watcher \(pid (\d+)\)/.exec(t.log())![1]);
  watchers.push(pid);
  return pid;
}

/** The build lines the watcher printed: one per build it ran. */
const builds = (t: Terminal) => t.log().match(/^\S+ build \d+: .*$/gm) ?? [];

test("the first terminal owns the watcher and builds the connected Plugins; a later launch names that owner and starts nothing", async () => {
  const { m, a, b, output, built } = await connectedMachine();

  const first = terminal(m, a);
  const pid = await ownerPid(first);
  await until("the first build", () => builds(first).length === 1);

  assert.match(builds(first)[0] ?? "", /build 1: play built/);
  assert.match(built() ?? "", /play-hi body/);
  // only what a connected project selected: nobody uses oneezy
  assert.equal(fs.existsSync(path.join(output, "plugins", "oneezy")), false);
  const status = fs.readFileSync(path.join(output, "status.json"), "utf8");

  const second = await cli(m, ["develop", "watch"], {}, b);

  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, new RegExp(`already runs: pid ${pid}, started .* from ${escape(fs.realpathSync(a))}`));
  assert.ok(alive(pid));
  assert.equal(fs.readFileSync(path.join(output, "status.json"), "utf8"), status);
  const s = await cli(m, ["develop", "status", "--json"], {}, b);
  const watcher = s.json!.watcher as { state: string; owner: { pid: number; project: string } };
  assert.equal(watcher.state, "running");
  assert.equal(watcher.owner.pid, pid);
  assert.equal(fs.realpathSync(watcher.owner.project), fs.realpathSync(a));
  assert.equal(builds(first).length, 1);
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("two terminals launched at once leave one owner: the other names it and exits", async () => {
  const { m, a, b } = await connectedMachine();

  const both = [terminal(m, a), terminal(m, b)];
  const codes = await Promise.race([
    Promise.any(both.map((t, i) => t.exited.then((code) => [i, code] as const))),
    wait(20_000).then(() => null),
  ]);

  assert.ok(codes, "one launch should have exited");
  const [gone, code] = codes;
  assert.equal(code, 0, both[gone].log());
  const owner = both[1 - gone];
  const pid = await ownerPid(owner);
  assert.match(both[gone].log(), new RegExp(`already runs: pid ${pid}`));
  await wait(500);
  assert.equal(owner.process.exitCode, null, "the owner keeps running");
  assert.ok(alive(pid));
});

interface StatusJson {
  watcher: { state: string; owner: { pid: number } | null; note: string; plugins: string[]; behind: string[] };
}

test("closing the owning terminal stops the watcher; the last build stays, status says stopped, and edits wait", async () => {
  const { m, lib, a, b, output, built, via } = await connectedMachine();
  const t = terminal(m, a);
  const pid = await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);

  t.process.kill("SIGKILL");
  await until("the watcher to stop", () => !alive(pid));

  const record = fs.readFileSync(path.join(output, "watcher.json"), "utf8");
  assert.match(t.log(), /Watcher stopped: its terminal closed\. The last successful builds stay in place/, record);
  assert.equal(JSON.parse(record).state, "stopped", record);
  assert.match(built() ?? "", /play-hi body/);
  fs.writeFileSync(via(b, "skills/play/play-hi/SKILL.md"), skill("play-hi", "edited while stopped"));
  await wait(600);
  assert.match(built() ?? "", /play-hi body/, "no watcher, no build");
  const s = await cli(m, ["develop", "status", "--json"], {}, a);
  const w = (s.json as unknown as StatusJson).watcher;
  assert.equal(w.state, "stopped");
  assert.equal(w.owner, null);
  assert.deepEqual(w.behind, ["play"]);
  const text = await cli(m, ["develop", "status", "--repo", lib], {}, a);
  assert.match(text.stdout, /Development watcher: stopped \(stopped .* \(its terminal closed\); edits are not built/);
  assert.match(text.stdout, /not built yet: play; develop watch builds them as it starts/);
});

test("a watcher killed outright is reported stopped, and the next launch owns the watcher afresh and catches up", async () => {
  const { m, a, b, built, via } = await connectedMachine();
  const first = terminal(m, a);
  const pid = await ownerPid(first);
  await until("the first build", () => builds(first).length === 1);

  process.kill(pid, "SIGKILL");
  await until("the watcher to die", () => !alive(pid));
  const s = (await cli(m, ["develop", "status", "--json"], {}, b)).json as unknown as StatusJson;
  assert.equal(s.watcher.state, "stopped");
  assert.match(s.watcher.note, new RegExp(`its owner \\(pid ${pid}\\) ended without stopping`));
  fs.writeFileSync(via(b, "skills/play/play-hi/SKILL.md"), skill("play-hi", "edited while stopped"));
  fs.mkdirSync(via(b, "skills/play/play-new"));
  fs.writeFileSync(via(b, "skills/play/play-new/SKILL.md"), skill("play-new"));

  const second = terminal(m, b);
  const next = await ownerPid(second);
  await until("the catch-up build", () => builds(second).length === 1);

  assert.notEqual(next, pid);
  assert.match(builds(second)[0] ?? "", /build 1: play built/);
  assert.match(built() ?? "", /edited while stopped/);
  assert.match(built("play-new/SKILL.md") ?? "", /play-new body/);
});

test("a terminal that is a Node process (pnpm) takes the watcher with it on Windows; status still says stopped", async () => {
  const { m, a, b, output } = await connectedMachine();
  const t = terminalOf("node", m, a);
  const pid = await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);

  t.process.kill("SIGKILL");
  await until("the watcher to end", () => !alive(pid));

  const record = fs.readFileSync(path.join(output, "watcher.json"), "utf8");
  const s = (await cli(m, ["develop", "status", "--json"], {}, b)).json as unknown as StatusJson;
  assert.equal(s.watcher.state, "stopped", record);
  if (process.platform === "win32") {
    // Windows ended the watcher with its parent's job: it had no moment to write, so the record still names it
    assert.equal(JSON.parse(record).state, "running", record);
    assert.doesNotMatch(t.log(), /Watcher stopped/);
    assert.match(s.watcher.note, new RegExp(`its owner \\(pid ${pid}\\) ended without stopping`));
  } else {
    // elsewhere the watcher outlives its parent long enough to notice and stop cleanly
    assert.equal(JSON.parse(record).state, "stopped", record);
    assert.match(t.log(), /Watcher stopped: its terminal closed/);
  }
  const next = terminal(m, b);
  assert.notEqual(await ownerPid(next), pid);
});

test.skipIf(process.platform === "win32")(
  "Ctrl+C or a hang-up in the owning terminal stops the watcher cleanly",
  async () => {
    const { m, a, output } = await connectedMachine();
    for (const signal of ["SIGINT", "SIGHUP"] as const) {
      const t = terminal(m, a);
      const pid = await ownerPid(t);
      await until("a build", () => builds(t).length === 1);

      process.kill(pid, signal);

      assert.equal(await t.exited, 0);
      assert.match(t.log(), /Watcher stopped: /);
      assert.equal(JSON.parse(fs.readFileSync(path.join(output, "watcher.json"), "utf8")).state, "stopped");
    }
  },
);

test("identical saves and generated output do no work; edits, additions, renames, removals and supporting files rebuild", async () => {
  const { m, lib, a, output, built, via } = await connectedMachine();
  const t = terminal(m, a);
  await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);
  const status = path.join(output, "status.json");
  const before = [fs.statSync(status).mtimeMs, fs.statSync(path.join(output, "plugins", "play", "plugin.json")).ino];
  const after = async (what: string, count: number) => {
    await until(what, () => builds(t).length === count);
    assert.match(builds(t)[count - 1] ?? "", new RegExp(`build ${count}: play built`));
  };

  // the same bytes saved again, through the alias and at the source
  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), skill("play-hi"));
  fs.writeFileSync(path.join(lib, "skills-sync.json"), fs.readFileSync(path.join(lib, "skills-sync.json")));
  // generated output: the release packages, the Hermes rendering, the archives, the development output itself
  write(path.join(lib, "plugins", "play", "NOTICE.md"), "release\n");
  write(path.join(lib, "dist", "hermes", "play", "x.md"), "hermes\n");
  write(path.join(lib, "artifacts", "play-1.2.3.zip"), "zip\n");
  write(path.join(output, "plugins", "play", "skills", "play-hi", "stray.md"), "stray\n");
  fs.rmSync(path.join(output, "plugins", "play", "skills", "play-hi", "stray.md"));
  write(path.join(lib, ".git", "index"), "git\n");
  await wait(1000);

  assert.equal(builds(t).length, 1, t.log());
  assert.deepEqual(
    [fs.statSync(status).mtimeMs, fs.statSync(path.join(output, "plugins", "play", "plugin.json")).ino],
    before,
  );

  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), skill("play-hi", "edited"));
  await after("an edit", 2);
  assert.match(built() ?? "", /edited/);
  write(via(a, "skills/play/play-hi/references/notes.md"), "notes\n");
  await after("a supporting file", 3);
  assert.equal(built("play-hi/references/notes.md"), "notes\n");
  write(via(a, "skills/play/play-two/SKILL.md"), skill("play-two"));
  await after("an addition", 4);
  assert.match(built("play-two/SKILL.md") ?? "", /play-two body/);
  fs.renameSync(via(a, "skills/play/play-two"), via(a, "skills/play/play-three"));
  write(via(a, "skills/play/play-three/SKILL.md"), skill("play-three"));
  await after("a rename", 5);
  assert.equal(built("play-two/SKILL.md"), null);
  assert.match(built("play-three/SKILL.md") ?? "", /play-three body/);
  fs.rmSync(via(a, "skills/play/play-three"), { recursive: true });
  await after("a removal", 6);
  assert.equal(built("play-three/SKILL.md"), null);
  // an edit to a Plugin nobody selects changes no output, and is checked without writing
  fs.writeFileSync(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello", "edited"));
  await until("a check", () => builds(t).length === 7);
  assert.match(builds(t)[6] ?? "", /build 7: play unchanged/);
  assert.equal(fs.existsSync(path.join(output, "plugins", "oneezy")), false);
});

test("edits through the two projects' aliases reach the one source and are built once", async () => {
  const { m, lib, a, b, built, via } = await connectedMachine();
  const t = terminal(m, a);
  await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);

  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), skill("play-hi", "from a"));
  write(via(b, "skills/play/play-hi/references/from-b.md"), "from b\n");
  await until("a build", () => builds(t).length === 2);
  await wait(800);

  assert.equal(builds(t).length, 2, t.log());
  assert.match(builds(t)[1] ?? "", /build 2: play built/);
  assert.match(built() ?? "", /from a/);
  assert.equal(built("play-hi/references/from-b.md"), "from b\n");
  assert.equal(
    fs.readFileSync(path.join(lib, "skills", "play", "play-hi", "references", "from-b.md"), "utf8"),
    "from b\n",
  );

  fs.writeFileSync(via(b, "skills/play/play-hi/SKILL.md"), skill("play-hi", "from b"));
  await until("a build", () => builds(t).length === 3);
  await wait(800);
  assert.equal(builds(t).length, 3, "one edit through an alias is one build, whichever project made it");
  assert.match(built() ?? "", /from b/);
});

test("a failed build keeps the last successful one and says so; the fix rebuilds it", async () => {
  const { m, a, output, built, via } = await connectedMachine();
  const t = terminal(m, a);
  await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);

  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), "---\nname: play-hi\n---\nno description\n");
  await until("the failed build", () => builds(t).length === 2);

  assert.match(builds(t)[1] ?? "", /build 2: play stale \(the last successful build stays\)/);
  assert.match(t.log(), /^ {2}! play: skills\/play\/play-hi\/SKILL\.md: .*description/m);
  assert.match(built() ?? "", /play-hi body/);
  const stale = JSON.parse(fs.readFileSync(path.join(output, "status.json"), "utf8")).plugins.play;
  assert.equal(stale.state, "stale");
  const s = await cli(m, ["develop", "status", "--json"], {}, a);
  assert.deepEqual(
    (s.json!.plugins as { id: string; build: string }[]).map((p) => [p.id, p.build]),
    [["play", "stale"]],
  );
  // the same broken bytes again: nothing to do
  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), "---\nname: play-hi\n---\nno description\n");
  await wait(800);
  assert.equal(builds(t).length, 2);

  fs.writeFileSync(via(a, "skills/play/play-hi/SKILL.md"), skill("play-hi", "fixed"));
  await until("the recovery", () => builds(t).length === 3);

  assert.match(builds(t)[2] ?? "", /build 3: play built/);
  assert.match(built() ?? "", /fixed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, "status.json"), "utf8")).plugins.play.state, "ok");
});

test("a project set up while the watcher runs has its Plugins built by that watcher", async () => {
  const { m, lib, a, output } = await connectedMachine();
  const t = terminal(m, a);
  await ownerPid(t);
  await until("the first build", () => builds(t).length === 1);
  const c = path.join(m.base, "projects", "c");
  fs.mkdirSync(c, { recursive: true });
  gitIn(c, "init", "-q");

  const r = await cli(m, ["develop", "setup", "oneezy", "--repo", lib], {}, c);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  await until("a build for the new selection", () => builds(t).length === 2);
  assert.match(builds(t)[1] ?? "", /build 2: oneezy built, play unchanged/);
  assert.ok(fs.existsSync(path.join(output, "plugins", "oneezy", "skills", "hello", "SKILL.md")));
});
