// node --test .github/scripts/: the land commit of a run (run-report.mjs) from the report `update` or `add` prints with
// --json, and the hold it applies to skills-sync.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyConfig, flagged, message, position } from "./run-report.mjs";

const SCRIPT = fileURLToPath(new URL("./run-report.mjs", import.meta.url));
const FROM = { version: "1.3.1", commit: "7a030a8b0dcaa601bb0dda9aaf174affb3d61145", ahead: 5 };
const TO = { version: "1.4.0", commit: "49dd158d1076134a641b33efb035946536778336", ahead: 0 };
const CHANGELOG = [
  "## 1.4.0",
  "",
  "- BREAKING: `handoff` now needs a ticket number",
  "- New: `retro` looks back over a sprint",
  "",
  "## 1.3.2",
  "",
  "- Migration: move `~/.wayfinder` to `~/.config/wayfinder`",
  "- `grill-me` is deprecated in favour of `grilling`",
  "",
].join("\n");
const moved = (over = {}) => ({ id: "matt-pocock", from: FROM, to: TO, direction: "upgrade", changelog: CHANGELOG, ...over });
const config = () => ({ version: 1, sources: { "matt-pocock": { repo: "mattpocock/skills", ref: "main" }, pstack: { repo: "cursor/plugins", ref: "main", version: "0.15.15" } } });

