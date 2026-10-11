// A machine command keeps nothing of its own on the machine (ADR-0012): no library clone, no ~/.skills-sync, no
// skills-sync.local.json, nothing remembered between runs. What an older version left there is reported, never read or
// touched. The settings a machine takes come from the release's skills-sync.json on GitHub (which harnesses are served,
// which plugins each gets); machine facts (the harnesses, the WSL distros) are detected on every run. An older flag on
// a machine command is accepted, does nothing, and is named once on stderr. The CLI runs as a process on the pretend
// machine (test/machine.ts) against the fake GitHub and the fake wsl.exe; the tests assert what a user sees.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { catalogOf, pluginsFor, serves } from "../src/desired.js";
import { lexists, linkTarget } from "../src/fs.js";
import { parseConfig, parseRelease } from "../src/release.js";
import { shippedSchema, validate } from "../src/schema.js";
import { VERSION } from "../src/version.js";
import { fixtureConfig, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  destroy,
  globalFile,
  names,
  oldLibraryLink,
  oldLocalFile,
  pretendMachine,
  snapshot,
  write,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  target?: string;
  note?: string;
}
interface SyncJson {
  plan: boolean;
  actions: ActionJson[];
  release: { tag: string; config: unknown } | null;
  cloud: boolean;
  oldLibrary: { path: string; kind: string; target?: string } | null;
  oldLocalFile: string | null;
  wsl: Array<{ distro: string; ok: boolean; noNode: boolean; output: string }>;
}
interface StatusJson {
  harnesses: Record<string, { lines: Array<{ ok: boolean; text: string }> }>;
  lines: Array<{ ok: boolean; text: string }>;
  oldLibrary: { path: string; kind: string; target?: string } | null;
  oldLocalFile: string | null;
}

const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
const GLOBALS = [".claude/CLAUDE.md", ".codex/AGENTS.md"];
/** The one line a machine command prints for the older flags: each as given, once, in order. */
const ignored = (...flags: string[]) =>
  `ignored: ${flags.join(", ")} (settings come from the release's skills-sync.json; machine facts are detected on every run)\n`;
const R17 = "1717171717171717171717171717171717171717";

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
  // a test may have narrowed the release's config; every test starts from the fixture's own
  gh.fixture.contents[R17]["skills-sync.json"] = fixtureConfig("oneezy/skills", "0.43.1");
});

function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, ...options });
  machines.push(m);
  return m;
}

const read = (file: string) => fs.readFileSync(file, "utf8");
/** The paths `after` has that `before` had not; fails when any entry of `before` changed or went. */
function added(before: string[], after: string[]): string[] {
  assert.ok(
    before.every((e) => after.includes(e)),
    `changed or lost: ${before.filter((e) => !after.includes(e)).join(", ")}`,
  );
  return names(after.filter((e) => !before.includes(e)));
}
/** A plugin write through a harness CLI: install, add, uninstall, remove, or a marketplace change. */
const pluginWrite = (c: string[]) =>
  c.some((w) => ["install", "add", "uninstall", "remove", "update", "upgrade"].includes(w));
const notes = (r: { stdout: string }) => r.stdout.split("\n").filter((l) => l.startsWith(". note"));

