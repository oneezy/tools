// develop setup, status and remove: a project connected to the one editable Library, run through the built CLI on a
// pretend machine. The Library is a temp folder with two own Groups; the projects are temp git repositories. Tests
// assert links and their targets, the record and the exclusions on disk, git's view of the project, the --json
// status, the exit code, and that the Library's source and every Harness folder stay as they were.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { projectStatus, removeProject, setupProject, type HarnessAdapter } from "../src/develop-project.js";
import { isLink, linkTarget } from "../src/fs.js";
import { Library } from "../src/library.js";
import { Report } from "../src/plan.js";
import { cli, destroy, pretendMachine, snapshot, write, type PretendMachine } from "./machine.js";

const machines: PretendMachine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

function skill(name: string, body = `${name} body`): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

function gitIn(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** A pretend machine with a Library at <base>/library (Groups oneezy and play) and git projects a, b and plain. */
function machineWithProjects() {
  const f = machineWithProjectsSync();
  const develop = (cwd: string, ...args: string[]) => cli(f.m, ["develop", ...args], {}, cwd);
  return { ...f, develop };
}

function machineWithProjectsSync() {
  const m = pretendMachine();
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
  return { m, lib, a, b, plain };
}

const alias = (project: string) => path.join(project, ".agents", "skills-library");
const record = (project: string) => path.join(project, ".agents", "skills-sync-project.json");

test("setup links two projects to the one Library, so an edit through either alias reaches the same source", async () => {
  const { m, lib, a, b, develop } = machineWithProjects();
  const harnesses = [snapshot(m.claudeHome), snapshot(m.codexHome)];

  const ra = await develop(a, "setup", "play", "--repo", lib);
  const rb = await develop(b, "setup", "play", "--repo", lib);

  assert.equal(ra.status, 0, ra.stdout + ra.stderr);
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  for (const p of [a, b]) {
    assert.ok(isLink(alias(p)));
    assert.equal(fs.realpathSync(alias(p)), fs.realpathSync(lib));
  }
  const viaA = path.join(alias(a), "skills", "play", "play-hi", "SKILL.md");
  fs.writeFileSync(viaA, skill("play-hi", "edited through a"));
  const source = path.join(lib, "skills", "play", "play-hi", "SKILL.md");
  assert.equal(fs.readFileSync(source, "utf8"), skill("play-hi", "edited through a"));
  assert.equal(
    fs.readFileSync(path.join(alias(b), "skills", "play", "play-hi", "SKILL.md"), "utf8"),
    skill("play-hi", "edited through a"),
  );
  // nothing in any Harness folder, and git sees no new file in either project
  assert.deepEqual([snapshot(m.claudeHome), snapshot(m.codexHome)], harnesses);
  for (const p of [a, b]) assert.equal(gitIn(p, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
});

test("setup uses only the Plugins the project selects, and refuses an unknown, qualified or ambiguous identity", async () => {
  const { lib, a, plain, develop } = machineWithProjects();

  const r = await develop(a, "setup", "play", "--repo", lib, "--json");

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const kept = JSON.parse(fs.readFileSync(record(a), "utf8"));
  assert.deepEqual(kept.plugins, ["play"]);
  assert.equal(fs.realpathSync(kept.library), fs.realpathSync(lib));

  const before = snapshot(plain);
  for (const [names, why] of [
    [[], /Name the Plugins this project uses: oneezy, play/],
    [["nope"], /nope is not a Plugin of this Library \(oneezy, play\)/],
    [["play@oneezy-skills"], /play@oneezy-skills names a Harness origin; give the Plugin's id: play/],
    [["Play"], /Play is ambiguous: identities are exact, and the Library has play/],
  ] as const) {
    const refused = await develop(plain, "setup", ...names, "--repo", lib);
    assert.equal(refused.status, 1, `${names.join(" ")}: ${refused.stdout}`);
    assert.match(refused.stdout, why);
    assert.deepEqual(snapshot(plain), before, `${names.join(" ")} wrote nothing`);
  }
});

test("setup matches a Plugin by its id only, never by its display name", async () => {
  const { lib, plain, develop } = machineWithProjects();
  const config = JSON.parse(fs.readFileSync(path.join(lib, "skills-sync.json"), "utf8"));
  config.plugins.play.displayName = "Playground";
  fs.writeFileSync(path.join(lib, "skills-sync.json"), JSON.stringify(config, null, 2) + "\n");
  const before = snapshot(plain);

  const r = await develop(plain, "setup", "playground", "--repo", lib);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /playground is ambiguous: identities are exact, and the Library has play/);
  assert.deepEqual(snapshot(plain), before);
});

test("repeated setup changes nothing, and a later setup can change the selection", async () => {
  const { lib, a, develop } = machineWithProjects();
  await develop(a, "setup", "play", "--repo", lib);
  const first = snapshot(a);

  const again = await develop(a, "setup", "--json");

  assert.equal(again.status, 0, again.stdout + again.stderr);
  const changes = (again.json as { actions: { kind: string }[] }).actions.filter(
    (x) => !["skip", "note"].includes(x.kind),
  );
  assert.deepEqual(changes, []);
  assert.deepEqual(snapshot(a), first);
  const more = await develop(path.join(a, ".agents"), "setup", "oneezy", "play");
  assert.equal(more.status, 0, more.stdout + more.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(record(a), "utf8")).plugins, ["oneezy", "play"]);
});

test("setup refuses a foreign path or another Library, and changes nothing", async () => {
  const { m, lib, a, b, plain, develop } = machineWithProjects();
  // a: the alias is a real folder of the project's own
  write(path.join(alias(a), "notes.md"), "mine\n");
  // b: the alias is a link somewhere else
  const elsewhere = path.join(m.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(b, ".agents"));
  fs.symlinkSync(elsewhere, alias(b), "dir");
  // plain: connected to another Library already
  const other = path.join(m.base, "other-library");
  fs.cpSync(lib, other, { recursive: true });
  assert.equal((await develop(plain, "setup", "play", "--repo", other)).status, 0);
  const before = [snapshot(a), snapshot(b), snapshot(plain)];

  const ra = await develop(a, "setup", "play", "--repo", lib);
  const rb = await develop(b, "setup", "play", "--repo", lib);
  const rp = await develop(plain, "setup", "play", "--repo", lib);

  assert.equal(ra.status, 1);
  assert.match(ra.stdout, /skills-library .*Something else is at the Source alias; left untouched/);
  assert.equal(rb.status, 1);
  assert.match(rb.stdout, /Something else is at the Source alias/);
  assert.equal(rp.status, 1);
  assert.match(rp.stdout, /connected to .*other-library; run develop remove first/);
  assert.deepEqual([snapshot(a), snapshot(b), snapshot(plain)], before);
  assert.equal(linkTarget(alias(b)), elsewhere);
  const source = snapshot(lib);
  const inside = await develop(lib, "setup", "play", "--repo", lib, "--root", path.join(lib, "skills"));
  assert.equal(inside.status, 1);
  assert.match(inside.stdout, /The project is inside the Library/);
  assert.deepEqual(snapshot(lib), source);
});

test("remove restores the project as it was, keeps later edits and the source, and is idempotent", async () => {
  const { lib, a, b, develop } = machineWithProjects();
  const exclude = path.join(a, ".git", "info", "exclude");
  const excludeBefore = fs.readFileSync(exclude, "utf8");
  const before = snapshot(a);
  const source = snapshot(path.join(lib, "skills"));
  await develop(a, "setup", "play", "--repo", lib);
  await develop(b, "setup", "play", "--repo", lib);

  const r = await develop(a, "remove");

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(a), before);
  assert.equal(fs.readFileSync(exclude, "utf8"), excludeBefore);
  assert.deepEqual(snapshot(path.join(lib, "skills")), source);
  assert.ok(isLink(alias(b)), "the other project stays connected");
  const again = await develop(a, "remove", "--json");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(
    (again.json as { actions: { kind: string }[] }).actions.filter((x) => x.kind !== "note"),
    [],
  );
  assert.deepEqual(snapshot(a), before);

  // b, edited by hand since setup: its own exclude line and file stay; the alias it replaced is its own now
  fs.appendFileSync(path.join(b, ".git", "info", "exclude"), "/scratch/\n");
  write(path.join(b, ".agents", "mine.md"), "mine\n");
  fs.unlinkSync(alias(b));
  write(path.join(alias(b), "notes.md"), "mine too\n");
  const rb = await develop(b, "remove");
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.match(rb.stdout, /skills-library .*changed since setup; kept/);
  assert.equal(fs.readFileSync(path.join(alias(b), "notes.md"), "utf8"), "mine too\n");
  assert.equal(fs.readFileSync(path.join(b, ".agents", "mine.md"), "utf8"), "mine\n");
  assert.equal(fs.existsSync(record(b)), false);
  const bExclude = fs.readFileSync(path.join(b, ".git", "info", "exclude"), "utf8");
  assert.match(bExclude, /^\/scratch\/$/m);
  assert.doesNotMatch(bExclude, /skills-sync/);
  assert.deepEqual(snapshot(path.join(lib, "skills")), source);
});

interface Status {
  project: string;
  registered: boolean;
  library: string | null;
  alias: { path: string; state: string } | null;
  plugins: { id: string; build: string; output: string | null }[];
  harnesses: { harness: string; state: string }[];
  projects: { path: string; plugins: string[]; state: string }[];
  problems: string[];
}

test("the launcher works in any project and activates nothing where setup was not run", async () => {
  const { m, lib, plain, develop } = machineWithProjects();
  const before = [snapshot(plain), snapshot(lib), snapshot(m.home)];

  const r = await develop(plain, "status", "--json");
  const text = await develop(path.join(m.base, "projects"), "status");

  assert.equal(r.status, 0, r.stdout + r.stderr);
  const s = r.json as unknown as Status;
  assert.equal(s.registered, false);
  assert.equal(fs.realpathSync(s.project), fs.realpathSync(plain));
  assert.deepEqual(s.plugins, []);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(
    text.stdout,
    /not a Development project: released Plugins only; develop setup <plugin>\.\.\. --repo <library> connects it/,
  );
  assert.deepEqual([snapshot(plain), snapshot(lib), snapshot(m.home)], before);
});

test("status names the Library, each selected Plugin's build, the alias, the Harnesses and the connected projects", async () => {
  const { lib, a, b, develop, m } = machineWithProjects();
  await develop(a, "setup", "play", "--repo", lib);
  await develop(b, "setup", "oneezy", "--repo", lib);

  const first = (await develop(a, "status", "--json")).json as unknown as Status;

  assert.equal(first.registered, true);
  assert.equal(fs.realpathSync(first.library!), fs.realpathSync(lib));
  assert.deepEqual(first.alias?.state, "ok");
  assert.deepEqual(
    first.plugins.map((p) => [p.id, p.build, p.output]),
    [["play", "not built", null]],
  );
  assert.deepEqual(first.harnesses, [
    { harness: "claude-code", state: "not activated", note: "no verified Harness adapter yet" },
    { harness: "codex", state: "not activated", note: "no verified Harness adapter yet" },
  ]);
  assert.deepEqual(
    first.projects.map((p) => [fs.realpathSync(p.path), p.plugins, p.state]),
    [
      [fs.realpathSync(a), ["play"], "connected"],
      [fs.realpathSync(b), ["oneezy"], "connected"],
    ],
  );

  assert.equal((await cli(m, ["develop", "build", "play", "--repo", lib], {}, lib)).status, 0);
  fs.rmSync(b, { recursive: true, force: true });
  fs.unlinkSync(alias(a));
  const later = await develop(a, "status", "--json");
  const s = later.json as unknown as Status;
  assert.equal(later.status, 1, "a missing alias is a problem");
  assert.deepEqual(
    s.plugins.map((p) => [p.id, p.build]),
    [["play", "ok"]],
  );
  assert.equal(
    fs.realpathSync(s.plugins[0].output!),
    fs.realpathSync(path.join(lib, "dist", "development", "plugins", "play")),
  );
  assert.equal(s.alias?.state, "missing");
  assert.match(s.problems.join("\n"), /skills-library is missing; develop setup puts it back/);
  assert.deepEqual(
    s.projects.map((p) => p.state),
    ["connected", "gone"],
  );
});

test("plan previews setup and remove and writes nothing", async () => {
  const { lib, a, develop } = machineWithProjects();
  const before = [snapshot(a), snapshot(lib)];
  const planned = await develop(a, "setup", "play", "--repo", lib, "--plan");
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.match(planned.stdout, /\+ link +.*skills-library -> /);
  assert.deepEqual([snapshot(a), snapshot(lib)], before);
  await develop(a, "setup", "play", "--repo", lib);
  const connected = [snapshot(a), snapshot(lib)];
  const plannedRemove = await develop(a, "remove", "--plan");
  assert.equal(plannedRemove.status, 0, plannedRemove.stdout + plannedRemove.stderr);
  assert.match(plannedRemove.stdout, /- delete +.*\.agents\n/);
  assert.deepEqual([snapshot(a), snapshot(lib)], connected);
});

test("an unverified Harness adapter is never run; a verified one's owned state is recorded and handed back to remove", () => {
  const { lib, a } = machineWithProjectsSync();
  const calls: string[] = [];
  const unverified: HarnessAdapter = {
    harness: "unproven",
    verified: false,
    setup: () => {
      throw new Error("an unverified adapter ran");
    },
    remove: () => {
      throw new Error("an unverified adapter ran");
    },
  };
  const marker = path.join(a, ".fake-harness");
  const fake: HarnessAdapter = {
    harness: "fake",
    verified: true,
    setup: (ctx) => {
      calls.push(`setup ${ctx.plugins.join(",")} ${JSON.stringify(ctx.owned)}`);
      const report = new Report();
      if (!fs.existsSync(marker)) report.add({ kind: "write", path: marker, payload: "on\n", expectedHash: null });
      return { report, owned: { marker } };
    },
    remove: (ctx) => {
      calls.push(`remove ${JSON.stringify(ctx.owned)}`);
      const report = new Report();
      report.add({ kind: "delete", path: (ctx.owned as { marker: string }).marker });
      return report;
    },
  };
  const adapters = [unverified, fake];

  const setup = setupProject(a, new Library(lib), ["play"], { plan: false, adapters });
  assert.deepEqual(setup.conflicts(), []);
  assert.match(
    setup.actions.map((x) => x.note ?? "").join("\n"),
    /unproven: not activated: its adapter is not verified/,
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "on\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(record(a), "utf8")).harnesses, { fake: { marker } });
  setupProject(a, new Library(lib), [], { plan: false, adapters });
  const removed = removeProject(a, { plan: false, adapters });
  assert.deepEqual(removed.conflicts(), []);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(calls, [
    `setup play null`,
    `setup play ${JSON.stringify({ marker })}`,
    `remove ${JSON.stringify({ marker })}`,
  ]);
});

test("remove refuses when the record names state no adapter here can take back", () => {
  const { lib, a } = machineWithProjectsSync();
  const fake: HarnessAdapter = {
    harness: "fake",
    verified: true,
    setup: () => ({ report: new Report(), owned: { entry: 1 } }),
    remove: () => new Report(),
  };
  setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [fake] });
  const before = snapshot(a);
  const r = removeProject(a, { plan: false, adapters: [] });
  assert.match(
    r
      .conflicts()
      .map((x) => x.note)
      .join("\n"),
    /fake owns state here, and no verified adapter for it is in this version; nothing removed/,
  );
  assert.deepEqual(snapshot(a), before);
});

