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
import { hermes as hermesForm, libraryPath } from "../src/forms/hermes.js";
import { isLink, lexists } from "../src/fs.js";
import { harnessTable, hermesHomeDir } from "../src/harnesses.js";
import { hermesNamespace } from "../src/hermes.js";
import { alreadyExists, scanVerdict } from "../src/install.js";
import { probe } from "../src/machine.js";
import { parseRelease } from "../src/release.js";
import {
  fixtureConfig,
  fixtureRelease,
  sha,
  startFakeGithub,
  type FakeGithub,
} from "./fixtures/fake-github/fake-github.mjs";
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
/**
 * An install sync runs: plain first, fresh install or re-install, so Hermes's security scan has its say; then, once, with
 * --force for a library plugin whose scan said caution (tools#193), or over this tool's own install when Hermes said it
 * already exists (how a pinned install moves).
 */
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
  // GitHub was asked once, before the first install, whether the release commit carries the rendering at all
  assert.deepEqual(
    r.requests.filter((q) => q.path.includes("/contents/dist/")).map((q) => q.path),
    [`/repos/${REPO}/contents/dist/hermes?ref=${r17.commit}`],
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
  // and GitHub nothing beyond the release (and its skills-sync.json): the rendering question is for a run that installs
  assert.deepEqual(
    r.requests.filter((q) => q.path.includes("/contents/dist/")).map((q) => q.path),
    [],
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
  // a git with core.autocrlf=true (Git for Windows' default) hands the clone over with CRLF: still the release's NOTICE
  for (const id of ["matt-pocock", "oneezy", "play"]) {
    const file = path.join(pluginDir(m, id), "NOTICE.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  }
  const crlf = await cli(m, []);
  assert.equal(crlf.status, 0, crlf.stderr);
  assert.equal(lines(crlf).at(-1), "0 changed, 3 already right, 0 left alone");
  assert.equal(crlf.calls.filter(pluginWrite).length, 0, JSON.stringify(crlf.calls));
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
  assert.equal(conflict.note, "hermes could not install it; loose links kept");
  // the diagnostic names the command as run: the fake's path, then the arguments
  assert.deepEqual(conflict.diagnostic?.command.slice(1), installCall("oneezy", r17.commit).slice(1));
  assert.match(conflict.diagnostic?.stderr ?? "", /fixture install denied: oneezy/);
  assert.ok(
    !actions(r).some((a) => a.kind === "remove" && /oneezy-(merge|status)/.test(a.path)),
    "no removal for oneezy's skills",
  );
  // the failed install is the conflict alone: no install action counted as changed, no namespace for it
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "install" && a.target)
      .map((a) => a.path),
    ["Hermes: plugin matt-pocock", "Hermes: plugin play"],
  );
  const namespaces = actions(r).find((a) => a.kind === "note" && a.note?.includes("namespaces:"));
  assert.ok(namespaces && !namespaces.note?.includes("agent-plugin-oneezy"), namespaces?.note);
  // the next sync, with hermes willing, finishes the job
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.deepEqual(again.calls.filter(pluginWrite), [installCall("oneezy", r17.commit), enableCall("oneezy")]);
  assert.equal(lexists(links["oneezy-merge"]), false);
});

