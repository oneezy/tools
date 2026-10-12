// The release: the version the package and the CLI banner carry, the commands and flags --help lists, and what the
// package ships (the built CLI, the three schemas, the README). Nothing here touches a library or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "vite-plus/test";
import { VERSION } from "../src/version.js";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
/** The package's own folder, wherever the workspace keeps it: two levels above the compiled tests. */
const PACKAGE = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as {
  version: string;
  files: string[];
  bin: Record<string, string>;
};

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: PACKAGE });
}

test("package.json, src/version.ts and the --help banner carry one version and never differ", () => {
  assert.equal(manifest.version, VERSION);
  const r = cli("--help");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n")[0], `skills-sync ${VERSION}`);
});

test("--help lists the machine commands, the library commands and every flag; an unknown option or command exits 2 with the same help; a retired command says what replaced it", () => {
  const help = cli("--help").stdout;
  // the commands as a library's CI reads them to know what this build can run: under Commands, up to the next heading,
  // the first word of each line indented by exactly two spaces
  const lines = help.split("\n");
  const from = lines.indexOf("Commands");
  const to = lines.findIndex((l, i) => i > from && /^[A-Z]/.test(l));
  const commands = lines
    .slice(from + 1, to)
    .filter((l) => /^  [a-z]/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(commands, [
    "sync",
    "status",
    "branches",
    "hook",
    "unlink",
    "migrate-aliases",
    "rollback-aliases",
    "update",
    "refresh",
    "versions",
    "add",
    "build",
    "check",
  ]);
  // a flag is named at the start of its line under its section
  const flags = [
    ["--plugins", "--catalogs", "--artifacts", "--check"],
    [
      "--to <version>|previous|latest",
      "--frozen",
      "--id <id>",
      "--root <path>",
      "--skills <names|*>",
      "--as <old=new,...>",
      "--plugin <id>",
      "--retry",
    ],
    [
      "--plan",
      "--quiet",
      "--json",
      "--library <owner/repo>",
      "--repo <path>",
      "--alias-file <json>",
      "--receipt <path>",
      "--expect-revision <sha>",
      "--remote-ref <ref>",
      "--symlinks",
      "--junctions",
      "-h, --help",
    ],
  ].flat();
  for (const f of flags)
    assert.ok(
      help.split("\n").some((l) => l.startsWith(`  ${f}`)),
      `flag ${f}`,
    );
  // what the new commands promise: the internal marker and its escape, the version rule, check's exit codes
  assert.match(help, /metadata\.internal: true/);
  assert.match(help, /INSTALL_INTERNAL_SKILLS=1/);
  assert.match(help, /locked upstream version/);
  assert.match(help, /exit 1 on any, 0 when clean/);
  // what the branch rules promise: the names never deleted, the archive tag, that --plan writes nothing
  assert.match(help, /main, dev and any \*-keep, research\/\* or prototype\/\* branch are never\s+deleted/);
  assert.match(help, /tagged\s+archive\/<name> at its head, then deleted/);
  assert.match(help, /--plan lists every tag and delete\s+without making them/);
  // what the session hook promises: silent when nothing changed, a dirty checkout left alone
  assert.match(help, /Prints nothing when nothing changed; exit 0 unless the sync hit a conflict/);
  assert.match(help, /a dirty one or one on another\s+branch is named and\s+left alone/);
  assert.match(help, /every git repository in reach, whoever owns it/);
  assert.match(help, /Never a rebase, a\s+reset or a branch switch/);
  // what a library's CI has to know about its checkout: neither a check nor a build needs history, and versions only go up
  assert.match(help, /Needs no history: clean in a shallow clone/);
  assert.match(help, /Builds never bump a version or append a commit hash/);
  // what the machine commands promise: nothing of their own on the machine, settings from the release, old flags named
  assert.match(help, /no library clone, no\nanswers file, nothing remembered between runs/);
  assert.match(help, /named in one line on stderr/);
  assert.match(
    help,
    /\n  --plan\s+show what would change, touch nothing: sync, unlink, branches and the library commands/,
  );
  assert.match(help, /status only reads, hook refuses it/);
  // the old flags are not documented as options any more
  for (const gone of [
    "--agents <ids>",
    "--global / --no-global",
    "--no-pull",
    "--watch",
    "-y, --yes",
    "--ask",
    "--adoption-file",
    "--no-entrypoints",
  ])
    assert.ok(!help.split("\n").some((l) => l.startsWith(`  ${gone}`)), `${gone} still listed`);

  const bad = cli("--nope");
  assert.equal(bad.status, 2);
  // node may put a warning of its own on stderr first; the option's line is followed by the whole help
  assert.ok(bad.stderr.includes(`unknown option --nope\n${help}`));
  assert.equal(bad.stdout, "");
  const unknown = cli("frobnicate");
  assert.equal(unknown.status, 2);
  assert.ok(unknown.stderr.includes(`unknown command frobnicate\n${help}`));
  assert.equal(unknown.stdout, "");
  // a word a machine command does not expect is refused in one line, exit 2 (branches takes repos)
  for (const args of [
    ["sync", "extra"],
    ["status", "x", "y"],
    ["unlink", "now"],
    ["hook", "x"],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stderr, `${args[0]}: takes no argument (got ${args.slice(1).join(" ")})\n`);
    assert.equal(r.stdout, "");
  }
  const retired = cli("projects");
  assert.equal(retired.status, 2);
  assert.equal(retired.stdout, "");
  assert.equal(retired.stderr.trimEnd().split("\n").length, 1, retired.stderr);
  assert.match(retired.stderr, /^projects: retired; .*run sync\n$/);
  // the Brain block's recovery commands are retired: SHARED.md is the global block, /oneezy-brain owns Brain routing
  for (const command of ["adopt-brain", "rollback-brain"]) {
    const r = cli(command, "--repo", PACKAGE, "--receipt", "receipt.json", "--adoption-file", "links.json");
    assert.equal(r.status, 2, command);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trimEnd().split("\n").length, 1, r.stderr);
    assert.match(r.stderr, new RegExp(`^${command}: retired; .*SHARED\\.md.*/oneezy-brain.*\n$`));
  }
});

test("the package ships the built CLI, the three schemas (the flow schema among them) and the README, and its bin is the built CLI", () => {
  assert.deepEqual(manifest.files, ["dist/src", "schemas", "scripts", "README.md"]);
  assert.deepEqual(manifest.bin, { "skills-sync": "dist/src/cli.js" });
  assert.deepEqual(fs.readdirSync(path.join(PACKAGE, "schemas")).sort(), [
    "flow.schema.json",
    "skills-sync.local.schema.json",
    "skills-sync.schema.json",
  ]);
  for (const n of fs.readdirSync(path.join(PACKAGE, "schemas")))
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(PACKAGE, "schemas", n), "utf8")), n);
  assert.ok(fs.existsSync(path.join(PACKAGE, "README.md")));
  assert.ok(fs.existsSync(path.join(PACKAGE, manifest.bin["skills-sync"])));
});