test("two worktrees of one repository share its exclude block until the last one is removed", async () => {
  const { lib, a, m, develop } = machineWithProjects();
  gitIn(a, "add", "README.md");
  gitIn(a, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "first");
  const tree = path.join(m.base, "projects", "a-tree");
  gitIn(a, "worktree", "add", "-q", tree);
  const exclude = path.join(a, ".git", "info", "exclude");
  const original = fs.readFileSync(exclude, "utf8");
  await develop(a, "setup", "play", "--repo", lib);
  assert.equal((await develop(tree, "setup", "play", "--repo", lib)).status, 0);
  assert.equal(fs.realpathSync(alias(tree)), fs.realpathSync(lib));
  assert.equal(gitIn(tree, "status", "--porcelain"), "");

  const first = await develop(a, "remove");

  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /development block stays for .*a-tree/);
  assert.equal(gitIn(tree, "status", "--porcelain"), "", "the worktree's alias and record stay out of git");
  assert.equal((await develop(tree, "remove")).status, 0);
  assert.equal(fs.readFileSync(exclude, "utf8"), original);
});

test("a global install's launcher connects only the project it is run in", async () => {
  const { m, lib, a, plain } = machineWithProjectsSync();
  const prefix = path.join(m.base, "npm-global");
  const npmEnv = { ...process.env, npm_config_prefix: prefix, npm_config_cache: path.join(m.base, "npm-cache") };
  const win = process.platform === "win32";
  // Windows runs the .cmd shims through the shell, which needs every path quoted
  const q = (x: string) => (win ? `"${x}"` : x);
  // --prefix as a flag, not only the env var: on Windows an inherited NPM_CONFIG_PREFIX can win over npm_config_prefix
  const installed = spawnSync(
    win ? "npm.cmd" : "npm",
    ["install", "--global", "--prefix", q(prefix), "--no-audit", "--no-fund", "."],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: npmEnv,
      encoding: "utf8",
      shell: win,
    },
  );
  assert.equal(installed.status, 0, installed.stderr);
  const bin = win ? path.join(prefix, "skills-sync.cmd") : path.join(prefix, "bin", "skills-sync");
  assert.ok(fs.existsSync(bin), `npm put no launcher at ${bin}: ${installed.stdout}${installed.stderr}`);
  const env = { ...process.env, ...m.env };
  delete env.SKILLS_REPO;
  const launcher = (cwd: string, ...args: string[]) =>
    spawnSync(q(bin), args.map(q), { cwd, env, encoding: "utf8", shell: win });
  const home = snapshot(m.home);
  const untouched = snapshot(plain);

  const setup = launcher(a, "develop", "setup", "play", "--repo", lib);
  const elsewhere = launcher(plain, "develop", "status");

  assert.equal(setup.status, 0, setup.stdout + setup.stderr);
  assert.equal(fs.realpathSync(alias(a)), fs.realpathSync(lib));
  assert.equal(elsewhere.status, 0, elsewhere.stderr);
  assert.match(elsewhere.stdout, /not a Development project: released Plugins only/);
  assert.deepEqual(snapshot(plain), untouched);
  assert.deepEqual(snapshot(m.home), home, "nothing in the user's home or any Harness folder");
});