test("no run creates or changes ~/.skills-sync or a local file: sync, status, unlink and their --plan leave the home as it was but for the global files", async () => {
  const m = machine();
  const before = snapshot(m.home);
  const first = await cli(m, []);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(added(before, snapshot(m.home)), GLOBALS);
  const after = snapshot(m.home);
  for (const args of [["status"], ["status", "--json"], ["--plan"], ["--json"], [], ["unlink", "--plan"], ["unlink"]]) {
    const r = await cli(m, args);
    assert.ok(r.status === 0 || args[0] === "status", `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr, "", args.join(" "));
  }
  // unlink took the blocks away (the files held nothing else); nothing else of the home moved
  assert.deepEqual(
    snapshot(m.home),
    after.filter((e) => !GLOBALS.some((g) => e.startsWith(g))),
  );
  assert.equal(lexists(path.join(m.home, ".skills-sync")), false);
  assert.equal(
    fs.readdirSync(m.home, { recursive: true }).some((f) => String(f).endsWith("skills-sync.local.json")),
    false,
  );
});

test("an existing ~/.skills-sync link and its local file are reported by sync and status as leftovers to delete by hand, and never touched; a real clone folder the same", async () => {
  const m = machine();
  const link = oldLibraryLink(m);
  const target = linkTarget(link)!;
  const local = oldLocalFile(m, { dev: path.join(m.base, "dev"), projects: ["app"] });
  const libraryBefore = snapshot(target);
  const homeBefore = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const noted = notes(r);
  assert.ok(
    noted.some(
      (l) =>
        l.includes(`${link} -> ${target}`) &&
        l.includes("(the old library link; nothing reads it any more, delete it by hand)"),
    ),
    r.stdout,
  );
  assert.ok(
    noted.some((l) => l.includes(local) && l.includes("the old tool's answers file; nothing reads it any more")),
    r.stdout,
  );
  // the library and its file as they were; the home gained only the two global files (no link is ever followed into it)
  assert.deepEqual(snapshot(target), libraryBefore);
  assert.deepEqual(added(homeBefore, snapshot(m.home)), GLOBALS);
  assert.equal(linkTarget(link), target);
  const j = (await cli(m, ["--json"])).json as unknown as SyncJson;
  assert.deepEqual(j.oldLibrary, { path: link, kind: "link", target });
  assert.equal(j.oldLocalFile, local);
  const s = await cli(m, ["status", "--json"]);
  const status = s.json as unknown as StatusJson;
  assert.deepEqual(status.oldLibrary, { path: link, kind: "link", target });
  assert.equal(status.oldLocalFile, local);
  const text = await cli(m, ["status"]);
  assert.ok(
    text.stdout.includes(
      `. ${link} (link -> ${target}) is the old library clone; nothing reads it any more, delete it by hand\n`,
    ),
    text.stdout,
  );
  assert.ok(
    text.stdout.includes(`. ${local} is the old tool's answers file; nothing reads it any more, delete it by hand\n`),
    text.stdout,
  );
  // --quiet: the notes are neither changes nor problems, so a session start prints nothing about them
  const quiet = await cli(m, ["--quiet"]);
  assert.equal(quiet.stdout + quiet.stderr, "");
  assert.deepEqual(snapshot(target), libraryBefore);

  // the clone itself at ~/.skills-sync, not a link to one
  const m2 = machine();
  const clone = path.join(m2.home, ".skills-sync");
  write(path.join(clone, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }) + "\n");
  write(path.join(clone, "skills", "oneezy-status", "SKILL.md"), "---\nname: oneezy-status\ndescription: s\n---\n");
  const cloneBefore = snapshot(clone);
  const r2 = await cli(m2, ["--json"]);
  assert.equal(r2.status, 0, r2.stderr);
  const j2 = r2.json as unknown as SyncJson;
  assert.deepEqual(j2.oldLibrary, { path: clone, kind: "folder" });
  assert.equal(j2.oldLocalFile, null);
  assert.ok(
    j2.actions.some((a) => a.kind === "note" && a.path === clone && a.note?.startsWith("the old library clone;")),
    JSON.stringify(j2.actions),
  );
  assert.deepEqual(snapshot(clone), cloneBefore);
});

