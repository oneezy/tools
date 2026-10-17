// node --test .github/scripts/: run.sh, the shell of .github/workflows/run.yml, against a clone whose origin is a bare
// repository on disk, with a fake @oneezy/skills-sync that changes the lock the way `update` does. It checks the whole
// caller-to-command-to-artifact chain of a library command: run.yml's environment in, the tool run against the checkout,
// and out the one artifact run.sh may make, a land/<command>-<args>-<run id> branch carrying run-report.mjs's message.
// run.sh is Git automation only: it never writes dev or main and never cuts a release; land.yml and library.yml do.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { branches, findBash, git, remote, tags } from "./dry-run.mjs";

const SCRIPTS = fileURLToPath(new URL("./", import.meta.url));
const BASH = findBash();
const skip = BASH ? false : "bash is not available (run.sh runs on the ubuntu runner)";

const CONFIG = { version: 1, sources: { "matt-pocock": { repo: "mattpocock/skills", ref: "main" } } };
const LOCK = { version: 2, sources: { "matt-pocock": { commit: "7a030a8b0dcaa601bb0dda9aaf174affb3d61145", version: "1.3.1" } } };
const REPORT = {
  updated: [
    {
      id: "matt-pocock",
      from: { version: "1.3.1", commit: "7a030a8b0dcaa601bb0dda9aaf174affb3d61145", ahead: 0 },
      to: { version: "1.4.0", commit: "49dd158d1076134a641b33efb035946536778336", ahead: 0 },
      direction: "upgrade",
      changelog: "## 1.4.0\n\n- BREAKING: `handoff` now needs a ticket number\n",
    },
  ],
};

// The tool as run.sh drives it. FAKE_MODE: move (update rewrites the lock), same (nothing changes), github (the
// command writes under .github/), check-fail (build --check refuses the tree). FAKE_COMMANDS: what --help lists.
const FAKE_CLI = `
const fs = require("node:fs"), path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, argv.join(" ") + "\\n");
const repo = argv[argv.indexOf("--repo") + 1];
const mode = process.env.FAKE_MODE || "move";
const [cmd] = argv;
if (cmd === "--help") {
  console.log("skills-sync: one skills library on every harness\\n\\nCommands:");
  for (const c of (process.env.FAKE_COMMANDS || "update,add,remove,versions").split(",")) console.log("  " + c + " <source>");
  process.exit(0);
}
if (cmd === "update" || cmd === "add") {
  if (mode === "move" || mode === "check-fail") {
    const lock = path.join(repo, "skills-sync.lock.json");
    const j = JSON.parse(fs.readFileSync(lock, "utf8"));
    j.sources["matt-pocock"] = { commit: "49dd158d1076134a641b33efb035946536778336", version: "1.4.0" };
    fs.writeFileSync(lock, JSON.stringify(j, null, 2) + "\\n");
  }
  if (mode === "github") fs.writeFileSync(path.join(repo, ".github", "extra.yml"), "x\\n");
  console.log(JSON.stringify(mode === "same" ? { updated: [] } : ${JSON.stringify(REPORT)}));
  process.exit(0);
}
if (cmd === "versions") { console.log("matt-pocock: 1.4.0, 1.3.1 (lock)"); process.exit(0); }
if (cmd === "build" && argv.includes("--check") && mode === "check-fail") { console.error("drift"); process.exit(1); }
process.exit(0);
`;