test("remove refuses a record edited to own something setup never makes", async () => {
  const { lib, a, m, develop } = machineWithProjects();
  await develop(a, "setup", "play", "--repo", lib);
  const kept = JSON.parse(fs.readFileSync(record(a), "utf8"));
  const outside = path.join(m.base, "empty-outside");
  fs.mkdirSync(outside);
  kept.created = [".agents", path.relative(a, outside).split(path.sep).join("/")];
  fs.writeFileSync(record(a), JSON.stringify(kept));
  const before = snapshot(a);

  const r = await develop(a, "remove");

  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a version 1 project record; nothing removed/);
  assert.deepEqual(snapshot(a), before);
  assert.ok(fs.existsSync(outside));
});

/** A verified adapter whose Harness CLI work is a call log: what a real adapter would run through `claude` or `codex`. */
function commandAdapter(calls: string[], options: { fail?: "setup" | "remove"; excludes?: string[] } = {}) {
  const ran = (what: string, failed: boolean) => {
    const report = new Report();
    calls.push(what);
    report.add(
      failed
        ? { kind: "conflict", path: what, note: `${what} refused`, failed: true }
        : { kind: "install", path: what, note: `${what} ran` },
    );
    return report;
  };
  const adapter: HarnessAdapter = {
    harness: "fake",
    verified: true,
    excludes: options.excludes,
    setup: (ctx) => ({
      report: new Report(),
      owned: { plugins: ctx.plugins },
      commands: () => ran(`setup ${ctx.plugins.join(",")}`, options.fail === "setup"),
    }),
    remove: () => ({ report: new Report(), commands: () => ran("remove", options.fail === "remove") }),
  };
  return adapter;
}