for (const [name, line] of [
  ["the release-notes line", ["--repo", "<library>", "--no-pull", "-y", "--global", "--no-projects", "--no-wsl"]],
  ["the links line", ["--links"]],
  ["the plugins line", ["--plugins"]],
  [
    "the handoff line",
    [
      "--agents",
      "codex,claude-code",
      "--plugins",
      "--global",
      "--no-projects",
      "--no-wsl",
      "--no-pull",
      "--no-remember",
    ],
  ],
] as const)
  test(`outside the cloud, ${name} runs the new sync against the release: one ignored line on stderr, exit 0, the blocks written, no link made, the library untouched, no local file`, async () => {
    const m = machine();
    const library = linkTarget(oldLibraryLink(m))!;
    const args = line.map((a) => (a === "<library>" ? library : a));
    const flags = [...new Set(args.filter((a) => a.startsWith("-")))];
    const libraryBefore = snapshot(library);
    const homeBefore = snapshot(m.home);
    const r = await cli(m, args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, ignored(...flags));
    assert.deepEqual(added(homeBefore, snapshot(m.home)), GLOBALS);
    assert.deepEqual(snapshot(library), libraryBefore);
    assert.equal(fs.existsSync(path.join(library, "skills-sync.local.json")), false);
    for (const dir of [path.join(m.claudeHome, "skills"), path.join(m.home, ".agents", "skills")])
      assert.equal(fs.existsSync(dir), false, dir);
    assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
    assert.ok(
      r.requests.some((q) => q.path === "/repos/oneezy/skills/releases/latest"),
      "the release was read",
    );
    assert.ok(r.stdout.includes("form:"), r.stdout);
    // the warning is stderr's alone: --json stays parseable, --quiet stays quiet on stdout
    const j = await cli(m, [...args, "--json"]);
    assert.equal(j.status, 0, j.stderr);
    assert.equal(j.stderr, ignored(...flags));
    assert.equal((j.json as unknown as SyncJson).plan, false);
    const q = await cli(m, [...args, "--quiet"]);
    assert.equal(q.stdout, "");
    assert.equal(q.stderr, ignored(...flags));
  });

test("the ignored line names every older flag once, in the order given, and a library command never prints it", async () => {
  const m = machine();
  const r = await cli(m, [
    "status",
    "--json",
    "-y",
    "--agents",
    "codex",
    "--no-wsl",
    "-y",
    "--watch",
    "--ask",
    "--no-remember",
  ]);
  assert.equal(r.stderr, ignored("-y", "--agents", "--no-wsl", "--watch", "--ask", "--no-remember"));
  assert.ok(r.json, r.stdout);
  // --plan, --json, --quiet and --library are the machine commands' own
  const own = await cli(m, ["--plan", "--json", "--quiet", "--library", "oneezy/skills"]);
  assert.equal(own.stderr, "");
  // a library command keeps its flags and says nothing about them (a bad checkout is its own error)
  const library = await cli(m, ["check", "--repo", path.join(m.base, "nowhere"), "--json"]);
  assert.equal(library.status, 1);
  assert.ok(!library.stderr.includes("ignored:"), library.stderr);
  assert.match(library.stderr, /no skills library found/);
  assert.equal(lexists(path.join(m.home, ".skills-sync")), false, "no clone was offered or made");
});

