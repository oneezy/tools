// Hermes's form, the library's plugins from GitHub (ADR-0007, tools#153; oneezy/skills#68 said go): sync installs every
// plugin the release lists through `hermes plugins install oneezy/skills/dist/hermes/<id> --no-enable --ref <release
// commit>`, enables it, and only after hermes lists it enabled with the release's package takes the loose links the
// plugin makes redundant. The CLI runs as a process on the pretend machine (test/machine.ts) against the fake GitHub
// and the fake hermes, which keeps Hermes's own files (plugins/<id>, .install-metadata.json, config.yaml); the tests
// assert what a user sees: those files, the links, the fake hermes's calls, printed lines, --json, exit codes, status.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { isLink, lexists } from "../src/fs.js";
import { harnessTable, hermesHomeDir } from "../src/harnesses.js";
import { hermesNamespace } from "../src/hermes.js";
import { fixtureRelease, sha, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  destroy,
  hermesConfig,
  hermesPlugin,
  hermesSource,
  libraryCopy,
  looseLink,
  oldLibraryLink,
  pretendMachine,
  skillFolder,
  snapshot,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  target?: string;
  note?: string;
  failed?: boolean;
  diagnostic?: { command: string[]; exitCode: number | null; stderr: string };
}
interface SyncJson {
  plan: boolean;
  actions: ActionJson[];
}
interface StatusJson {
  ok: boolean;
  harnesses: Record<
    string,
    {
      form: string;
      plugins: {
        installed: Array<{
          id: string;
          marketplace: string;
          version: string | null;
          current: boolean;
          skills: string[] | null;
        }>;
        other: Array<{ id: string; marketplace: string | null }>;
      };
      loose: Array<{ name: string }>;
      duplicates: Array<{ skill: string; in: string[] }>;
      lines: Array<{ ok: boolean; text: string }>;
    }
  >;
}

const REPO = "oneezy/skills";
const IDENTIFIER = (id: string) => `${REPO}/dist/hermes/${id}`;

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

/** A machine with Hermes alone (its home and the fake hermes), so no other harness adds lines. */
function machine(options: Parameters<typeof pretendMachine>[0] = {}, github: FakeGithub = gh): PretendMachine {
  const m = pretendMachine({ github, harnesses: ["hermes"], clis: ["hermes"], ...options });
  machines.push(m);
  return m;
}

const latest = (github: FakeGithub = gh) => github.fixture.releases.find((r) => r.number === 17)!;
const lines = (r: { stdout: string }) => r.stdout.trimEnd().split("\n");
const actions = (r: { json: Record<string, unknown> | null }) => (r.json as unknown as SyncJson).actions;
const brief = (a: ActionJson) => [a.kind, a.path, a.note];
const byPath = (a: (string | undefined)[], b: (string | undefined)[]) => (a[0] ?? "").localeCompare(b[0] ?? "");
/** A hermes call that changes something: install, enable, disable, update, remove (the --help probe and list are not). */
const pluginWrite = (c: string[]) => c.some((w) => ["install", "enable", "disable", "update", "remove"].includes(w));
const installCall = (id: string, commit: string, force = false) => [
  "hermes",
  "plugins",
  "install",
  IDENTIFIER(id),
  "--no-enable",
  "--ref",
  commit,
  ...(force ? ["--force"] : []),
];
const enableCall = (id: string) => ["hermes", "plugins", "enable", id];
/** Hermes's install rows, as hermes wrote them. */
const installs = (m: PretendMachine) =>
  JSON.parse(fs.readFileSync(path.join(m.hermesHome, "plugins", ".install-metadata.json"), "utf8")) as Record<
    string,
    { pinned: boolean; revision: string; source: string }
  >;
const config = (m: PretendMachine) =>
  (YAML.parse(fs.readFileSync(hermesConfig(m), "utf8")) as { plugins: { enabled: string[]; disabled: string[] } })
    .plugins;
const pluginDir = (m: PretendMachine, id: string) => path.join(m.hermesHome, "plugins", id);
const hermesSkills = (m: PretendMachine) => path.join(m.hermesHome, "skills");