test("a caution verdict from hermes's security scan does not stop a library plugin: the plain install is retried once with --force for the same identifier and commit, the plugin is installed, enabled and verified, its links go, and one note per plugin keeps the verdict and Hermes's findings in sight (tools#193)", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, [], { FAKE_HARNESS_CAUTION: "oneezy,play" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(config(m), { enabled: ["matt-pocock", "oneezy", "play"], disabled: [] });
  assert.equal(installs(m).play.revision, r17.commit);
  for (const link of Object.values(links)) assert.equal(lexists(link), false, link);
  // matt-pocock's scan is clean: one plain install; oneezy and play: the plain one Hermes aborts, then --force once
  assert.deepEqual(r.calls.filter(pluginWrite), [
    installCall("matt-pocock", r17.commit),
    enableCall("matt-pocock"),
    installCall("oneezy", r17.commit),
    installCall("oneezy", r17.commit, true),
    enableCall("oneezy"),
    installCall("play", r17.commit),
    installCall("play", r17.commit, true),
    enableCall("play"),
  ]);
  // one line per plugin whose scan was not clean, a note, not a red line; none for matt-pocock, whose scan was
  const out = lines(r);
  assert.deepEqual(
    out.filter((l) => l.includes("Hermes scan")),
    [
      ". note         Hermes: plugin oneezy  (Hermes scan caution, installed with --force (library plugin))",
      ". note         Hermes: plugin play  (Hermes scan caution, installed with --force (library plugin))",
    ],
  );
  assert.ok(!out.some((l) => l.startsWith("!")), r.stdout);
  // --json: the note carries what Hermes printed for the plain install, its findings with it
  const json = await (async () => {
    const j = machine();
    hermesSource(j, r17);
    // COLUMNS=80 in the user's environment: every hermes command still gets COLUMNS=1000, so Rich does not wrap
    return cli(j, ["--json"], { FAKE_HARNESS_CAUTION: "play", COLUMNS: "80" });
  })();
  const evidence = actions(json).find((a) => a.kind === "note" && a.note?.startsWith("Hermes scan"));
  assert.equal(evidence?.path, "Hermes: plugin play");
  assert.deepEqual(evidence?.diagnostic?.command.slice(1), installCall("play", r17.commit).slice(1));
  const said = (evidence?.diagnostic as { stdout?: string } | undefined)?.stdout ?? "";
  assert.match(said, /Scan: play \(oneezy\/skills\/dist\/hermes\/play\/community\) {2}Verdict: CAUTION/);
  assert.match(said, /HIGH {5}injection/);
  // one line, though longer than 80 columns: Hermes ran with COLUMNS=1000
  assert.ok(
    said
      .split("\n")
      .includes("Blocked: Security scan blocked plugin install: Requires confirmation (caution verdict, 1 findings)"),
    said,
  );
  // --quiet keeps it: the run changed things, and the note is loud besides
  const quiet = machine();
  hermesSource(quiet, r17);
  const q = await cli(quiet, ["--quiet"], { FAKE_HARNESS_CAUTION: "play" });
  assert.equal(q.status, 0, q.stderr + q.stdout);
  assert.ok(
    lines(q).includes(
      ". note         Hermes: plugin play  (Hermes scan caution, installed with --force (library plugin))",
    ),
    q.stdout,
  );
  // status reads Hermes's own files, which record no scan verdict: it says nothing of the scan, and is green
  const status = await cli(m, ["status", "--json"]);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.ok(!status.stdout.includes("scan"), status.stdout);
  // the next sync has nothing to install, so hermes scans nothing and nothing is said
  const again = await cli(m, [], { FAKE_HARNESS_CAUTION: "oneezy,play" });
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(again.calls.filter(pluginWrite).length, 0, JSON.stringify(again.calls));
  assert.ok(!again.stdout.includes("Hermes scan"), again.stdout);
});