test("an adapter's commands run after setup's planned actions and before the record, never on plan", () => {
  const { lib, a } = machineWithProjectsSync();
  const calls: string[] = [];
  const base = commandAdapter(calls);
  const seen: boolean[] = [];
  const watched: HarnessAdapter = {
    ...base,
    setup: (ctx) => {
      const r = base.setup(ctx);
      const commands = r.commands!;
      return {
        ...r,
        commands: () => {
          // the alias (applied by core) is in place, the record is not written yet
          seen.push(isLink(alias(a)), fs.existsSync(record(a)));
          return commands();
        },
      };
    },
  };
  const adapters = [watched];

  const planned = setupProject(a, new Library(lib), ["play"], { plan: true, adapters });
  assert.deepEqual(calls, [], "plan runs no Harness command");
  assert.equal(fs.existsSync(record(a)), false);
  assert.deepEqual(planned.conflicts(), []);

  const done = setupProject(a, new Library(lib), ["play"], { plan: false, adapters });
  assert.deepEqual(done.conflicts(), []);
  assert.deepEqual(calls, ["setup play"]);
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(JSON.parse(fs.readFileSync(record(a), "utf8")).harnesses, { fake: { plugins: ["play"] } });
});

test("a failed adapter command leaves no record, so the next setup tries again", () => {
  const { lib, a } = machineWithProjectsSync();
  const calls: string[] = [];

  const r = setupProject(a, new Library(lib), ["play"], {
    plan: false,
    adapters: [commandAdapter(calls, { fail: "setup" })],
  });

  assert.match(
    r
      .conflicts()
      .map((x) => x.note)
      .join("\n"),
    /setup play refused/,
  );
  assert.equal(fs.existsSync(record(a)), false);
  const again = setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [commandAdapter(calls)] });
  assert.deepEqual(again.conflicts(), []);
  assert.ok(fs.existsSync(record(a)));
});