/**
 * The machine the old tool left: loose links in ~/.hermes/skills to a library clone for four of the release's skills
 * (one for a skill of each plugin, two for oneezy), and one whose clone is gone. Returns the links by skill.
 */
function migrating(m: PretendMachine): Record<string, string> {
  libraryCopy(m);
  const links: Record<string, string> = {};
  for (const name of ["grilling", "oneezy-merge", "oneezy-status", "play-unslop"])
    links[name] = looseLink(m, "hermes", name);
  const gone = path.join(m.base, "gone");
  links.tdd = looseLink(m, "hermes", "tdd", path.join(gone, "tdd"));
  fs.rmSync(gone, { recursive: true, force: true });
  return links;
}

test("one sync gives Hermes the release's plugins from GitHub at the release commit, enabled, and removes the loose links they make redundant: each skill name once, status green with no duplicate", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // the plugins, as hermes installs them: pinned to the release commit, from dist/hermes/<id>, enabled in config.yaml
  assert.deepEqual(fs.readdirSync(path.join(m.hermesHome, "plugins")).sort(), [
    ".install-metadata.json",
    "matt-pocock",
    "oneezy",
    "play",
  ]);
  assert.deepEqual(installs(m), {
    "matt-pocock": {
      pinned: true,
      revision: r17.commit,
      source: `https://github.com/${REPO}.git#dist/hermes/matt-pocock`,
    },
    oneezy: { pinned: true, revision: r17.commit, source: `https://github.com/${REPO}.git#dist/hermes/oneezy` },
    play: { pinned: true, revision: r17.commit, source: `https://github.com/${REPO}.git#dist/hermes/play` },
  });
  assert.deepEqual(config(m), { enabled: ["matt-pocock", "oneezy", "play"], disabled: [] });
  // the installed copy is the Hermes rendering: no Claude or Codex manifest, SKILL.md without metadata.internal
  assert.ok(!lexists(path.join(pluginDir(m, "oneezy"), ".claude-plugin")));
  assert.equal(
    fs.readFileSync(path.join(pluginDir(m, "oneezy"), "skills", "oneezy-status", "SKILL.md"), "utf8"),
    "---\nname: oneezy-status\ndescription: oneezy-status skill\n---\noneezy-status body (0.43.1)\n",
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir(m, "oneezy"), "plugin.json"), "utf8")).version, "0.43.1");
  // every loose link went; the skills folder is empty
  for (const link of Object.values(links)) assert.equal(lexists(link), false, link);
  assert.deepEqual(fs.readdirSync(hermesSkills(m)), []);
  // through hermes's own commands, in id order, each install before its enable, one listing to verify at the end
  assert.deepEqual(r.calls.filter(pluginWrite), [
    installCall("matt-pocock", r17.commit),
    enableCall("matt-pocock"),
    installCall("oneezy", r17.commit),
    enableCall("oneezy"),
    installCall("play", r17.commit),
    enableCall("play"),
  ]);
  assert.deepEqual(
    r.calls.filter((c) => c.includes("list")),
    [["hermes", "plugins", "list", "--json", "--no-bundled"]],
  );
  // what a user reads
  const out = lines(r);
  const at = (part: string) => {
    const i = out.findIndex((l) => l.includes(part));
    assert.ok(i >= 0, `${part} in\n${r.stdout}`);
    return i;
  };
  assert.ok(
    out.some(
      (l) =>
        l.startsWith("+ install") &&
        l.includes(`Hermes: plugin oneezy -> ${IDENTIFIER("oneezy")}`) &&
        l.includes(`(0.43.1 at ${r17.commit.slice(0, 7)})`),
    ),
    r.stdout,
  );
  assert.ok(
    out.some((l) => l.startsWith("+ install") && l.includes("Hermes: plugin oneezy  (enable)")),
    r.stdout,
  );
  assert.ok(
    out.some(
      (l) => l.startsWith("- remove") && l.includes(links.grilling) && l.includes("(carried by plugin matt-pocock)"),
    ),
    r.stdout,
  );
  assert.ok(
    out.some((l) => l.startsWith("- remove") && l.includes(links.tdd) && l.includes("(carried by plugin matt-pocock)")),
    r.stdout,
  );
  assert.ok(at("plugin play ->") < at(links.grilling), "every install before any link goes");
  assert.ok(
    out.some(
      (l) =>
        l.startsWith(". note") &&
        l.includes("Hermes: plugins") &&
        l.includes("/agent-plugin-matt-pocock-c0b71e82:<skill>") &&
        l.includes("agent-plugin-oneezy-80c7eb0f") &&
        l.includes("agent-plugin-play-aba4cc9b"),
    ),
    r.stdout,
  );
  assert.equal(out.at(-1), "11 changed, 0 already right, 0 left alone");
  // status agrees: the plugin form, each plugin current, nothing listed twice
  const s = await cli(m, ["status", "--json"]);
  assert.equal(s.status, 0, s.stdout);
  const hermes = (s.json as unknown as StatusJson).harnesses.hermes;
  assert.equal(hermes.form, "github-plugins");
  assert.deepEqual(
    hermes.plugins.installed.map((p) => [p.id, p.marketplace, p.version, p.current, p.skills]),
    [
      ["matt-pocock", "oneezy-skills", "1.3.1", true, ["grilling", "tdd"]],
      ["oneezy", "oneezy-skills", "0.43.1", true, ["oneezy-merge", "oneezy-status"]],
      ["play", "oneezy-skills", "0.43.0", true, ["play-unslop"]],
    ],
  );
  assert.deepEqual(hermes.duplicates, []);
  assert.deepEqual(hermes.loose, []);
  assert.ok((s.json as unknown as StatusJson).ok);
  const text = await cli(m, ["status"]);
  assert.ok(
    text.stdout.includes(
      "\nHermes  form: plugins from GitHub\n= matt-pocock@oneezy-skills 1.3.1 (latest 1.3.1)\n= oneezy@oneezy-skills 0.43.1 (latest 0.43.1)\n= play@oneezy-skills 0.43.0 (latest 0.43.0)\n",
    ),
    text.stdout,
  );
});