test("the scan verdict is read from what Hermes prints: the report's Verdict line and the refusal's '<verdict> verdict', wrapped at 80 columns or coloured; a clean install, the 'unreviewed source' warning and a --force install that said nothing are no verdict", () => {
  const head = [
    "Warning: custom (unreviewed) source — not from the Hermes catalog.",
    "Cloning https://github.com/oneezy/skills.git (subdir: dist/hermes/pstack)...",
  ];
  // hermes_cli/plugins_cmd_install.py with no TTY: the flagged report, then the refusal, exit 1
  const caution = [
    ...head,
    "",
    "⚠ Security scan flagged this plugin:",
    "Scan: pstack (oneezy/skills/dist/hermes/pstack/community)  Verdict: CAUTION",
    '  HIGH     execution      skills/pstack/scripts/run.sh:3     "bash -c"',
    "",
    "Decision: BLOCKED — Blocked (community source + caution verdict, 9 findings). Use --force to override.",
    "Blocked: Security scan blocked plugin install: Requires confirmation (caution verdict, 9 findings)",
  ].join("\n");
  assert.equal(scanVerdict(caution), "caution");
  // Rich wraps at 80 columns off a terminal: a long name puts the verdict on the next line
  assert.equal(
    scanVerdict("Scan: diagram-design (oneezy/skills/dist/hermes/diagram-design/community)  Verdict:\nCAUTION"),
    "caution",
  );
  assert.equal(
    scanVerdict("Blocked: Security scan blocked plugin install: Requires confirmation (caution\nverdict, 1 findings)"),
    "caution",
  );
  assert.equal(
    scanVerdict(
      "Blocked: Security scan blocked plugin install: Blocked (dangerous verdict, 1 critical of 3 findings (curl_pipe_shell)). --force does not override a dangerous verdict.\n\nScan: x (o/r/x/community)  Verdict: DANGEROUS",
    ),
    "dangerous",
  );
  assert.equal(scanVerdict("\x1b[31mBlocked:\x1b[0m Security scan ... Verdict: \x1b[1mDANGEROUS\x1b[0m"), "dangerous");
  // a clean install, and a --force install whose caution passed in silence: nothing to read
  assert.equal(scanVerdict([...head, "✓ Installed pstack", "Plugin installed but not enabled."].join("\n")), null);
  assert.equal(scanVerdict("Scan: x (o/r/x/community)  Verdict: SAFE"), null);
  assert.equal(scanVerdict("Warning: something else about a scan of the cache"), null);
});

test("the --force that answers a caution is passed only for the library's own rendering path: owner/repo/<folder>/<id>, plain names only", () => {
  assert.equal(libraryPath("oneezy/skills/dist/hermes/pstack", "oneezy/skills"), true);
  assert.equal(libraryPath("Oneezy/Skills/dist/hermes/diagram-design", "oneezy/skills"), true);
  assert.equal(libraryPath("oneezy/skills/hermes/pstack", "oneezy/skills"), true);
  assert.equal(libraryPath("oneezy/skills/pstack", "oneezy/skills"), false);
  assert.equal(libraryPath("other/skills/dist/hermes/pstack", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills-fork/dist/hermes/pstack", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills/../evil/dist/x", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills/dist/hermes/.hidden", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills/dist/hermes/-x", "oneezy/skills"), false);
  assert.equal(libraryPath('oneezy/skills/dist/hermes/a"b', "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills/dist\\hermes/x", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills/dist//x", "oneezy/skills"), false);
  assert.equal(libraryPath("oneezy/skills", "oneezy/skills"), false);
});

test("a dangerous verdict is one --force does not get past: that plugin is a red line naming the verdict, its links stay, the others are installed", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, ["--json"], { FAKE_HARNESS_DANGEROUS: "play" });
  assert.equal(r.status, 1, r.stderr);
  const conflict = actions(r).find((a) => a.kind === "conflict");
  assert.equal(conflict?.path, "Hermes: plugin play");
  assert.equal(
    conflict?.note,
    "hermes could not install it; loose links kept. Hermes's security scan said dangerous, which this tool never overrides",
  );
  // Hermes prints the refusal on stdout (its Rich console), the report with it
  const said = (conflict?.diagnostic as { stdout?: string } | undefined)?.stdout ?? "";
  assert.match(
    said,
    /Blocked: Security scan blocked plugin install: Blocked \(dangerous verdict, .*\)\. --force does not override a dangerous verdict\./,
  );
  assert.match(said, /Verdict: DANGEROUS/);
  // never retried with --force
  assert.deepEqual(
    r.calls.filter((c) => c.includes(IDENTIFIER("play"))),
    [installCall("play", r17.commit)],
  );
  assert.equal(lexists(pluginDir(m, "play")), false);
  assert.ok(isLink(links["play-unslop"]), "play's link stays");
  assert.deepEqual(config(m).enabled, ["matt-pocock", "oneezy"]);
});

