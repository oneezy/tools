// develop build: Development builds of selected Library Plugins, run through the built CLI on a pretend machine. The
// Library is a temp folder with two own Groups; tests assert the generated files, the --json status, the exit code, and
// that the release package folders, the source and every Harness folder stay as they were.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test, vi } from "vite-plus/test";
import { buildDevelopment } from "../src/develop-build.js";
import { Library } from "../src/library.js";
import { makeLink } from "../src/fs.js";
import { cli, destroy, pretendMachine, snapshot, write, type PretendMachine } from "./machine.js";

const machines: PretendMachine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) destroy(m);
});

const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n";

function skill(name: string, body = `${name} body`): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

/** A pretend machine with a Library at <base>/library: Groups oneezy (hello, bye) and play (play-hi). */
function machineWithLibrary() {
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
  write(path.join(lib, "LICENSE"), MIT);
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello"));
  write(path.join(lib, "skills", "oneezy", "hello", "notes.md"), "supporting file\n");
  write(path.join(lib, "skills", "oneezy", "bye", "SKILL.md"), skill("bye"));
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi"));
  const out = path.join(lib, "dist", "development", "plugins");
  const run = (...args: string[]) => cli(m, ["develop", "build", ...args, "--repo", lib], {}, lib);
  return { m, lib, out, run };
}

test("develop build writes the selected Plugins with their normal identities into the development output only", async () => {
  const { m, lib, out, run } = machineWithLibrary();
  const harnesses = [snapshot(m.claudeHome), snapshot(m.codexHome)];
  const source = snapshot(path.join(lib, "skills"));

  const r = await run("oneezy", "--json");

  assert.equal(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "oneezy", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "oneezy");
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "oneezy", "plugin.json"), "utf8")).name, "oneezy");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(out, "oneezy", ".codex-plugin", "plugin.json"), "utf8")).name,
    "oneezy",
  );
  assert.match(fs.readFileSync(path.join(out, "oneezy", "skills", "hello", "SKILL.md"), "utf8"), /^---\nname: hello\n/);
  assert.equal(fs.readFileSync(path.join(out, "oneezy", "skills", "hello", "notes.md"), "utf8"), "supporting file\n");
  // only the Plugin asked for, and nothing in the release package folders or the source
  assert.equal(fs.existsSync(path.join(out, "play")), false);
  assert.equal(fs.existsSync(path.join(lib, "plugins")), false);
  assert.equal(fs.existsSync(path.join(lib, "dist", "hermes")), false);
  assert.deepEqual(snapshot(path.join(lib, "skills")), source);
  assert.deepEqual([snapshot(m.claudeHome), snapshot(m.codexHome)], harnesses);
  const status = r.json as { ok: boolean; plugins: Array<{ id: string; state: string; output: string | null }> };
  assert.equal(status.ok, true);
  assert.deepEqual(
    status.plugins.map((p) => [p.id, p.state, p.output && fs.realpathSync(p.output)]),
    [["oneezy", "built", fs.realpathSync(path.join(out, "oneezy"))]],
  );
});

