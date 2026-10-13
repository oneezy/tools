// The global block's text is the tool's own pointer (oneezy/tools#205): load /oneezy-agents at session start and
// follow what it loads, plus the invocation table. It no longer comes from the library: a release's SHARED.md is never
// read, and GitHub out of reach writes the same block. The start marker is stamped `built-in` with the sha256 of the
// text. A file whose content changes is copied beside itself first (CLAUDE-backup-<UTC stamp>.md, AGENTS-backup-<UTC
// stamp>.md), never over an earlier backup. status tells a current block from a stale one (an older tool's text or a
// release's SHARED.md) and a hand-edited one (its text no longer hashes to its stamp). The CLI runs as a process on the
// pretend machine against a fake GitHub of its own per test; the tests assert the files, the printed lines, --json,
// the exit codes and GitHub's requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { BLOCK_BODY } from "../src/block.js";
import { fixtureLibrary, startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  destroy,
  globalBlock,
  globalFile,
  pretendMachine,
  snapshot,
  write,
  type PretendMachine,
} from "./machine.js";

const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
const END = "<!-- skills-sync:skills:end -->";
const SHARED_17 = "# How Justin works\n\nEvery repo, every session.\n";
const BACKUP = /^(CLAUDE|AGENTS)-backup-\d{8}-\d{6}(-\d+)?\.md$/;
const DOWN = { SKILLS_SYNC_GITHUB_API: "http://127.0.0.1:9" };
/** The 0.15.0 built-in text, stamped `built-in` by that tool: an older tool's block. */
const OLD_BUILT_IN = "## Skills\n\nCall a skill the harness's way.\n\n## Brain\n\nLoad /oneezy-brain.\n";

const servers: FakeGithub[] = [];
const machines: PretendMachine[] = [];

afterEach(async () => {
  for (const m of machines.splice(0)) destroy(m);
  for (const gh of servers.splice(0)) await gh.close();
});

/** A fake GitHub whose latest release (release-17) carries SHARED.md at its commit: the tool must not read it. */
async function library(): Promise<FakeGithub> {
  const fixture = fixtureLibrary();
  fixture.contents![fixture.releases[1].commit]["SHARED.md"] = SHARED_17;
  const gh = await startFakeGithub(fixture);
  servers.push(gh);
  return gh;
}

/** Both harness folders, only the fake claude on PATH (no codex: its form would install plugins; not the subject here). */
function machine(gh: FakeGithub | null): PretendMachine {
  const m = pretendMachine({ github: gh, clis: ["claude"] });
  machines.push(m);
  return m;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (file: string) => fs.readFileSync(file, "utf8");
const lines = (text: string) => text.trimEnd().split("\n").filter(Boolean);
/** A block as a tool writes it for a text and its stamp, LF line endings. */
const block = (stamp: string, text: string) =>
  `<!-- skills-sync:skills:start ${stamp} sha256:${hash(text)} -->\n${text}${END}`;
/** The block this tool writes. */
const POINTER = block("built-in", `${BLOCK_BODY}\n`);
/** The backups beside a global file, by name. */
const backups = (file: string) =>
  fs
    .readdirSync(path.dirname(file))
    .filter((n) => BACKUP.test(n))
    .sort();
const files = (m: PretendMachine) => [globalFile(m, "claude-code"), globalFile(m, "codex")];

interface ActionJson {
  kind: string;
  path: string;
  note?: string;
  backup?: string;
}

test("the pointer names /oneezy-agents and keeps the invocation table", () => {
  assert.match(BLOCK_BODY, /At the start of every session, load the `\/oneezy-agents` skill and follow what it loads/);
  assert.match(BLOCK_BODY, /\| Claude Code \| `\/<plugin>:<skill>`/);
  assert.match(BLOCK_BODY, /Never fetch a `SKILL\.md` from GitHub/);
  assert.doesNotMatch(BLOCK_BODY, /SHARED\.md/);
});

test("a fresh machine gets the pointer in both global files, stamped built-in, and no backup; the release's SHARED.md is never read", async () => {
  const gh = await library();
  const m = machine(gh);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(m)) {
    assert.equal(read(file), `${POINTER}\n`);
    assert.deepEqual(backups(file), []);
  }
  assert.ok(!r.requests.some((q) => q.path.includes("SHARED.md")), JSON.stringify(r.requests.map((q) => q.path)));
  const writes = lines(r.stdout).filter((l) => l.startsWith("+ write") && /(CLAUDE|AGENTS)\.md/.test(l));
  assert.equal(writes.length, 2, r.stdout);
  assert.ok(
    writes.every((l) => l.includes("skills block (the pointer to /oneezy-agents)") && !l.includes("backup")),
    r.stdout,
  );
});