test("the read-back after install is red when hermes did not pin the plugin to the release commit: hermes lists it pinned@<other sha>, its links stay; the next sync, with hermes pinning right, finishes and then changes nothing", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  const r = await cli(m, ["--json"], { FAKE_HARNESS_WRONG_PIN: "play", FAKE_HARNESS_CAUTION: "play" });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "conflict")
      .map(brief),
    [
      [
        "conflict",
        "Hermes: plugin play",
        `installed but not verified (hermes lists it git pinned@ffffffff, not pinned@${r17.commit.slice(0, 8)}); loose links kept`,
      ],
    ],
  );
  assert.ok(isLink(links["play-unslop"]), "play's link stays");
  assert.equal(lexists(links["oneezy-status"]), false);
  // the plugin is current by its files, so the next sync installs nothing: the pin is checked on the run that installs
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.equal(again.calls.filter(pluginWrite).length, 0, JSON.stringify(again.calls));
  assert.equal(lexists(links["play-unslop"]), false, "verified by its files and enabled state, its link goes");
  const settled = await cli(m, []);
  assert.equal(lines(settled).at(-1), "0 changed, 3 already right, 0 left alone");
  assert.equal(settled.calls.filter(pluginWrite).length, 0);
});

/** release-18: oneezy at 0.43.2, play's upstream snapshot moved without a version change (its NOTICE says so) */
function release18() {
  return fixtureRelease({
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
}

test("a plugin behind a newer release is re-installed at the new commit, as is one whose NOTICE.md is not the release's though its version is, plain first so Hermes's scan has its say: a clean scan ends in Hermes's 'already exists' and one --force retry moves the pin with no note; a caution gets the same retry and the note a fresh install gets; the current ones are skips", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    hermesSource(m, r17);
    migrating(m);
    const first = await cli(m, []);
    assert.equal(first.status, 0, first.stderr);
    const r18 = release18();
    github.addRelease(r18);
    hermesSource(m, r18);
    // play's scan now says caution (release-18 brought it): the plain re-install is where Hermes says so, so it is
    // answered and noted as on a fresh install; oneezy's scan is clean, so Hermes refuses the plain call only because
    // the plugin is there, and the --force retry says nothing
    const r = await cli(m, ["--json"], { FAKE_HARNESS_CAUTION: "play", COLUMNS: "80" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(r.calls.filter(pluginWrite), [
      installCall("oneezy", r18.commit),
      installCall("oneezy", r18.commit, true),
      installCall("play", r18.commit),
      installCall("play", r18.commit, true),
    ]);
    const notes = actions(r).filter((a) => a.note?.startsWith("Hermes scan"));
    assert.deepEqual(notes.map(brief), [
      ["note", "Hermes: plugin play", "Hermes scan caution, installed with --force (library plugin)"],
    ]);
    const said = (notes[0].diagnostic as { stdout?: string } | undefined)?.stdout ?? "";
    assert.match(said, /Scan: play \(oneezy\/skills\/dist\/hermes\/play\/community\) {2}Verdict: CAUTION/);
    assert.ok(!actions(r).some((a) => a.kind === "conflict"), JSON.stringify(actions(r)));
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
    const reinstalls = actions(r).filter((a) => a.kind === "install" && a.target);
    assert.deepEqual(
      reinstalls.map((a) => [a.path, a.target, a.note]),
      [
        [
          "Hermes: plugin oneezy",
          IDENTIFIER("oneezy"),
          `0.43.1 -> 0.43.2 at ${r18.commit.slice(0, 7)}; version 0.43.1, the release has 0.43.2`,
        ],
        [
          "Hermes: plugin play",
          IDENTIFIER("play"),
          `0.43.0 -> 0.43.0 at ${r18.commit.slice(0, 7)}; NOTICE.md is not release-18's`,
        ],
      ],
    );
    const settled = await cli(m, []);
    assert.equal(lines(settled).at(-1), "0 changed, 3 already right, 0 left alone");
  } finally {
    await github.close();
  }
});

test("a re-install whose scan says dangerous is a red line naming the verdict, never retried with --force: the plugin stays at the commit it had, enabled, and the next release's other plugins still move", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    hermesSource(m, r17);
    const first = await cli(m, []);
    assert.equal(first.status, 0, first.stderr);
    const r18 = release18();
    github.addRelease(r18);
    hermesSource(m, r18);
    const r = await cli(m, ["--json"], { FAKE_HARNESS_DANGEROUS: "play" });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.deepEqual(r.calls.filter(pluginWrite), [
      installCall("oneezy", r18.commit),
      installCall("oneezy", r18.commit, true),
      installCall("play", r18.commit),
    ]);
    const conflicts = actions(r).filter((a) => a.kind === "conflict");
    assert.deepEqual(conflicts.map(brief), [
      [
        "conflict",
        "Hermes: plugin play",
        "hermes could not install it; loose links kept. Hermes's security scan said dangerous, which this tool never overrides",
      ],
    ]);
    assert.match(
      (conflicts[0].diagnostic as { stdout?: string } | undefined)?.stdout ?? "",
      /Blocked: Security scan blocked plugin install: Blocked \(dangerous verdict, .*\)\. --force does not override a dangerous verdict\./,
    );
    assert.equal(installs(m).play.revision, r17.commit);
    assert.equal(installs(m).oneezy.revision, r18.commit);
    assert.deepEqual(config(m).enabled, ["matt-pocock", "oneezy", "play"]);
    assert.ok(!actions(r).some((a) => a.note?.startsWith("Hermes scan")), JSON.stringify(actions(r)));
  } finally {
    await github.close();
  }
});