test("an upgrade: the subject names the command and the moved ids; the body carries both positions, the changelog range, the lines flagged for /oneezy-migrate, the tool and the run", () => {
  const text = message({ command: "update", args: "matt-pocock", report: { updated: [moved()] }, toolVersion: "0.7.6", run: "https://github.com/oneezy/skills/actions/runs/1" });
  const [subject, blank, first] = text.split("\n");
  assert.equal(subject, "🔧 chore(repo): update matt-pocock");
  assert.equal(blank, "");
  assert.match(first, /^`update matt-pocock`, run by \.github\/workflows\/run\.yml with @oneezy\/skills-sync 0\.7\.6, moved 1 source and rebuilt the packages\.$/);
  assert.match(text, /\nmatt-pocock: 1\.3\.1 \(7a030a8, \+5\) → 1\.4\.0 \(49dd158\), upgrade\n/);
  assert.match(text, /\n  changelog after 1\.3\.1 up to 1\.4\.0:\n    ## 1\.4\.0\n\n    - BREAKING: `handoff` now needs a ticket number\n/);
  assert.match(text, /\nFlagged for \/oneezy-migrate \(3 lines\):\n  matt-pocock: - BREAKING: `handoff` now needs a ticket number\n  matt-pocock: - Migration: move `~\/\.wayfinder` to `~\/\.config\/wayfinder`\n  matt-pocock: - `grill-me` is deprecated in favour of `grilling`\n/);
  assert.match(text, /\nRun: https:\/\/github\.com\/oneezy\/skills\/actions\/runs\/1\n$/);
});

test("several sources: every id in the subject, in the report's order, each with its own block; a source with no changelog says why", () => {
  const text = message({
    command: "update",
    report: { updated: [moved(), moved({ id: "pstack", from: { version: "0.15.15", commit: "df58112", ahead: 0 }, to: { version: "0.15.15", commit: "0123456", ahead: 3 }, changelog: null, changelogReason: "no release between them (both 0.15.15)" })] },
  });
  assert.match(text, /^🔧 chore\(repo\): update matt-pocock, pstack\n/);
  assert.match(text, /moved 2 sources and rebuilt/);
  assert.match(text, /\npstack: 0\.15\.15 \(df58112\) → 0\.15\.15 \(0123456, \+3\), upgrade\n  changelog: none \(no release between them \(both 0\.15\.15\)\)\n/);
});

test("a downgrade undoes the changelog range, read from the higher side", () => {
  const text = message({ command: "update", args: "matt-pocock --to 1.3.1", report: { updated: [moved({ from: TO, to: FROM, direction: "downgrade" })] } });
  assert.match(text, /\nmatt-pocock: 1\.4\.0 \(49dd158\) → 1\.3\.1 \(7a030a8, \+5\), downgrade\n  undoes the changelog after 1\.3\.1 up to 1\.4\.0:\n/);
});

test("nothing flagged: the body says so in one line, and a changelog of only headings flags nothing", () => {
  const text = message({ command: "update", report: { updated: [moved({ changelog: "## 1.4.0\n\n- New: `retro`\n" })] } });
  assert.match(text, /\nFlagged for \/oneezy-migrate: nothing; no changelog line names a breaking change, a migration or a deprecation\.\n/);
  assert.deepEqual(flagged("## Breaking\n## Migration guide\n"), []);
  assert.deepEqual(flagged("- Deprecates x\n- BREAKING CHANGE: y\n- migrate z\n- plain\n"), ["- Deprecates x", "- BREAKING CHANGE: y", "- migrate z"]);
});

test("a long changelog is cut at 120 lines with a count of the rest", () => {
  const long = ["## 2.0.0", ...Array.from({ length: 200 }, (_, i) => `- change ${i}`)].join("\n");
  const text = message({ command: "update", report: { updated: [moved({ changelog: long, to: { ...TO, version: "2.0.0" } })] } });
  assert.match(text, /    - change 118\n    … 81 more lines in the upstream CHANGELOG\.md\n/);
  assert.ok(!text.includes("- change 119\n"));
});

test("a report that moved nothing is a rebuild of the packages alone; one with no report at all names the command and leaves the diff as the report", () => {
  const rebuild = message({ command: "update", report: { updated: [] }, toolVersion: "0.7.6" });
  assert.match(rebuild, /^🔧 chore\(repo\): rebuild plugins with skills-sync 0\.7\.6\n\n`update`, run by .*, moved no source; the packages it rebuilt differ from the committed ones, so this commit carries the rebuild alone\.\n/);
  const plain = message({ command: "rename", args: "old new", report: {}, run: "https://example.test/run/2" });
  assert.equal(plain, "🔧 chore(repo): rename old new\n\n`rename old new`, run by .github/workflows/run.yml with @oneezy/skills-sync, changed the library; the diff is the report.\n\nRun: https://example.test/run/2\n");
});

test("an add: the new source is new to the lock, with no position to compare", () => {
  const text = message({ command: "add", args: "mattpocock/skills --id probe", report: { updated: [moved({ id: "probe", from: null, changelog: null, changelogReason: "new to the lock: no version to compare with" })] } });
  assert.match(text, /^🔧 chore\(repo\): add probe\n/);
  assert.match(text, /\nprobe: \(new\) → 1\.4\.0 \(49dd158\), upgrade\n  changelog: none \(new to the lock: no version to compare with\)\n/);
  assert.equal(position(null), "(new)");
  assert.equal(position({ version: null, commit: "abcdef0123", ahead: null }), "no version (abcdef0)");
});

test("applyConfig writes a hold, removes one for null, says so per change, and leaves an unknown source and an unchanged hold alone", () => {
  const set = applyConfig(config(), [{ source: "matt-pocock", version: "1.3.0" }]);
  assert.equal(set.config.sources["matt-pocock"].version, "1.3.0");
  assert.deepEqual(set.lines, ['skills-sync.json: sources.matt-pocock.version = "1.3.0"']);
  const cleared = applyConfig(config(), [{ source: "pstack", version: null }]);
  assert.ok(!("version" in cleared.config.sources.pstack));
  assert.deepEqual(cleared.lines, ["skills-sync.json: removed sources.pstack.version (follows latest)"]);
  const same = applyConfig(config(), [{ source: "pstack", version: "0.15.15" }, { source: "matt-pocock", version: null }]);
  assert.deepEqual(same.lines, []);
  assert.deepEqual(same.config, config());
  assert.deepEqual(applyConfig(config(), [{ source: "nope", version: "1.0.0" }]).lines, ["skills-sync.json: no source nope; its hold is not written"]);
  assert.deepEqual(applyConfig(config(), undefined).lines, []);
});

test("the CLI: apply-config rewrites skills-sync.json (2-space JSON, trailing newline) and message names the hold against the committed config and writes --out", () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "run-report-"));
  const git = (...a) => execFileSync("git", ["-C", lib, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  fs.writeFileSync(path.join(lib, "skills-sync.json"), JSON.stringify(config(), null, 2) + "\n");
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  const report = path.join(lib, "..", `run-report-${process.pid}.json`);
  fs.writeFileSync(report, JSON.stringify({ updated: [moved({ to: { ...FROM, ahead: 0 }, from: TO, direction: "downgrade" })], config: [{ source: "matt-pocock", version: "1.3.1" }] }));
  const applied = execFileSync(process.execPath, [SCRIPT, "apply-config", lib, report], { encoding: "utf8" });
  assert.equal(applied, 'skills-sync.json: sources.matt-pocock.version = "1.3.1"\n');
  const written = fs.readFileSync(path.join(lib, "skills-sync.json"), "utf8");
  assert.equal(JSON.parse(written).sources["matt-pocock"].version, "1.3.1");
  assert.ok(written.endsWith("}\n") && written.includes('\n  "sources": {\n'));
  const out = path.join(lib, "..", `run-report-${process.pid}.message`);
  const printed = execFileSync(process.execPath, [SCRIPT, "message", lib, report, "--command", "update", "--args", "matt-pocock --to 1.3.1", "--tool-version", "0.7.6", "--out", out], { encoding: "utf8" });
  assert.equal(printed, fs.readFileSync(out, "utf8"));
  assert.match(printed, /\nConfig:\n  skills-sync\.json: sources\.matt-pocock\.version = "1\.3\.1"\n/);
  assert.match(printed, /^🔧 chore\(repo\): update matt-pocock\n/);
  fs.rmSync(report);
  fs.rmSync(out);
});

test("the CLI refuses a bad mode or a message without --command with usage and exit 2", () => {
  for (const args of [["nope", ".", "x.json"], ["message", ".", "x.json"], ["apply-config"]]) {
    assert.throws(() => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), (e) => e.status === 2 && /usage: run-report\.mjs/.test(e.stderr));
  }
});
