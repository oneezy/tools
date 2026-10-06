// The release: the version the package and the CLI banner carry, the commands and flags --help lists, and what the
// package ships (the built CLI, the three schemas, the README). Nothing here touches a library or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.js");
/** The package's own folder, wherever the workspace keeps it: two levels above the compiled tests. */
const PACKAGE = path.resolve(import.meta.dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, "package.json"), "utf8")) as { version: string; files: string[]; bin: Record<string, string> };

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: PACKAGE });
}

test("the package is 0.4.0 and --help opens with that version: the banner and package.json never differ", () => {
  assert.equal(manifest.version, "0.4.0");
  const r = cli("--help");
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n")[0], "skills-sync 0.4.0");
});

test("--help lists every command and every flag of build, check, update (refresh), versions and add beside the 0.2.0 ones; an unknown option exits 2 with the same help", () => {
  const help = cli("--help").stdout;
  // the commands as a library's CI reads them to know what this build can run: under Commands, up to the next heading,
  // the first word of each line indented by exactly two spaces
  const lines = help.split("\n");
  const from = lines.indexOf("Commands");
  const to = lines.findIndex((l, i) => i > from && /^[A-Z]/.test(l));
  const commands = lines.slice(from + 1, to).filter((l) => /^  [a-z]/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(commands, ["sync", "status", "unlink", "projects", "update", "refresh", "versions", "add", "build", "check"]);
  // a flag is named at the start of its line under its section
  const flags = [
    ["--plugins", "--catalogs", "--artifacts", "--check"],
    ["--to <version>|previous|latest", "--frozen", "--id <id>", "--root <path>", "--skills <names|*>", "--as <old=new,...>", "--plugin <id>"],
    ["--repo <path>", "--library <src>", "--agents <ids>", "--global / --no-global", "--projects <names|*>", "--dev <dir>", "--copy", "--wsl <distros|*>", "--symlinks", "--junctions", "--no-pull / --pull", "--no-restore", "--retry", "--sidecars", "--no-layers", "--watch", "--plan", "--quiet", "--json", "-y, --yes", "--ask", "-h, --help"],
  ].flat();
  for (const f of flags) assert.ok(help.split("\n").some((l) => l.startsWith(`  ${f}`)), `flag ${f}`);
  // what the new commands promise: the internal marker and its escape, the version rule, check's exit codes
  assert.match(help, /metadata\.internal: true/);
  assert.match(help, /INSTALL_INTERNAL_SKILLS=1/);
  assert.match(help, /0\.<n>\.0\+<sha12>/);
  assert.match(help, /exit 1 on any, 0 when clean/);
  // what a library's CI has to know about its checkout: neither a check nor a build needs history, and versions only go up
  assert.match(help, /Needs no history: clean in a shallow clone/);
  assert.match(help, /n never comes from git history, so it never goes backwards/);

  const bad = cli("--nope");
  assert.equal(bad.status, 2);
  // node may put a warning of its own on stderr first; the option's line is followed by the whole help
  assert.ok(bad.stderr.includes(`unknown option --nope\n${help}`));
  assert.equal(bad.stdout, "");
});

test("the package ships the built CLI, the three schemas (the flow schema among them) and the README, and its bin is the built CLI", () => {
  assert.deepEqual(manifest.files, ["dist/src", "schemas", "README.md"]);
  assert.deepEqual(manifest.bin, { "skills-sync": "dist/src/cli.js" });
  assert.deepEqual(fs.readdirSync(path.join(PACKAGE, "schemas")).sort(), ["flow.schema.json", "skills-sync.local.schema.json", "skills-sync.schema.json"]);
  for (const n of fs.readdirSync(path.join(PACKAGE, "schemas"))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(PACKAGE, "schemas", n), "utf8")), n);
  assert.ok(fs.existsSync(path.join(PACKAGE, "README.md")));
  assert.ok(fs.existsSync(path.join(PACKAGE, manifest.bin["skills-sync"])));
});