test("Hermes's 'already exists' refusal is read as hermes_cli/plugins_cmd_install.py prints it, wrapped at 80 columns or coloured; the link refusal and other errors are not it", () => {
  const said =
    "Warning: custom (unreviewed) source — not from the Hermes catalog.\n" +
    "Cloning https://github.com/oneezy/skills.git (subdir: dist/hermes/oneezy)...\n" +
    "Error: Plugin 'oneezy' already exists. Use force reinstall or run `hermes plugins update oneezy`.";
  assert.equal(alreadyExists(said), true);
  assert.equal(
    alreadyExists(
      "Error: Plugin 'diagram-design' already exists. Use force reinstall or run `hermes\nplugins update diagram-design`.",
    ),
    true,
  );
  assert.equal(
    alreadyExists(
      "Error: Plugin 'diagram-design' already\nexists. Use force reinstall or run `hermes plugins update`.",
    ),
    true,
  );
  assert.equal(
    alreadyExists("\x1b[31mError:\x1b[0m Plugin 'x' already exists. Use force reinstall or run `hermes`."),
    true,
  );
  assert.equal(
    alreadyExists(
      "Error: Plugin 'x' is already installed outside the catalog: /h/plugins/x is a link to /y. Delete that link to install the catalog version.",
    ),
    false,
  );
  assert.equal(
    alreadyExists("Error: Plugin 'x' is pinned. Reinstall it with an explicit --ref <40-character commit SHA>."),
    false,
  );
  assert.equal(alreadyExists("Blocked: Security scan blocked plugin install: Requires confirmation"), false);
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
        link,
        `link points outside the library (${mine}) and plugin oneezy also carries oneezy-status; left alone`,
      ],
      [
        "conflict",
        folder,
        "a real folder, and plugin matt-pocock also carries grilling; left alone (delete it by hand to keep grilling once)",
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
  // plugins/<id> as a folder without a plugin.json (a plugin.yaml package, a copy of something else): the install's
  // --force would replace it, so the tool never runs one there
  const m3 = machine();
  hermesSource(m3, r17);
  fs.mkdirSync(pluginDir(m3, "oneezy"), { recursive: true });
  fs.writeFileSync(path.join(pluginDir(m3, "oneezy"), "plugin.yaml"), "name: oneezy\n");
  const before3 = snapshot(pluginDir(m3, "oneezy"));
  const r3 = await cli(m3, ["--json"]);
  assert.equal(r3.status, 1);
  assert.deepEqual(snapshot(pluginDir(m3, "oneezy")), before3);
  assert.ok(
    actions(r3).some(
      (a) =>
        a.kind === "conflict" &&
        a.path === "Hermes: plugin oneezy" &&
        a.note === `${pluginDir(m3, "oneezy")} was not installed through hermes plugins; left alone, loose links kept`,
    ),
    JSON.stringify(actions(r3)),
  );
  assert.ok(!r3.calls.some((c) => c.includes(IDENTIFIER("oneezy"))), JSON.stringify(r3.calls));
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
      (a) =>
        a.kind === "note" && a.path === "Hermes: plugins" && a.note === "not compared; the latest release was not read",
    ),
    JSON.stringify(actions(r2)),
  );
  for (const link of Object.values(links2)) assert.ok(isLink(link));
});