test("a second sync changes nothing: every plugin is a skip, no hermes command that writes, nothing on disk, and --quiet prints nothing", async () => {
  const m = machine();
  hermesSource(m, latest());
  migrating(m);
  await cli(m, []);
  const before = snapshot(m.home);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r).at(-1), "0 changed, 3 already right, 0 left alone");
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  // steady state asks hermes nothing but its --help probe: the probe reads Hermes's files
  assert.ok(
    r.calls.every((c) => c.includes("--help")),
    JSON.stringify(r.calls),
  );
  const asJson = await cli(m, ["--json"]);
  assert.deepEqual(actions(asJson).map(brief), [
    ["skip", "Hermes: plugin matt-pocock", "installed, 1.3.1"],
    ["skip", "Hermes: plugin oneezy", "installed, 0.43.1"],
    ["skip", "Hermes: plugin play", "installed, 0.43.0"],
  ]);
  const quiet = await cli(m, ["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  assert.deepEqual(snapshot(m.home), before);
});

test("a failed install is a conflict with hermes's stderr and that plugin's loose links stay; the other plugins are installed and their links go", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, ["--json"], { FAKE_HARNESS_FAIL_INSTALL: "oneezy" });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(m.hermesHome, "plugins")).sort(), [
    ".install-metadata.json",
    "matt-pocock",
    "play",
  ]);
  assert.ok(isLink(links["oneezy-merge"]) && isLink(links["oneezy-status"]), "oneezy's links stay");
  for (const name of ["grilling", "tdd", "play-unslop"]) assert.equal(lexists(links[name]), false, name);
  assert.deepEqual(r.calls.filter(pluginWrite), [
    installCall("matt-pocock", r17.commit),
    enableCall("matt-pocock"),
    installCall("oneezy", r17.commit),
    installCall("play", r17.commit),
    enableCall("play"),
  ]);
  const conflict = actions(r).find((a) => a.kind === "conflict");
  assert.ok(conflict, JSON.stringify(actions(r)));
  assert.equal(conflict.path, "Hermes: plugin oneezy");
  assert.ok(conflict.note?.startsWith("hermes could not install it; loose links kept."), conflict.note);
  assert.ok(
    conflict.note?.endsWith(
      `run once by hand: hermes plugins install ${IDENTIFIER("oneezy")} --no-enable --ref ${r17.commit} --force`,
    ),
    conflict.note,
  );
  // the diagnostic names the command as run: the fake's path, then the arguments
  assert.deepEqual(conflict.diagnostic?.command.slice(1), installCall("oneezy", r17.commit).slice(1));
  assert.match(conflict.diagnostic?.stderr ?? "", /fixture install denied: oneezy/);
  assert.ok(
    !actions(r).some((a) => a.kind === "remove" && /oneezy-(merge|status)/.test(a.path)),
    "no removal for oneezy's skills",
  );
  // the next sync, with hermes willing, finishes the job
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(again.calls.filter(pluginWrite), [installCall("oneezy", r17.commit), enableCall("oneezy")]);
  assert.equal(lexists(links["oneezy-merge"]), false);
});