test("a repeat sync changes nothing and backs nothing up", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const before = snapshot(m.home);
  const again = await cli(m, ["--json"]);
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(snapshot(m.home), before);
  const skips = (again.json!.actions as ActionJson[]).filter((a) => /(CLAUDE|AGENTS)\.md$/.test(a.path));
  assert.deepEqual(
    skips.map((a) => [a.kind, a.note]),
    [
      ["skip", "skills block current"],
      ["skip", "skills block current"],
    ],
  );
  assert.deepEqual(again.json!.block, { stamp: "built-in", sha256: hash(`${BLOCK_BODY}\n`) });
});

test("an older block (a release's SHARED.md, the 0.15.0 built-in text, the brain block, the unstamped skills block) is replaced where it stands, after one backup", async () => {
  const gh = await library();
  const m = machine(gh);
  const claude = globalFile(m, "claude-code");
  write(claude, `# Mine\n\nAbove.\n\n${block("release-17", SHARED_17)}\n\nBelow.\n`);
  const codex = globalFile(m, "codex");
  write(codex, `codex rules\n\n${block("built-in", OLD_BUILT_IN)}\n`);
  const was = [read(claude), read(codex)];
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(claude), `# Mine\n\nAbove.\n\n${POINTER}\n\nBelow.\n`);
  assert.equal(read(codex), `codex rules\n\n${POINTER}\n`);
  [claude, codex].forEach((file, i) => {
    assert.equal(backups(file).length, 1, file);
    assert.equal(read(path.join(path.dirname(file), backups(file)[0])), was[i]);
  });
  assert.equal(
    lines(r.stdout).filter((l) => l.includes("skills block updated to the pointer to /oneezy-agents")).length,
    2,
    r.stdout,
  );
  const m2 = machine(gh);
  globalBlock(m2, "claude-code", "brain", "## Brain\nLoad /oneezy-brain.");
  globalBlock(m2, "codex", "skills", "unstamped");
  const r2 = await cli(m2, []);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  for (const file of files(m2)) assert.equal(read(file), `${POINTER}\n`);
  assert.ok(r2.stdout.includes("skills block replaces brain (the pointer to /oneezy-agents)"), r2.stdout);
});

test("hand text outside the markers is kept byte for byte, CRLF files included", async () => {
  const gh = await library();
  const m = machine(gh);
  const claude = globalFile(m, "claude-code");
  const above = "# Mine\n\n<!-- a comment of mine -->\n```\n<!-- skills-sync:skills:start --> quoted\n```\n\n";
  const below = "\n\n## After\n\ttabs and trailing space   \nno final newline";
  write(claude, `${above}<!-- skills-sync:brain:start -->\nold\n<!-- skills-sync:brain:end -->${below}`);
  const codex = globalFile(m, "codex");
  write(codex, "top\r\n\r\n<!-- skills-sync:skills:start -->\r\nold\r\n<!-- skills-sync:skills:end -->\r\nbottom\r\n");
  const first = await cli(m, []);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(read(claude), `${above}${POINTER}${below}`);
  assert.equal(read(codex), `top\r\n\r\n${POINTER.replace(/\n/g, "\r\n")}\r\nbottom\r\n`);
  // the CRLF block's text hashes to its stamp once its line endings are read as LF: current, not hand-edited
  const status = await cli(m, ["status", "--json"]);
  assert.equal((status.json!.harnesses as Record<string, { block: { status: string } }>).codex.block.status, "current");
});

test("GitHub out of reach: the pointer is written all the same; in the cloud that is exit 0 and nothing red", async () => {
  const fresh = machine(null);
  const r = await cli(fresh, ["--quiet"], { ...CLOUD, ...DOWN });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(fresh)) assert.equal(read(file), `${POINTER}\n`);
  const out = lines(r.stdout);
  assert.equal(out.filter((l) => l.startsWith("+ write")).length, 2, r.stdout);
  assert.ok(
    out.every((l) => !l.startsWith("!")),
    r.stdout,
  );
  assert.equal(
    out.filter((l) => l.includes("latest release not read") && l.includes("the global block needs none")).length,
    1,
    r.stdout,
  );
  // status judges the block without GitHub: current, nothing red
  const s = await cli(fresh, ["status"], { ...CLOUD, ...DOWN });
  assert.equal(s.status, 0, s.stdout);
  assert.ok(s.stdout.includes(`= global block in ${globalFile(fresh, "claude-code")} current`), s.stdout);
  // a second offline start writes nothing
  const before = snapshot(fresh.home);
  const again = await cli(fresh, ["--quiet"], { ...CLOUD, ...DOWN });
  assert.equal(again.status, 0);
  assert.deepEqual(snapshot(fresh.home), before);
  // outside the cloud the release's red line is the plugins'; the block is current all the same
  const pc = await cli(fresh, ["--json"], DOWN);
  const about = (pc.json!.actions as ActionJson[]).filter((a) => /(CLAUDE|AGENTS)\.md$/.test(a.path));
  assert.deepEqual(
    about.map((a) => a.kind),
    ["skip", "skip"],
  );
});