test("on a PC with the old ~/.skills-sync link beside Hermes nothing links into its skills folder any more: the plugins are its form, the folder stays empty, the old link is one note and never read, and the old flags are named once (Codex, named too, gets nothing of the old run's either)", async () => {
  const m = machine({ harnesses: ["hermes", "codex"], clis: ["hermes"] });
  const r17 = latest();
  hermesSource(m, r17);
  const old = oldLibraryLink(m);
  const r = await cli(m, ["--no-wsl", "--agents", "codex,hermes"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(
    r.stderr,
    "ignored: --no-wsl, --agents (settings come from the release's skills-sync.json; machine facts are detected on every run)\n",
  );
  assert.ok(isLink(old), "the old link is left as it was");
  assert.ok(
    lines(r).some((l) => l.startsWith(". note") && l.includes(old) && l.includes("the old library link")),
    r.stdout,
  );
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

test("a release whose commit carries no Hermes rendering yet (the library before its first build with this tool) is one note and no install: GitHub is asked once, hermes runs nothing, the loose links stay, exit 0", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    // no hermesSource(): the fake GitHub has no dist/hermes at the release commit, like oneezy/skills main before #79
    const links = migrating(m);
    const before = snapshot(m.home);
    const r = await cli(m, []);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(snapshot(m.home), before);
    assert.equal(r.calls.filter(pluginWrite).length, 0, JSON.stringify(r.calls));
    for (const link of Object.values(links)) assert.ok(isLink(link), link);
    assert.deepEqual(
      r.requests.filter((q) => q.path.includes("/contents/dist/")).map((q) => q.path),
      [`/repos/${REPO}/contents/dist/hermes?ref=${r17.commit}`],
    );
    const notes = lines(r).filter((l) => l.startsWith(". note"));
    assert.equal(notes.length, 1, r.stdout);
    assert.ok(
      notes[0].includes("Hermes: plugins") &&
        notes[0].includes(`release-17 carries no Hermes rendering yet, no dist/hermes/ at ${r17.commit.slice(0, 7)}`) &&
        notes[0].includes("nothing installed, loose links kept"),
      notes[0],
    );
    assert.equal(lines(r).at(-1), "0 changed, 0 already right, 0 left alone");
    // the same under --plan: a plan asks the same question and records no install
    const plan = await cli(m, ["--plan", "--json"]);
    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(!actions(plan).some((a) => a.kind === "install"), JSON.stringify(actions(plan)));
  } finally {
    await github.close();
  }
});

test("a release whose config names another rendering folder (renderings.hermes: dist/hermes-x) installs from it: GitHub is asked about that folder, every install names it, and a plugin installed from dist/hermes is installed again from it", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    const folder = "dist/hermes-x";
    github.fixture.contents![r17.commit]["skills-sync.json"] = fixtureConfig(REPO, "0.43.1", {
      renderings: { hermes: folder },
    });
    hermesSource(m, r17, REPO, folder);
    // oneezy, current and enabled, but installed from dist/hermes/oneezy (the default folder) at the release commit
    hermesPlugin(m, "oneezy", { files: r17.plugins.oneezy.files, revision: r17.commit });
    const identifier = (id: string) => `${REPO}/${folder}/${id}`;
    const install = (id: string, force = false) => [
      "hermes",
      "plugins",
      "install",
      identifier(id),
      "--no-enable",
      "--ref",
      r17.commit,
      ...(force ? ["--force"] : []),
    ];
    const r = await cli(m, []);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // the rendering question names the config's folder, once
    assert.deepEqual(
      r.requests
        .filter(
          (q) => q.path.includes("/contents/") && !q.path.includes("skills-sync.json") && !q.path.includes("SHARED.md"),
        )
        .map((q) => q.path),
      [`/repos/${REPO}/contents/${folder}?ref=${r17.commit}`],
    );
    assert.deepEqual(r.calls.filter(pluginWrite), [
      install("matt-pocock"),
      enableCall("matt-pocock"),
      install("oneezy"),
      install("oneezy", true),
      install("play"),
      enableCall("play"),
    ]);
    for (const id of ["matt-pocock", "oneezy", "play"])
      assert.equal(installs(m)[id].source, `https://github.com/${REPO}.git#${folder}/${id}`, id);
    assert.ok(
      lines(r).some(
        (l) =>
          l.startsWith("+ install") &&
          l.includes(`Hermes: plugin oneezy -> ${identifier("oneezy")}`) &&
          l.includes(`installed from dist/hermes/oneezy, not ${folder}/oneezy`),
      ),
      r.stdout,
    );
    // and the next sync finds every plugin where the config says: nothing to do
    const again = await cli(m, []);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.equal(lines(again).at(-1), "0 changed, 3 already right, 0 left alone");
    assert.equal(again.calls.filter(pluginWrite).length, 0, JSON.stringify(again.calls));
  } finally {
    await github.close();
  }
});