test("a caution verdict from hermes's security scan (no TTY to confirm it) is the same conflict, with the command to run once by hand", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const r = await cli(m, ["--json"], { FAKE_HARNESS_CAUTION: "play" });
  assert.equal(r.status, 1, r.stderr);
  const conflict = actions(r).find((a) => a.kind === "conflict");
  assert.equal(conflict?.path, "Hermes: plugin play");
  assert.ok(
    conflict?.note?.includes(`hermes plugins install ${IDENTIFIER("play")} --no-enable --ref ${r17.commit} --force`),
    conflict?.note,
  );
  assert.match(conflict?.diagnostic?.stderr ?? "", /Aborted/);
  assert.equal(lexists(pluginDir(m, "play")), false);
});

test("a plugin behind a newer release is re-installed at the new commit with --force (a pinned install moves that way), as is one whose NOTICE.md is not the release's though its version is; the current ones are skips", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    hermesSource(m, r17);
    migrating(m);
    const first = await cli(m, []);
    assert.equal(first.status, 0, first.stderr);
    // release-18: oneezy at 0.43.2, play's upstream snapshot moved without a version change (its NOTICE says so)
    const r18 = fixtureRelease({
      number: 18,
      previous: "release-17",
      commit: sha("18"),
      toolVersion: "0.8.0",
      plugins: {
        oneezy: { version: "0.43.2", skills: ["oneezy-merge", "oneezy-status"] },
        "matt-pocock": { version: "1.3.1", skills: ["grilling", "tdd"] },
        play: {
          version: "0.43.0",
          skills: ["play-unslop"],
          files: { "NOTICE.md": "# play\n\nBuilt by skills-sync from oneezy/skills.\n\n- Commit: 18\n" },
        },
      },
    });
    github.addRelease(r18);
    hermesSource(m, r18);
    const r = await cli(m, []);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.calls.filter(pluginWrite), [
      installCall("oneezy", r18.commit, true),
      installCall("play", r18.commit, true),
    ]);
    assert.equal(installs(m).oneezy.revision, r18.commit);
    assert.equal(installs(m).play.revision, r18.commit);
    assert.equal(installs(m)["matt-pocock"].revision, r17.commit);
    assert.deepEqual(
      config(m),
      { enabled: ["matt-pocock", "oneezy", "play"], disabled: [] },
      "a re-install keeps the enablement",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(pluginDir(m, "oneezy"), "plugin.json"), "utf8")).version,
      "0.43.2",
    );
    const out = lines(r);
    assert.ok(
      out.some(
        (l) =>
          l.startsWith("+ install") &&
          l.includes(`Hermes: plugin oneezy -> ${IDENTIFIER("oneezy")}`) &&
          l.includes(`(0.43.1 -> 0.43.2 at ${r18.commit.slice(0, 7)}; version 0.43.1, the release has 0.43.2)`),
      ),
      r.stdout,
    );
    assert.ok(
      out.some(
        (l) =>
          l.startsWith("+ install") &&
          l.includes("Hermes: plugin play ->") &&
          l.includes("NOTICE.md is not release-18's"),
      ),
      r.stdout,
    );
    assert.equal(out.at(-1), "2 changed, 1 already right, 0 left alone");
    const settled = await cli(m, []);
    assert.equal(lines(settled).at(-1), "0 changed, 3 already right, 0 left alone");
  } finally {
    await github.close();
  }
});