test("status reads only and tells a current block from a stale and a hand-edited one, one line each", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const [claude, codex] = files(m);
  const current = await cli(m, ["status"]);
  assert.ok(current.stdout.includes(`= global block in ${claude} current\n`), current.stdout);
  // the Claude block is a release's SHARED.md (0.15.0 and older), the Codex one edited by hand
  write(claude, `${block("release-17", SHARED_17)}\n`);
  write(codex, read(codex).replace("At the start of every session", "Whenever you like"));
  const edited = snapshot(m.home);
  const r = await cli(m, ["status"]);
  assert.equal(r.status, 1, r.stdout);
  const blockLines = lines(r.stdout).filter((l) => l.includes("global block"));
  assert.deepEqual(blockLines, [
    `! global block in ${claude} is stale (release-17 SHARED.md text; this tool writes the pointer to /oneezy-agents); run sync`,
    `! global block in ${codex} is hand-edited (its text no longer matches its built-in stamp); run sync to restore it, a backup is made first`,
  ]);
  const j = await cli(m, ["status", "--json"]);
  const h = j.json!.harnesses as Record<string, { block: Record<string, unknown> }>;
  assert.deepEqual(h["claude-code"].block, {
    file: claude,
    present: true,
    current: false,
    // the --json value predates the word in the line, and its keys are stable
    status: "outdated",
    ids: ["skills"],
    stamp: { release: "release-17", sha256: hash(SHARED_17) },
    latest: { release: "built-in", sha256: hash(`${BLOCK_BODY}\n`) },
  });
  assert.equal(h.codex.block.status, "hand-edited");
  // read only: nothing written, GitHub only read
  assert.deepEqual(snapshot(m.home), edited);
  assert.ok(r.requests.every((q) => q.method === "GET"));
  // sync restores both, each after its one backup
  await cli(m, []);
  const after = await cli(m, ["status"]);
  assert.deepEqual(
    lines(after.stdout).filter((l) => l.includes("global block")),
    [`= global block in ${claude} current`, `= global block in ${codex} current`],
  );
  assert.equal(backups(codex).length, 1);
  assert.ok(read(path.join(path.dirname(codex), backups(codex)[0])).includes("Whenever you like"));
});

test("--plan shows the change and its backup and writes nothing, no backup either", async () => {
  const gh = await library();
  const m = machine(gh);
  write(globalFile(m, "claude-code"), "# Mine\n");
  const before = snapshot(m.home);
  const r = await cli(m, ["--plan", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  const writes = (r.json!.actions as ActionJson[]).filter(
    (a) => a.kind === "write" && /(CLAUDE|AGENTS)\.md$/.test(a.path),
  );
  assert.equal(writes.length, 2);
  // the existing file would be backed up first; the new one has nothing to back up
  assert.match(path.basename(writes[0].backup ?? ""), BACKUP);
  assert.equal(writes[1].backup, undefined);
  const text = await cli(m, ["--plan"]);
  assert.deepEqual(snapshot(m.home), before);
  assert.ok(
    lines(text.stdout).some((l) => l.includes(globalFile(m, "claude-code")) && l.includes("backup")),
    text.stdout,
  );
});

test("unlink takes out only the stamped block: the text around it stays, after a backup", async () => {
  const gh = await library();
  const m = machine(gh);
  const claude = globalFile(m, "claude-code");
  write(claude, "# Mine\n");
  await cli(m, []);
  const synced = read(claude);
  assert.equal(backups(claude).length, 1);
  const r = await cli(m, ["unlink"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(claude), "# Mine\n");
  assert.equal(backups(claude).length, 2);
  assert.ok(backups(claude).some((b) => read(path.join(path.dirname(claude), b)) === synced));
  // the Codex file held nothing else: it goes, and there is nothing of the user's to back up
  assert.equal(fs.existsSync(globalFile(m, "codex")), false);
  assert.deepEqual(backups(globalFile(m, "codex")), []);
});

test("sync deletes a temp file a run left beside the global file over a minute ago, under --plan only names it", async () => {
  const gh = await library();
  const m = machine(gh);
  assert.equal((await cli(m, ["--quiet"])).status, 0);
  const file = globalFile(m, "claude-code");
  const left = `${file}.skills-sync.4242.0a1b2c3d.tmp`;
  fs.writeFileSync(left, "half a block\n");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(left, old, old);
  const plan = await cli(m, ["--plan", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  const del = (plan.json as { actions: Array<{ kind: string; path: string }> }).actions.filter(
    (a) => a.kind === "delete",
  );
  assert.deepEqual(
    del.map((a) => a.path),
    [left],
  );
  assert.ok(fs.existsSync(left));
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(left), r.stdout);
  assert.ok(r.stdout.includes(left), r.stdout);
});