test("a release config that writes the library's name in another case (Oneezy/Skills) is the same catalog: status lists the plugins hermes installed from oneezy/skills as the library's, current", async () => {
  const github = await startFakeGithub();
  try {
    const m = machine({}, github);
    const r17 = latest(github);
    github.fixture.contents![r17.commit]["skills-sync.json"] = fixtureConfig("Oneezy/Skills", "0.43.1");
    for (const id of ["matt-pocock", "oneezy", "play"])
      hermesPlugin(m, id, { files: r17.plugins[id].files, revision: r17.commit });
    const s = await cli(m, ["status", "--json"]);
    assert.equal(s.status, 0, s.stderr + s.stdout);
    const hermes = (s.json as unknown as StatusJson).harnesses.hermes;
    assert.deepEqual(hermes.plugins.other, []);
    assert.deepEqual(
      hermes.plugins.installed.map((p) => [p.id, p.marketplace, p.current]),
      [
        ["matt-pocock", "oneezy-skills", true],
        ["oneezy", "oneezy-skills", true],
        ["play", "oneezy-skills", true],
      ],
    );
  } finally {
    await github.close();
  }
});

test("a plugin ahead of the latest release (installed by hand from main) is a note and stays as it is: never pinned back, its skills' links still come out; the others are installed", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  const links = migrating(m);
  hermesPlugin(m, "oneezy", { version: "0.99.0", skills: ["oneezy-merge", "oneezy-status"], pinned: false });
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter(pluginWrite), [
    installCall("matt-pocock", r17.commit),
    enableCall("matt-pocock"),
    installCall("play", r17.commit),
    enableCall("play"),
  ]);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.path === "Hermes: plugin oneezy")
      .map(brief),
    [["note", "Hermes: plugin oneezy", "0.99.0 is ahead of the latest release (0.43.1); left as it is"]],
  );
  assert.equal(JSON.parse(fs.readFileSync(path.join(pluginDir(m, "oneezy"), "plugin.json"), "utf8")).version, "0.99.0");
  for (const link of Object.values(links)) assert.equal(lexists(link), false, link);
});