test("remove runs an adapter's commands first, and keeps the whole setup when one fails", () => {
  const { lib, a } = machineWithProjectsSync();
  const calls: string[] = [];
  setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [commandAdapter(calls)] });
  const connected = snapshot(a);

  assert.deepEqual(removeProject(a, { plan: true, adapters: [commandAdapter(calls)] }).conflicts(), []);
  const failed = removeProject(a, { plan: false, adapters: [commandAdapter(calls, { fail: "remove" })] });

  assert.match(
    failed
      .conflicts()
      .map((x) => x.note)
      .join("\n"),
    /remove refused/,
  );
  assert.deepEqual(snapshot(a), connected, "alias, record and exclude block all stay for a retry");
  const removed = removeProject(a, { plan: false, adapters: [commandAdapter(calls)] });
  assert.deepEqual(removed.conflicts(), []);
  assert.equal(fs.existsSync(record(a)), false);
  assert.deepEqual(calls, ["setup play", "remove", "remove"]);
});

test("setup builds the selection before a verified adapter activates it, and a failed first build activates nothing", () => {
  const { lib, a } = machineWithProjectsSync();
  const builds: (string | null)[][] = [];
  const watching: HarnessAdapter = {
    harness: "fake",
    verified: true,
    setup: (ctx) => {
      builds.push(ctx.build!.plugins.map((p) => `${p.id} ${p.state} ${p.output && fs.existsSync(p.output)}`));
      return { report: new Report(), owned: { on: true } };
    },
    remove: () => new Report(),
  };
  const broken = path.join(lib, "skills", "play", "play-hi", "SKILL.md");
  fs.writeFileSync(broken, "no frontmatter\n");
  const before = snapshot(a);

  const refused = setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [watching] });

  assert.match(
    refused
      .conflicts()
      .map((x) => x.note)
      .join("\n"),
    /play: development build failed: .*SKILL\.md.*; nothing activated/,
  );
  assert.deepEqual(builds, [], "the adapter is never asked");
  assert.deepEqual(snapshot(a), before, "the project is left as it was");

  fs.writeFileSync(broken, skill("play-hi"));
  const planned = setupProject(a, new Library(lib), ["play"], { plan: true, adapters: [watching] });
  assert.deepEqual(planned.conflicts(), []);
  const done = setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [watching] });
  assert.deepEqual(done.conflicts(), []);
  assert.deepEqual(builds, [["play built false"], ["play built true"]]);
  assert.ok(fs.existsSync(path.join(lib, "dist", "development", "plugins", "play", ".claude-plugin", "plugin.json")));
});