test("the settings come from the release's skills-sync.json at its commit: the catalog name, the harnesses served, the plugins each gets; a harness the config leaves out gets one note and nothing else", async () => {
  // the fixture's config is the real file's shape and validates against the shipped schema, machines key included
  const narrowed = fixtureConfig("oneezy/skills", "0.43.1", {
    machines: { harnesses: ["claude-code"], plugins: { codex: ["oneezy"], "*": ["oneezy", "play"] } },
  });
  for (const text of [fixtureConfig(), narrowed])
    assert.deepEqual(validate(shippedSchema("skills-sync"), JSON.parse(text)), []);
  const m = machine();
  const plain = (await cli(m, ["--plan", "--json"])).json as unknown as SyncJson;
  assert.deepEqual(plain.release?.config, { catalog: "oneezy-skills", harnesses: null, plugins: {} });
  assert.ok(
    plain.actions.some((a) => a.kind === "write" && a.path.endsWith("AGENTS.md")),
    "Codex served by default",
  );

  gh.fixture.contents[R17]["skills-sync.json"] = narrowed;
  const before = snapshot(m.home);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  const s = r.json as unknown as SyncJson;
  assert.deepEqual(s.release?.config, {
    catalog: "oneezy-skills",
    harnesses: ["claude-code"],
    plugins: { codex: ["oneezy"], "*": ["oneezy", "play"] },
  });
  assert.ok(r.requests.some((q) => q.path === `/repos/oneezy/skills/contents/skills-sync.json?ref=${R17}`));
  assert.deepEqual(added(before, snapshot(m.home)), [".claude/CLAUDE.md"]);
  assert.deepEqual(
    s.actions.filter((a) => a.path === "Codex").map((a) => [a.kind, a.note]),
    [["note", "not served: the release's skills-sync.json names harnesses claude-code; nothing changed here"]],
  );
  assert.ok(!s.actions.some((a) => a.path.endsWith("AGENTS.md")));
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(Object.keys(status.harnesses), ["claude-code"]);
  assert.ok(
    status.lines.some(
      (l) => l.ok && l.text === "Codex: not served; the release's skills-sync.json names harnesses claude-code",
    ),
    JSON.stringify(status.lines),
  );

  // what a form sees, through the one function: the release's plugins narrowed per harness, sorted by id
  const r17 = gh.fixture.releases.find((x) => x.number === 17)!;
  const release = parseRelease("oneezy/skills", r17.tag, r17.commit, Buffer.from(JSON.stringify(r17.json)));
  const ids = (list: Array<{ id: string }>) => list.map((p) => p.id);
  assert.deepEqual(ids(pluginsFor(release, "codex")), ["matt-pocock", "oneezy", "play"], "no config: every plugin");
  assert.equal(catalogOf(release), "oneezy-skills");
  release.config = parseConfig(narrowed);
  assert.deepEqual(ids(pluginsFor(release, "codex")), ["oneezy"]);
  assert.deepEqual(ids(pluginsFor(release, "claude-code")), ["oneezy", "play"], "the * list for a harness not named");
  assert.deepEqual(ids(pluginsFor(release, "hermes")), ["oneezy", "play"]);
  assert.equal(serves(release, "codex"), false);
  assert.equal(serves(release, "claude-code"), true);
  release.config = parseConfig(
    fixtureConfig("other/lib", "1.0.0", { machines: { plugins: { "*": ["play", "nope"] } } }),
  );
  assert.equal(catalogOf(release), "other-lib");
  assert.deepEqual(ids(pluginsFor(release, "codex")), ["play"], "an id the release does not ship is nothing");
  // read leniently: a key of the wrong shape counts as absent, a config that is not an object is none
  assert.deepEqual(parseConfig(JSON.stringify({ machines: { harnesses: "codex", plugins: ["x"] } })), {
    catalog: null,
    harnesses: null,
    plugins: {},
  });
  assert.equal(parseConfig("[]"), null);
  assert.equal(parseConfig("not json"), null);
});

test("a release whose commit has no skills-sync.json, or one that is not JSON, still syncs: config null, every harness served, every plugin", async () => {
  const m = machine();
  delete gh.fixture.contents[R17]["skills-sync.json"];
  const none = await cli(m, ["--plan", "--json"]);
  assert.equal(none.status, 0, none.stderr);
  const s = none.json as unknown as SyncJson;
  assert.equal(s.release?.tag, "release-17");
  assert.equal(s.release?.config, null);
  assert.deepEqual(
    s.actions.filter((a) => a.kind === "write").map((a) => path.basename(a.path)),
    ["CLAUDE.md", "AGENTS.md"],
  );
  gh.fixture.contents[R17]["skills-sync.json"] = "not json";
  const bad = await cli(m, ["--plan", "--json"]);
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal((bad.json as unknown as SyncJson).release?.config, null);
});