test("what no plugin of the release carries is reported, one line each, and left: a link into a library copy, a dangling link, a link to somewhere else and a real folder; a link whose target cannot be read too", async () => {
  const m = machine();
  const r17 = latest();
  hermesSource(m, r17);
  libraryCopy(m);
  const copy = looseLink(m, "hermes", "old-skill");
  const gone = path.join(m.base, "gone", "gone-skill");
  const dangling = looseLink(m, "hermes", "gone-skill", gone);
  fs.rmSync(path.dirname(gone), { recursive: true, force: true });
  const mine = path.join(m.base, "mine", "mine-skill");
  const foreign = looseLink(m, "hermes", "mine-skill", mine);
  const folder = skillFolder(m, "hermes", "own-folder");
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    actions(r)
      .filter((a) => a.kind === "note" && a.path.startsWith(hermesSkills(m)))
      .map(brief),
    [
      ["note", dangling, `dangling link; no plugin in release-17 carries gone-skill; left alone`],
      ["note", foreign, `links to ${mine}, not a library copy; adopt it into ${REPO} or delete it by hand`],
      ["note", copy, `links into a library copy, but no plugin in release-17 carries old-skill; left alone`],
      ["note", folder, `not in the latest release; adopt it into ${REPO} or delete it by hand`],
    ],
  );
  assert.ok(!actions(r).some((a) => a.kind === "remove"), JSON.stringify(actions(r)));
  for (const p of [copy, dangling, foreign]) assert.ok(isLink(p), p);
  assert.ok(fs.existsSync(path.join(folder, "SKILL.md")));
  const status = (await cli(m, ["status", "--json"])).json as unknown as StatusJson;
  assert.deepEqual(status.harnesses.hermes.loose.map((l) => l.name).sort(), ["gone-skill", "mine-skill", "old-skill"]);

  // a link whose target the probe could not read (target ""): the form itself, in plan mode, with such a state; the
  // fake hermes runs from this process's environment, so the machine's goes there for the call
  const env = { ...process.env, ...m.env, PATH: [m.bin, ...m.extraPath, process.env.PATH].join(path.delimiter) };
  const machineNow = probe(harnessTable(m.home, env, process.platform), env, m.home);
  const state = machineNow.harnesses.find((h) => h.harness.id === "hermes")!;
  const unreadable = path.join(hermesSkills(m), "grilling");
  state.loose.push({ name: "grilling", path: unreadable, target: "" });
  const release = parseRelease(REPO, r17.tag, r17.commit, Buffer.from(JSON.stringify(r17.json)));
  const saved = { ...process.env };
  let planned;
  try {
    Object.assign(process.env, env);
    planned = await hermesForm(release, state, machineNow, { plan: true, github: null });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.deepEqual(
    planned.filter((a) => a.path === unreadable).map((a) => [a.kind, a.note]),
    [["note", "a link whose target cannot be read; left alone"]],
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
  // up to 0.7.x the tool linked into ~/.hermes/skills on Windows too: still probed there, so its links come out
  assert.deepEqual(row.legacyUserSkills, [path.join(home, ".hermes", "skills")]);
  const set = harnessTable(home, { LOCALAPPDATA: local, HERMES_HOME: path.join("E:", "h") }, "win32");
  assert.equal(set.find((h) => h.id === "hermes")!.legacyUserSkills, undefined, "HERMES_HOME was the old home too");
  const posix = harnessTable(posixHome, {}, "linux").find((h) => h.id === "hermes")!;
  assert.equal(posix.legacyUserSkills, undefined, "~/.hermes is Hermes's home there");
  // the namespace Hermes gives a plugin's skills, from its name: agent-plugin-<slug>-<sha256(name)[:8]>
  assert.equal(hermesNamespace("oneezy"), "agent-plugin-oneezy-80c7eb0f");
  assert.equal(hermesNamespace("matt-pocock"), "agent-plugin-matt-pocock-c0b71e82");
  assert.equal(hermesNamespace("play"), "agent-plugin-play-aba4cc9b");
});