/** Every file under a folder with its inode and modification time: the same list means nothing was rewritten. */
function stamps(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        out.push(`${path.relative(dir, full)} ${st.ino} ${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out;
}

type Status = { id: string; state: string; errors: string[] };
const states = (r: { json: Record<string, unknown> | null }) =>
  (r.json!.plugins as Status[]).map((p) => [p.id, p.state]);

test("only a changed input rewrites output: an identical rebuild does nothing and an unrelated Plugin is untouched", async () => {
  const { lib, out, run } = machineWithLibrary();
  assert.equal((await run("--json")).status, 0);
  const statusFile = path.join(lib, "dist", "development", "status.json");
  const first = {
    oneezy: stamps(path.join(out, "oneezy")),
    play: stamps(path.join(out, "play")),
    status: stamps(path.dirname(statusFile)),
  };

  const again = await run("--json");
  assert.equal(again.status, 0);
  assert.deepEqual(states(again), [
    ["oneezy", "unchanged"],
    ["play", "unchanged"],
  ]);
  assert.deepEqual(stamps(path.dirname(statusFile)), first.status);

  write(path.join(lib, "skills", "oneezy", "hello", "notes.md"), "supporting file, edited\n");
  const edited = await run("--json");
  assert.equal(edited.status, 0);
  assert.deepEqual(states(edited), [
    ["oneezy", "built"],
    ["play", "unchanged"],
  ]);
  assert.equal(
    fs.readFileSync(path.join(out, "oneezy", "skills", "hello", "notes.md"), "utf8"),
    "supporting file, edited\n",
  );
  assert.deepEqual(stamps(path.join(out, "play")), first.play);
  // inside the rebuilt Plugin, a file whose bytes did not change is the same file: same inode, same timestamp
  const entry = (list: string[], rel: string) => list.find((s) => s.startsWith(rel + " "));
  const bye = path.join("skills", "bye", "SKILL.md");
  assert.equal(entry(stamps(path.join(out, "oneezy")), bye), entry(first.oneezy, bye));

  // a skill added, one removed: the output follows the source's structure
  fs.rmSync(path.join(lib, "skills", "oneezy", "bye"), { recursive: true });
  write(path.join(lib, "skills", "oneezy", "new-one", "SKILL.md"), skill("new-one"));
  assert.deepEqual(states(await run("oneezy", "--json")), [["oneezy", "built"]]);
  assert.deepEqual(fs.readdirSync(path.join(out, "oneezy", "skills")).sort(), ["hello", "new-one"]);
  // no staging folder left behind
  assert.deepEqual(fs.readdirSync(path.join(lib, "dist", "development", ".work")), []);
});

test("a failed first build writes no output and a later failure keeps the last successful output as stale", async () => {
  const { m, lib, out, run } = machineWithLibrary();
  const harnesses = [snapshot(m.claudeHome), snapshot(m.codexHome)];
  const statusFile = path.join(lib, "dist", "development", "status.json");
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), "---\nname: play-hi\n---\nno description\n");

  const first = await run("--json");
  assert.equal(first.status, 1);
  assert.deepEqual(states(first), [
    ["oneezy", "built"],
    ["play", "failed"],
  ]);
  const play = (first.json!.plugins as Status[]).find((p) => p.id === "play")!;
  assert.deepEqual(play.errors, ["skills/play/play-hi/SKILL.md: description: missing"]);
  assert.equal(fs.existsSync(path.join(out, "play")), false);
  assert.deepEqual(fs.readdirSync(path.join(lib, "dist", "development", ".work")), []);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).plugins.play.state, "failed");

  // later failure: the complete last output stays, byte for byte, and is reported stale
  const built = snapshot(path.join(out, "oneezy"));
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), "---\nname: [unclosed\n---\nbroken\n");
  const text = await run();
  assert.equal(text.status, 1);
  assert.match(
    text.stdout,
    /^stale\s+oneezy\s+dist\/development\/plugins\/oneezy\s+\(the last successful output is kept\)$/m,
  );
  assert.match(text.stdout, /^ {2}! skills\/oneezy\/hello\/SKILL\.md: frontmatter is not YAML/m);
  assert.match(text.stdout, /^failed\s+play\s+no output\s+\(nothing written\)$/m);
  assert.match(text.stdout, /develop build: 0 built, 0 unchanged, 1 stale, 1 failed$/m);
  assert.deepEqual(snapshot(path.join(out, "oneezy")), built);
  assert.equal(JSON.parse(fs.readFileSync(statusFile, "utf8")).plugins.oneezy.state, "stale");

  // recovery publishes complete output again
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello", "fixed"));
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi"));
  const fixed = await run("--json");
  assert.equal(fixed.status, 0);
  assert.deepEqual(states(fixed), [
    ["oneezy", "built"],
    ["play", "built"],
  ]);
  assert.match(fs.readFileSync(path.join(out, "oneezy", "skills", "hello", "SKILL.md"), "utf8"), /fixed/);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.deepEqual([status.plugins.oneezy.state, status.plugins.play.state], ["ok", "ok"]);
  assert.deepEqual([snapshot(m.claudeHome), snapshot(m.codexHome)], harnesses);
});

test("a Plugin the release build cannot package fails by name, and an unknown id is refused without output", async () => {
  const { lib, out, run } = machineWithLibrary();
  const file = path.join(lib, "skills-sync.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.sources.up = { repo: "https://github.com/up/skills", ref: "main", root: "skills", skills: ["a"] };
  config.plugins.up = { displayName: "Up", source: "up" };
  write(file, JSON.stringify(config, null, 2) + "\n");

  const r = await run("up", "nope", "--json");
  assert.equal(r.status, 1);
  assert.deepEqual(states(r), [
    ["up", "failed"],
    ["nope", "failed"],
  ]);
  const [up, nope] = r.json!.plugins as Status[];
  assert.match(up.errors.join("\n"), /no snapshot under upstream\/up; run refresh first/);
  assert.deepEqual(nope.errors, ["nope is not a plugin in skills-sync.json"]);
  assert.equal(fs.existsSync(out), false);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(path.join(lib, "dist", "development", "status.json"), "utf8")).plugins),
    ["up"],
  );
});

test("a build that died mid-swap is recovered, and a build running elsewhere or a link on the way refuses the run", async () => {
  const { m, lib, out, run } = machineWithLibrary();
  assert.equal((await run("oneezy")).status, 0);
  const work = path.join(lib, "dist", "development", ".work");
  const built = snapshot(path.join(out, "oneezy"));
  // the previous output renamed aside, the new one never renamed in: the next run puts it back and finds it current
  fs.renameSync(path.join(out, "oneezy"), path.join(work, "oneezy.4242.0badf00d.old"));
  write(path.join(work, "oneezy.4242.deadbeef.new", "plugin.json"), "{}");
  const recovered = await run("oneezy", "--json");
  assert.deepEqual(states(recovered), [["oneezy", "unchanged"]]);
  assert.deepEqual(snapshot(path.join(out, "oneezy")), built);
  assert.deepEqual(fs.readdirSync(work), []);

  // another build holds the lock (this test's own process is alive): refused, nothing touched
  write(path.join(work, "lock"), `${process.pid}\n`);
  write(path.join(lib, "skills", "oneezy", "hello", "SKILL.md"), skill("hello", "changed"));
  const busy = await run("--json");
  assert.equal(busy.status, 1);
  assert.match(String(busy.json!.refused), /another development build is writing dist\/development/);
  assert.deepEqual(snapshot(path.join(out, "oneezy")), built);
  // a lock left by a process that is gone is taken over
  write(path.join(work, "lock"), "999999999\n");
  assert.deepEqual(states(await run("oneezy", "--json")), [["oneezy", "built"]]);

  // dist/development reached through a link: never written through
  const elsewhere = path.join(m.base, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.rmSync(path.join(lib, "dist"), { recursive: true });
  makeLink(elsewhere, path.join(lib, "dist"));
  const linked = await run("--json");
  assert.equal(linked.status, 1);
  assert.match(String(linked.json!.refused), /^dist is a link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("--plan reports what would be built and writes nothing", async () => {
  const { lib, run } = machineWithLibrary();
  const r = await run("--plan");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^would build\s+oneezy\s+/m);
  assert.match(r.stdout, /^plan: develop build: 2 to build, 0 unchanged, 0 stale, 0 failed$/m);
  assert.equal(fs.existsSync(path.join(lib, "dist")), false);
});

test("a build waits out a moment when Windows refuses to rename the output (EPERM, EACCES, EBUSY)", () => {
  const { lib, out } = machineWithLibrary();
  buildDevelopment(new Library(lib), { plugins: ["play"], plan: false });
  write(path.join(lib, "skills", "play", "play-hi", "SKILL.md"), skill("play-hi", "edited"));
  const rename = fs.renameSync;
  const refused: string[] = [];
  // a scanner holding the old output open, then the new one: each rename is refused twice before it goes through
  const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    const key = `${String(from)} -> ${String(to)}`;
    if (refused.filter((r) => r.endsWith(key)).length < 2) {
      const code = ["EPERM", "EACCES", "EBUSY"][refused.length % 3];
      refused.push(`${code} ${key}`);
      throw Object.assign(new Error(`${code}: rename refused`), { code });
    }
    return rename(from, to);
  });
  try {
    const r = buildDevelopment(new Library(lib), { plugins: ["play"], plan: false });
    assert.equal(r.plugins[0].state, "built", r.plugins[0].errors.join("; "));
  } finally {
    spy.mockRestore();
  }
  const target = (r: string) => r.slice(r.indexOf(" -> ") + 4);
  assert.ok(
    refused.some((r) => target(r) === path.join(out, "play")),
    "the new output into place was refused",
  );
  assert.ok(
    refused.some((r) => r.includes(`${path.join(out, "play")} -> `)),
    "the old output aside was refused",
  );
  assert.ok(
    refused.some((r) => target(r).endsWith("status.json")),
    "the status file was refused",
  );
  assert.match(fs.readFileSync(path.join(out, "play", "skills", "play-hi", "SKILL.md"), "utf8"), /edited/);
});