test("--plan records every install, enable and removal and runs no hermes command that changes anything: nothing on disk changes, hermes's files included", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const before = snapshot(m.home);
  const r = await cli(m, ["--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(lexists(path.join(m.hermesHome, "plugins")), false);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  assert.equal((r.json as unknown as SyncJson).plan, true);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "install")
      .map((a) => [a.path, a.target ?? null, a.note]),
    [
      ["Hermes: plugin matt-pocock", IDENTIFIER("matt-pocock"), `1.3.1 at ${r17.commit.slice(0, 7)}`],
      ["Hermes: plugin matt-pocock", null, "enable"],
      ["Hermes: plugin oneezy", IDENTIFIER("oneezy"), `0.43.1 at ${r17.commit.slice(0, 7)}`],
      ["Hermes: plugin oneezy", null, "enable"],
      ["Hermes: plugin play", IDENTIFIER("play"), `0.43.0 at ${r17.commit.slice(0, 7)}`],
      ["Hermes: plugin play", null, "enable"],
    ],
  );
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "remove")
      .map((a) => [a.path, a.note])
      .sort(byPath),
    Object.entries(links)
      .map(([skill, link]) => [
        link,
        `carried by plugin ${skill === "play-unslop" ? "play" : skill.startsWith("oneezy") ? "oneezy" : "matt-pocock"}, once it verifies`,
      ])
      .sort(byPath),
  );
  for (const link of Object.values(links)) assert.ok(isLink(link), link);
});

test("what the tool did not make is never touched: a link to somewhere else and a real skill folder with a plugin's skill name are conflicts naming the plugin; status still lists them twice", async () => {
  const m = machine();
  hermesSource(m, latest());
  const mine = path.join(m.base, "mine", "oneezy-status");
  const link = looseLink(m, "hermes", "oneezy-status", mine);
  const folder = skillFolder(m, "hermes", "grilling");
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(isLink(link) && fs.existsSync(path.join(mine, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(folder, "SKILL.md")));
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "conflict")
      .map(brief),
    [
      [
        "conflict",
        folder,
        "a real folder, and plugin matt-pocock also carries grilling; left alone (delete it by hand to keep grilling once)",
      ],
      [
        "conflict",
        link,
        `link points outside the library (${mine}) and plugin oneezy also carries oneezy-status; left alone`,
      ],
    ],
  );
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(status.harnesses.hermes.duplicates, [
    { skill: "grilling", in: ["matt-pocock@oneezy-skills", `folder ${folder}`] },
    { skill: "oneezy-status", in: ["oneezy@oneezy-skills", `loose link -> ${mine}`] },
  ]);
});