/** Run run.sh as run.yml's step does, against a fresh remote; returns the result, the remote and the tool's calls. */
function runSh(env) {
  const r = remote({
    "skills-sync.json": JSON.stringify(CONFIG, null, 2) + "\n",
    "skills-sync.lock.json": JSON.stringify(LOCK, null, 2) + "\n",
    ".github/workflows/land.yml": "name: land\n",
  });
  // run.sh and the run-report.mjs beside it, copied with LF endings: a Windows checkout may carry CRLF, the runner never does
  const scripts = path.join(r.base, "scripts");
  fs.mkdirSync(scripts);
  for (const f of ["run.sh", "run-report.mjs"]) fs.writeFileSync(path.join(scripts, f), fs.readFileSync(path.join(SCRIPTS, f), "utf8").replace(/\r\n/g, "\n"));
  const cli = path.join(r.base, "fake-cli.cjs");
  const log = path.join(r.base, "cli.log");
  const output = path.join(r.base, "github-output");
  fs.writeFileSync(cli, FAKE_CLI);
  fs.writeFileSync(log, "");
  fs.writeFileSync(output, "");
  const res = spawnSync(BASH, [path.join(scripts, "run.sh")], {
    cwd: r.base,
    encoding: "utf8",
    env: {
      ...process.env,
      CLI: cli,
      LIBRARY: "library",
      RUN_ID: "42",
      RUN_URL: "https://example.test/runs/42",
      TOOL_VERSION: "0.17.0",
      HAS_PUSH_TOKEN: "true",
      GITHUB_OUTPUT: output,
      FAKE_LOG: log,
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(output, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  return { ...res, remote: r, outputs, calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("a moved source: run.sh pushes land/update-<args>-<run id> on dev's tip carrying run-report's message, and leaves dev, main and the tags alone", { skip }, () => {
  const res = runSh({ COMMAND: "update", ARGS: "matt-pocock" });
  assert.equal(res.status, 0, res.stderr);
  const { origin, ref } = res.remote;
  const dev = ref("dev");
  assert.deepEqual(branches(origin), ["dev", "land/update-matt-pocock-42", "main"]);
  assert.equal(git(origin, "rev-parse", "land/update-matt-pocock-42^"), dev, "one commit on dev's tip");
  assert.equal(ref("main"), dev, "main is where it was");
  assert.deepEqual(tags(origin), []);
  const message = git(origin, "log", "-1", "--format=%B", "land/update-matt-pocock-42");
  assert.match(message, /^🔧 chore\(repo\): update matt-pocock\n/);
  assert.match(message, /matt-pocock: 1\.3\.1 \(7a030a8\) → 1\.4\.0 \(49dd158\), upgrade/);
  assert.match(message, /Run: https:\/\/example\.test\/runs\/42/);
  assert.deepEqual(git(origin, "diff", "--name-only", "dev", "land/update-matt-pocock-42").split("\n"), ["skills-sync.lock.json"]);
  assert.deepEqual(res.outputs, { changed: "true", branch: "land/update-matt-pocock-42" });
  assert.ok(res.calls.includes("update matt-pocock --json --repo library"), res.calls.join("\n"));
  assert.ok(res.calls.includes("build --check --repo library") && res.calls.includes("check --repo library"), "the tree is checked before the push");
});

test("an unchanged run pushes nothing and says changed=false", { skip }, () => {
  const res = runSh({ COMMAND: "update", ARGS: "", FAKE_MODE: "same" });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(branches(res.remote.origin), ["dev", "main"]);
  assert.equal(res.outputs.changed, "false");
  assert.match(res.stdout, /changed nothing/);
});

test("versions only prints, needs no push token and pushes nothing", { skip }, () => {
  const res = runSh({ COMMAND: "versions", ARGS: "matt-pocock", HAS_PUSH_TOKEN: "false" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1\.4\.0, 1\.3\.1 \(lock\)/);
  assert.deepEqual(branches(res.remote.origin), ["dev", "main"]);
  assert.equal(res.outputs.changed, "false");
});

test("refusals run nothing or push nothing: no push token, a command the tool lacks, an unknown command, --repo in args, a change under .github/, a tree check refuses", { skip }, () => {
  const cases = [
    [{ COMMAND: "update", HAS_PUSH_TOKEN: "false" }, /no PROJECT_PAT secret/, true],
    [{ COMMAND: "rename", ARGS: "old new" }, /has no 'rename' command/, true],
    [{ COMMAND: "sync" }, /unknown command 'sync'/, false],
    [{ COMMAND: "update", ARGS: "--repo elsewhere" }, /args may not name --repo/, true],
    [{ COMMAND: "update", FAKE_MODE: "github" }, /changed \.github\/ \(\.github\/extra\.yml\)/, true],
    [{ COMMAND: "update", FAKE_MODE: "check-fail" }, /left a tree check refuses/, true],
  ];
  for (const [env, error, ranHelp] of cases) {
    const res = runSh(env);
    const label = JSON.stringify(env);
    assert.equal(res.status, 1, label);
    assert.match(res.stderr, error, label);
    assert.match(res.stderr, /^::error title=run /m, label);
    assert.deepEqual(branches(res.remote.origin), ["dev", "main"], `${label}: nothing pushed`);
    assert.equal(res.calls.length > 0, ranHelp, `${label}: ${res.calls.join(" | ")}`);
  }
});