test("an adapter's excludes keep its project files out of git until remove takes the block back", async () => {
  const { lib, a } = machineWithProjectsSync();
  const exclude = path.join(a, ".git", "info", "exclude");
  const original = fs.readFileSync(exclude, "utf8");
  const local = path.join(a, ".fake", "settings.local.json");
  const adapter: HarnessAdapter = {
    harness: "fake",
    verified: true,
    excludes: ["/.fake/settings.local.json"],
    setup: () => ({
      report: new Report(),
      owned: { local },
      commands: () => {
        write(local, "{}\n");
        return new Report();
      },
    }),
    remove: () => ({
      report: new Report(),
      commands: () => {
        fs.rmSync(path.dirname(local), { recursive: true });
        return new Report();
      },
    }),
  };

  assert.deepEqual(setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [adapter] }).conflicts(), []);

  assert.equal(gitIn(a, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
  assert.match(fs.readFileSync(exclude, "utf8"), /^\/\.fake\/settings\.local\.json$/m);
  assert.deepEqual(removeProject(a, { plan: false, adapters: [adapter] }).conflicts(), []);
  assert.equal(fs.readFileSync(exclude, "utf8"), original);
});

test("when a later adapter's commands fail, setup takes back the earlier ones; one it cannot is recorded for remove", () => {
  const { lib, a } = machineWithProjectsSync();
  const calls: string[] = [];
  const named = (harness: string, fail: { setup?: boolean; remove?: boolean } = {}): HarnessAdapter => ({
    ...commandAdapter(calls),
    harness,
    setup: (ctx) => ({
      report: new Report(),
      owned: { plugins: ctx.plugins },
      commands: () => {
        calls.push(`${harness} setup`);
        const r = new Report();
        if (fail.setup) r.add({ kind: "conflict", path: harness, note: `${harness} refused`, failed: true });
        return r;
      },
    }),
    remove: () => ({
      report: new Report(),
      commands: () => {
        calls.push(`${harness} remove`);
        const r = new Report();
        if (fail.remove) r.add({ kind: "conflict", path: harness, note: `${harness} undo refused`, failed: true });
        return r;
      },
    }),
  });

  const undone = setupProject(a, new Library(lib), ["play"], {
    plan: false,
    adapters: [named("first"), named("second"), named("third", { setup: true })],
  });

  assert.match(
    undone
      .conflicts()
      .map((x) => x.note)
      .join("\n"),
    /third refused/,
  );
  assert.deepEqual(calls, ["first setup", "second setup", "third setup", "second remove", "first remove"]);
  assert.equal(fs.existsSync(record(a)), false, "nothing activated, so no record");

  calls.length = 0;
  setupProject(a, new Library(lib), ["play"], {
    plan: false,
    adapters: [named("first", { remove: true }), named("second", { setup: true })],
  });
  assert.deepEqual(calls, ["first setup", "second setup", "first remove"]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(record(a), "utf8")).harnesses,
    { first: { plugins: ["play"] } },
    "the record holds only what is still activated, so develop remove can take it back",
  );
});