test("a plugin folder hermes did not install for this library is left alone with a red line: one without an install row, one from another repository, one hermes has disabled, one that is a link; its loose links stay", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  libraryCopy(m);
  const links = ["grilling", "oneezy-status", "play-unslop"].map((n) => looseLink(m, "hermes", n));
  hermesPlugin(m, "oneezy", { files: r17.plugins.oneezy.files, recorded: false });
  hermesPlugin(m, "matt-pocock", { files: r17.plugins["matt-pocock"].files, activation: "disabled" });
  hermesPlugin(m, "play", {
    files: r17.plugins.play.files,
    source: "https://github.com/someone/else.git#dist/hermes/play",
  });
  const before = snapshot(m.hermesHome);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(snapshot(m.hermesHome), before, "nothing of Hermes's changed");
  for (const link of links) assert.ok(isLink(link), link);
  assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "conflict")
      .map(brief),
    [
      [
        "conflict",
        "Hermes: plugin matt-pocock",
        "installed but disabled (plugins.disabled in config.yaml); left alone, loose links kept",
      ],
      [
        "conflict",
        "Hermes: plugin oneezy",
        `${pluginDir(m, "oneezy")} was not installed through hermes plugins; left alone, loose links kept`,
      ],
      [
        "conflict",
        "Hermes: plugin play",
        `installed from https://github.com/someone/else.git, not ${REPO}; left alone, loose links kept`,
      ],
    ],
  );
  // status: the unrecorded copy and the foreign one are other plugins; the disabled one is red
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(
    status.harnesses.hermes.plugins.other.map((o) => [o.id, o.marketplace]),
    [
      ["oneezy", "hermes"],
      ["play", "someone-else"],
    ],
  );
  assert.ok(
    status.harnesses.hermes.lines.some(
      (l) => !l.ok && l.text === "matt-pocock@oneezy-skills 1.3.1 installed but disabled",
    ),
    JSON.stringify(status.harnesses.hermes.lines),
  );
  // plugins/<id> as a link: hermes would refuse it, so the tool does not ask
  const m2 = machine();
  hermesSource(m2, r17);
  fs.mkdirSync(path.join(m2.hermesHome, "plugins"), { recursive: true });
  fs.mkdirSync(path.join(m2.base, "elsewhere"));
  fs.symlinkSync(path.join(m2.base, "elsewhere"), pluginDir(m2, "oneezy"), "junction");
  const r2 = await cli(m2, ["--json"]);
  assert.equal(r2.status, 1);
  assert.ok(
    actions(r2).some(
      (a) =>
        a.kind === "conflict" &&
        a.path === "Hermes: plugin oneezy" &&
        a.note === `${pluginDir(m2, "oneezy")} is a link, not a plugin hermes installed; left alone, loose links kept`,
    ),
    JSON.stringify(actions(r2)),
  );
  assert.deepEqual(r2.calls.filter(pluginWrite), [
    installCall("matt-pocock", r17.commit),
    enableCall("matt-pocock"),
    installCall("play", r17.commit),
    enableCall("play"),
  ]);
});

test("verification happens through hermes itself: when it lists the plugin as not enabled after the install, the plugin stays and its links stay, with one red line; when its listing fails, the same", async () => {
  // enable that does not take: the fake writes nothing when FAKE_HARNESS_FAIL_ENABLE names the plugin
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, ["--json"], { FAKE_HARNESS_FAIL_ENABLE: "oneezy" });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(isLink(links["oneezy-merge"]) && isLink(links["oneezy-status"]));
  assert.equal(lexists(links.grilling), false);
  assert.ok(
    actions(r).some(
      (a) =>
        a.kind === "conflict" &&
        a.path === "Hermes: plugin oneezy" &&
        a.note === "hermes could not enable it; loose links kept",
    ),
    JSON.stringify(actions(r)),
  );
  // the listing fails: installed, not verified, nothing removed
  const m2 = machine();
  hermesSource(m2, r17);
  const links2 = migrating(m2);
  const r2 = await cli(m2, ["--json"], { FAKE_HARNESS_FAIL_LIST: "hermes" });
  assert.equal(r2.status, 1, r2.stderr);
  for (const link of Object.values(links2)) assert.ok(isLink(link), link);
  assert.equal(fs.readdirSync(hermesSkills(m2)).length, 5, "every link stays");
  assert.deepEqual(
    actions(r2)
      .filter((a) => a.kind === "conflict")
      .map(brief),
    ["matt-pocock", "oneezy", "play"].map((id) => [
      "conflict",
      `Hermes: plugin ${id}`,
      "hermes could not list its plugins; installed but not verified, loose links kept",
    ]),
  );
});

test("without hermes on PATH the form is one note and nothing is installed or removed; without the release (GitHub unreachable) the plugins are not compared and the links stay", async () => {
  const m = machine({ clis: [] });
  const links = migrating(m);
  const before = snapshot(m.home);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual(actions(r).map(brief), [
    ["note", "Hermes: plugins", "no hermes on PATH; nothing installed, loose links kept"],
  ]);
  for (const link of Object.values(links)) assert.ok(isLink(link));

  const offline = machine({ github: null });
  const links2 = migrating(offline);
  const before2 = snapshot(offline.home);
  const r2 = await cli(offline, ["--json"]);
  assert.equal(r2.status, 1, r2.stderr);
  assert.deepEqual(snapshot(offline.home), before2);
  assert.equal(r2.calls.filter(pluginWrite).length, 0);
  assert.ok(
    actions(r2).some(
      (a) => a.kind === "note" && a.note === "Hermes: plugins not compared; the latest release was not read",
    ),
    JSON.stringify(actions(r2)),
  );
  for (const link of Object.values(links2)) assert.ok(isLink(link));
});