test("a harness that disappears is absent from the next run's report: nothing is remembered about it", async () => {
  const m = machine();
  const first = await cli(m, ["--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(
    (first.json as unknown as SyncJson).actions.filter((a) => a.kind !== "note").map((a) => path.basename(a.path)),
    ["CLAUDE.md", "AGENTS.md"],
  );
  fs.rmSync(m.codexHome, { recursive: true, force: true });
  const next = await cli(m, ["--json"]);
  assert.equal(next.status, 0, next.stderr);
  const s = next.json as unknown as SyncJson;
  assert.ok(
    !s.actions.some((a) => a.path.includes("Codex") || a.path.endsWith("AGENTS.md")),
    JSON.stringify(s.actions),
  );
  assert.deepEqual(
    s.actions.filter((a) => a.kind !== "note").map((a) => [a.kind, path.basename(a.path)]),
    [["skip", "CLAUDE.md"]],
  );
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(Object.keys(status.harnesses), ["claude-code"]);
  assert.equal(fs.existsSync(m.codexHome), false, "nothing recreated the folder");
});

test("on Windows the machine sync runs itself inside every WSL distro through npx with this run's flags: one note per distro, a distro without Node is a note too, a failure there is red; never from the cloud, never for status or unlink", async () => {
  const m = machine({ wsl: ["Ubuntu", "Debian"], env: { FAKE_WSL_NO_NODE: "Debian" } });
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  const command = `npx --yes @oneezy/skills-sync@${VERSION} sync`;
  assert.deepEqual(r.wsl, [
    ["Ubuntu", command],
    ["Debian", command],
  ]);
  assert.ok(
    notes(r).some((l) => l.includes("WSL Ubuntu") && l.includes("(synced: 0 changed, 2 already right, 0 left alone)")),
    r.stdout,
  );
  assert.ok(
    notes(r).some(
      (l) => l.includes("WSL Debian") && l.includes("(no npx in the distro; install Node there to sync it)"),
    ),
    r.stdout,
  );
  // the flags travel: --plan plans there too, --json and --quiet are passed along, and --json carries each run
  const plan = await cli(m, ["--plan", "--json", "--quiet"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(
    plan.wsl.map((w) => w[1]),
    [`${command} --plan --json --quiet`, `${command} --plan --json --quiet`],
  );
  const s = plan.json as unknown as SyncJson;
  assert.deepEqual(
    s.wsl.map((w) => [w.distro, w.ok, w.noNode]),
    [
      ["Ubuntu", true, false],
      ["Debian", false, true],
    ],
  );
  assert.equal(s.wsl[0].output, JSON.stringify({ plan: true, actions: [] }));
  // SKILLS_SYNC_WSL_BIN names another command inside the distro (a development build)
  const own = await cli(m, ["--quiet"], {
    SKILLS_SYNC_WSL_BIN: "node /mnt/v/dev/tools/packages/skills-sync/dist/src/cli.js",
  });
  assert.deepEqual(own.wsl[0], ["Ubuntu", "node /mnt/v/dev/tools/packages/skills-sync/dist/src/cli.js sync --quiet"]);
  // a sync that fails in a distro is one red line and exit 1; the machine's own sync still ran
  const failed = await cli(m, [], { FAKE_WSL_FAIL: "Ubuntu" });
  assert.equal(failed.status, 1, failed.stderr);
  assert.ok(
    failed.stdout
      .split("\n")
      .some(
        (l) =>
          l.startsWith("!") && l.includes("WSL Ubuntu") && l.includes("sync failed there: fixture failure in Ubuntu"),
      ),
    failed.stdout,
  );
  assert.ok(failed.stdout.includes("CLAUDE.md"), failed.stdout);
  // not from the cloud (a Linux container), not for status, not for unlink
  for (const [args, env] of [
    [["--quiet"], CLOUD],
    [["status"], {}],
    [["unlink"], {}],
  ] as const) {
    const other = await cli(m, [...args], env);
    assert.deepEqual(other.wsl, [], args.join(" "));
  }
  // a machine without WSL (every non-Windows host, a PC without distros) fans out to nothing
  const none = machine();
  const plain = await cli(none, []);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual(plain.wsl, []);
  assert.ok(!plain.stdout.includes("WSL"), plain.stdout);
});

test("in the cloud, the setup line's old flags are named once and the blocks are written; a library on the machine is neither found nor used", async () => {
  const m = machine();
  const library = linkTarget(oldLibraryLink(m))!;
  const before = snapshot(library);
  const r = await cli(m, ["-y", "--agents", "claude-code", "--global", "--no-projects", "--no-wsl", "--quiet"], CLOUD);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, ignored("-y", "--agents", "--global", "--no-projects", "--no-wsl"));
  for (const h of ["claude-code", "codex"] as const)
    assert.ok(read(globalFile(m, h)).includes("skills-sync:skills:start"));
  assert.deepEqual(snapshot(library), before);
  assert.equal(r.requests.length, 0, "the cloud reads no release");
});