/** A Claude Code stand-in that writes the project file its excludes name, verified or not. */
function excludingAdapter(verified: boolean): HarnessAdapter {
  return {
    harness: "claude-code",
    verified,
    excludes: ["/.claude/settings.local.json"],
    setup: (ctx) => {
      const report = new Report();
      const file = path.join(ctx.project, ".claude", "settings.local.json");
      if (!fs.existsSync(file)) report.add({ kind: "write", path: file, payload: "{}\n", expectedHash: null });
      return { report, owned: { version: 1 } };
    },
    remove: () => new Report(),
  };
}

test("setup in a shell where the adapter is unverified keeps its exclude entries while the record holds its state", () => {
  const { lib, a } = machineWithProjectsSync();
  setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [excludingAdapter(true)] });

  const again = setupProject(a, new Library(lib), [], { plan: false, adapters: [excludingAdapter(false)] });

  assert.deepEqual(again.conflicts(), []);
  assert.match(
    fs.readFileSync(path.join(a, ".git", "info", "exclude"), "utf8"),
    /^\/\.claude\/settings\.local\.json$/m,
  );
  assert.equal(gitIn(a, "status", "--porcelain", "--untracked-files=all"), "?? README.md\n");
});

test("status and setup name a Harness the record holds state for but this shell cannot manage, and the switch it needs", () => {
  const { lib, a } = machineWithProjectsSync();
  setupProject(a, new Library(lib), ["play"], { plan: false, adapters: [excludingAdapter(true)] });

  const status = projectStatus(a, null, [excludingAdapter(false)]);
  const setup = setupProject(a, new Library(lib), [], { plan: false, adapters: [excludingAdapter(false)] });

  const claude = status.harnesses.find((h) => h.harness === "claude-code")!;
  assert.equal(claude.state, "activated, adapter unverified");
  assert.match(claude.note, /SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS=claude-code/);
  const notes = setup.actions.map((x) => x.note ?? "").join("\n");
  assert.match(notes, /claude-code: activated, adapter unverified: .*SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS=claude-code/);
  assert.doesNotMatch(notes, /claude-code: not activated/);
});