test("on a PC with a library the old library-based run no longer links into Hermes's skills folder: the plugins are its form, and a sync leaves the folder empty (Codex, named too, is the machine sync's as well: nothing of the old run's there either)", async () => {
  const m = machine({ harnesses: ["hermes", "codex"], clis: ["hermes"] });
  const r17 = latest();
  hermesSource(m, r17);
  oldLibraryLink(m);
  const r = await cli(m, ["--no-wsl", "--agents", "codex,hermes"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(lexists(hermesSkills(m)), false, "no loose link from the old run, not even the folder");
  assert.equal(lexists(path.join(m.home, ".agents", "skills")), false, "nor for Codex");
  assert.deepEqual(fs.readdirSync(path.join(m.hermesHome, "plugins")).sort(), [
    ".install-metadata.json",
    "matt-pocock",
    "oneezy",
    "play",
  ]);
  assert.deepEqual(
    r.calls.filter((c) => c[0] === "hermes" && pluginWrite(c)).map((c) => c[2]),
    ["install", "enable", "install", "enable", "install", "enable"],
  );
});

test("Hermes's home resolves as Hermes does: HERMES_HOME first, else %LOCALAPPDATA%\\hermes on Windows (~/AppData/Local/hermes without LOCALAPPDATA), ~/.hermes elsewhere, with HERMES_DATA_DIR_SUFFIX on the default", () => {
  const home = path.join("C:", "Users", "justin");
  const local = path.join("D:", "Local");
  assert.equal(hermesHomeDir(home, { LOCALAPPDATA: local }, "win32"), path.join(local, "hermes"));
  assert.equal(hermesHomeDir(home, {}, "win32"), path.join(home, "AppData", "Local", "hermes"));
  assert.equal(
    hermesHomeDir(home, { LOCALAPPDATA: local, HERMES_DATA_DIR_SUFFIX: "-dev" }, "win32"),
    path.join(local, "hermes-dev"),
  );
  assert.equal(
    hermesHomeDir(home, { LOCALAPPDATA: local, HERMES_HOME: path.join("E:", "h") }, "win32"),
    path.join("E:", "h"),
  );
  // path.join writes the host's separator, so the expectations are joined too (this runs on Windows CI as well)
  const posixHome = path.join("/home", "justin");
  assert.equal(hermesHomeDir(posixHome, { LOCALAPPDATA: local }, "linux"), path.join(posixHome, ".hermes"));
  assert.equal(hermesHomeDir(posixHome, { HERMES_DATA_DIR_SUFFIX: "2" }, "darwin"), path.join(posixHome, ".hermes2"));
  assert.equal(
    hermesHomeDir(posixHome, { HERMES_HOME: " /opt/hermes " }, "linux"),
    "/opt/hermes",
    "HERMES_HOME is taken as set, trimmed",
  );
  const row = harnessTable(home, { LOCALAPPDATA: local }, "win32").find((h) => h.id === "hermes")!;
  assert.equal(row.configDir, path.join(local, "hermes"));
  assert.equal(row.userSkills, path.join(local, "hermes", "skills"));
  assert.equal(row.userInstructions, undefined, "no global instructions file, so no block");
  // the namespace Hermes gives a plugin's skills, from its name: agent-plugin-<slug>-<sha256(name)[:8]>
  assert.equal(hermesNamespace("oneezy"), "agent-plugin-oneezy-80c7eb0f");
  assert.equal(hermesNamespace("matt-pocock"), "agent-plugin-matt-pocock-c0b71e82");
  assert.equal(hermesNamespace("play"), "agent-plugin-play-aba4cc9b");
});
