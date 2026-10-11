// The global block's text comes from the library: SHARED.md at the commit of the latest release, the one the plugins
// come from, written verbatim between the block markers, the start marker stamped with the release and the sha256 of
// the text. A file whose content changes is copied beside itself first (CLAUDE-backup-<UTC stamp>.md,
// AGENTS-backup-<UTC stamp>.md), never over an earlier backup. GitHub or SHARED.md out of reach keeps the block as it
// is, one line and no conflict; a release without SHARED.md gets the tool's built-in text. status tells a current block
// from a stale one (another release's text) and a hand-edited one (its text no longer hashes to its stamp). The CLI
// runs as a process on the pretend machine against a fake GitHub of its own per test; the tests assert the files, the
// printed lines, --json, the exit codes and GitHub's requests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { BLOCK_BODY } from "../src/block.js";
import {
  fixtureConfig,
  fixtureLibrary,
  fixtureRelease,
  sha,
  startFakeGithub,
  type FakeGithub,
} from "./fixtures/fake-github/fake-github.mjs";
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
const SHARED_17 = "# How Justin works\n\nEvery repo, every session.\n\n## Skills\n\nCall a skill the harness's way.\n";
const SHARED_19 = "# How Justin works\n\nEvery repo, every session, now with release 19.\n";
const BACKUP = /^(CLAUDE|AGENTS)-backup-\d{8}-\d{6}(-\d+)?\.md$/;

const servers: FakeGithub[] = [];
const machines: PretendMachine[] = [];

afterEach(async () => {
  for (const m of machines.splice(0)) destroy(m);
  for (const gh of servers.splice(0)) await gh.close();
});

/** A fake GitHub whose latest release (release-17) carries `shared` as SHARED.md at its commit; null: no SHARED.md. */
async function library(shared: string | null = SHARED_17): Promise<FakeGithub> {
  const fixture = fixtureLibrary();
  const r17 = fixture.releases[1];
  if (shared !== null) fixture.contents![r17.commit]["SHARED.md"] = shared;
  const gh = await startFakeGithub(fixture);
  servers.push(gh);
  return gh;
}

/** Cut release-<n> on the fake GitHub, its plugins release-17's, with `shared` as its SHARED.md. */
function cut(gh: FakeGithub, n: number, shared: string): void {
  const commit = sha(String(n % 10));
  gh.addRelease(
    fixtureRelease({
      number: n,
      previous: `release-${n - 1}`,
      commit,
      plugins: {
        oneezy: { version: "0.43.1", skills: ["oneezy-merge", "oneezy-status"] },
        "matt-pocock": { version: "1.3.1", skills: ["grilling", "tdd"] },
        play: { version: "0.43.0", skills: ["play-unslop"] },
      },
    }),
  );
  gh.fixture.contents![commit] = { "skills-sync.json": fixtureConfig(), "SHARED.md": shared };
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
/** The block as sync writes it for a text and its release, LF line endings. */
const block = (release: string, text: string) =>
  `<!-- skills-sync:skills:start ${release} sha256:${hash(text)} -->\n${text}${END}`;
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

test("a fresh machine gets SHARED.md of the latest release in both global files, stamped with the release and the text's sha256, and no backup", async () => {
  const gh = await library();
  const m = machine(gh);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(m)) {
    assert.equal(read(file), `${block("release-17", SHARED_17)}\n`);
    assert.deepEqual(backups(file), []);
  }
  // read from the release's own commit, the one its plugins come from
  assert.ok(
    r.requests.some((q) => q.path === `/repos/oneezy/skills/contents/SHARED.md?ref=${gh.fixture.releases[1].commit}`),
    JSON.stringify(r.requests.map((q) => q.path)),
  );
  const writes = lines(r.stdout).filter((l) => l.startsWith("+ write") && /(CLAUDE|AGENTS)\.md/.test(l));
  assert.equal(writes.length, 2, r.stdout);
  assert.ok(
    writes.every((l) => l.includes("skills block (release-17 SHARED.md)") && !l.includes("backup")),
    r.stdout,
  );
});

test("a repeat sync changes nothing and backs nothing up; a release with the same SHARED.md is no change either", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const before = snapshot(m.home);
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(lines(again.stdout).at(-1), "0 changed, 4 already right, 0 left alone");
  // release-18 carries the very same text: the block (stamped release-17) is current, nothing is rewritten
  cut(gh, 18, SHARED_17);
  const same = await cli(m, ["--json"]);
  assert.equal(same.status, 0, same.stdout);
  assert.deepEqual(snapshot(m.home), before);
  const skips = (same.json!.actions as ActionJson[]).filter((a) => /(CLAUDE|AGENTS)\.md$/.test(a.path));
  assert.deepEqual(
    skips.map((a) => [a.kind, a.note]),
    [
      ["skip", "skills block current"],
      ["skip", "skills block current"],
    ],
  );
  const status = await cli(m, ["status", "--json"]);
  for (const id of ["claude-code", "codex"]) {
    const b = (status.json!.harnesses as Record<string, { block: Record<string, unknown> }>)[id].block;
    assert.equal(b.status, "current", JSON.stringify(b));
  }
});

test("a changed SHARED.md reaches every global file with exactly one backup each, named in one line; the next run makes none", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const was = files(m).map(read);
  cut(gh, 19, SHARED_19);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  files(m).forEach((file, i) => {
    assert.equal(read(file), `${block("release-19", SHARED_19)}\n`);
    const [backup, ...more] = backups(file);
    assert.deepEqual(more, [], file);
    assert.ok(backup.startsWith(path.basename(file, ".md") + "-backup-"), backup);
    // the backup is the file as it was, byte for byte
    assert.equal(read(path.join(path.dirname(file), backup)), was[i]);
    // and the write's line names it
    const line = lines(r.stdout).find((l) => l.startsWith("+ write") && l.includes(file));
    assert.ok(line?.includes(`backup ${path.join(path.dirname(file), backup)}`), r.stdout);
  });
  const before = snapshot(m.home);
  const again = await cli(m, []);
  assert.equal(again.status, 0, again.stdout);
  assert.deepEqual(snapshot(m.home), before);
});

test("an old block (the brain block, or the unstamped skills block) is replaced where it stands, after one backup; the text around it stays byte for byte", async () => {
  const gh = await library();
  const m = machine(gh);
  const claude = globalFile(m, "claude-code");
  write(claude, "# Mine\n\nAbove.\n\n");
  globalBlock(m, "claude-code", "brain", "## Brain\nLoad /oneezy-brain.");
  fs.appendFileSync(claude, "\nBelow.\n");
  const codex = globalFile(m, "codex");
  write(codex, "codex rules\n\n");
  globalBlock(m, "codex", "skills", BLOCK_BODY);
  const was = [read(claude), read(codex)];
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read(claude), `# Mine\n\nAbove.\n\n${block("release-17", SHARED_17)}\n\nBelow.\n`);
  assert.equal(read(codex), `codex rules\n\n${block("release-17", SHARED_17)}\n`);
  [claude, codex].forEach((file, i) => {
    assert.equal(backups(file).length, 1, file);
    assert.equal(read(path.join(path.dirname(file), backups(file)[0])), was[i]);
  });
  assert.ok(r.stdout.includes("skills block replaces brain (release-17 SHARED.md"), r.stdout);
  assert.ok(r.stdout.includes("skills block updated to release-17 SHARED.md"), r.stdout);
});

test("hand text outside the markers is kept byte for byte through a migration and an update, CRLF files included", async () => {
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
  assert.equal(read(claude), `${above}${block("release-17", SHARED_17)}${below}`);
  const crlf = block("release-17", SHARED_17).replace(/\n/g, "\r\n");
  assert.equal(read(codex), `top\r\n\r\n${crlf}\r\nbottom\r\n`);
  // the CRLF block's text hashes to its stamp once its line endings are read as LF: current, not hand-edited
  const status = await cli(m, ["status", "--json"]);
  assert.equal((status.json!.harnesses as Record<string, { block: { status: string } }>).codex.block.status, "current");
  cut(gh, 19, SHARED_19);
  const second = await cli(m, []);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(read(claude), `${above}${block("release-19", SHARED_19)}${below}`);
  assert.equal(read(codex), `top\r\n\r\n${block("release-19", SHARED_19).replace(/\n/g, "\r\n")}\r\nbottom\r\n`);
});

test("GitHub out of reach: every block is kept as it is, one line says so; in the cloud that is exit 0 and the one line even under --quiet", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const before = snapshot(m.home);
  const down = { SKILLS_SYNC_GITHUB_API: "http://127.0.0.1:9" };
  const cloud = await cli(m, ["--quiet"], { ...CLOUD, ...down });
  assert.equal(cloud.status, 0, cloud.stdout + cloud.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.equal(cloud.stderr, "");
  const only = lines(cloud.stdout);
  assert.equal(only.length, 1, cloud.stdout);
  assert.match(only[0], /^\. note\s+SHARED\.md {2}\(not read: .*; every global block kept as it is\)$/);
  // outside the cloud the block's line is a note too, never a conflict; the release's own red line is the plugins'
  const pc = await cli(m, ["--json"], down);
  assert.deepEqual(snapshot(m.home), before);
  const actions = pc.json!.actions as ActionJson[];
  const about = actions.filter((a) => a.path === "SHARED.md" || /(CLAUDE|AGENTS)\.md$/.test(a.path));
  assert.deepEqual(
    about.map((a) => a.kind),
    ["note"],
  );
  // a fresh machine with GitHub down gets no block at all, rather than a text the next sync would back up and replace
  const fresh = machine(null);
  const r = await cli(fresh, ["--quiet"], CLOUD);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(fresh)) assert.equal(fs.existsSync(file), false, file);
  assert.equal(lines(r.stdout).length, 1, r.stdout);
});

test("SHARED.md alone failing (GitHub answers 500 for it) keeps the blocks, one note line, exit 0", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const before = snapshot(m.home);
  cut(gh, 19, SHARED_19);
  gh.fixture.failures = { "/repos/oneezy/skills/contents/SHARED.md": 500 };
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  const notes = lines(r.stdout).filter((l) => l.includes("SHARED.md"));
  assert.equal(notes.length, 1, r.stdout);
  assert.match(notes[0], /^\. note\s+SHARED\.md {2}\(not read: .*500.*; every global block kept as it is\)$/);
  assert.ok(!lines(r.stdout).some((l) => l.startsWith("!")), r.stdout);
  // status says so too, without calling the block stale or current
  const s = await cli(m, ["status", "--json"]);
  const b = (s.json!.harnesses as Record<string, { block: { status: string } }>)["claude-code"].block;
  assert.equal(b.status, "unknown");
});

test("a release without SHARED.md (an older release) gets the tool's built-in text, stamped with that release", async () => {
  const gh = await library(null);
  const m = machine(gh);
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(m)) assert.equal(read(file), `${block("release-17", `${BLOCK_BODY}\n`)}\n`);
  assert.ok(r.stdout.includes("skills block (built-in text; release-17 has no SHARED.md)"), r.stdout);
  const s = await cli(m, ["status"]);
  assert.ok(s.stdout.includes(`= global block in ${globalFile(m, "codex")} current`), s.stdout);
  // the library adds SHARED.md in a later release: it replaces the built-in text, after a backup
  cut(gh, 19, SHARED_19);
  await cli(m, []);
  for (const file of files(m)) {
    assert.equal(read(file), `${block("release-19", SHARED_19)}\n`);
    assert.equal(backups(file).length, 1);
  }
});

test("status reads only and tells a current block from a stale and a hand-edited one, one line each", async () => {
  const gh = await library();
  const m = machine(gh);
  await cli(m, []);
  const [claude, codex] = files(m);
  const before = snapshot(m.home);
  const current = await cli(m, ["status"]);
  assert.ok(current.stdout.includes(`= global block in ${claude} current\n`), current.stdout);
  // a new release with another SHARED.md: both blocks are stale
  cut(gh, 19, SHARED_19);
  // and the Codex block edited by hand: hand-edited wins over stale, the stamp no longer covers the text
  write(codex, read(codex).replace("Every repo, every session.", "Every repo, my way."));
  const edited = snapshot(m.home);
  const r = await cli(m, ["status"]);
  assert.equal(r.status, 1, r.stdout);
  const blockLines = lines(r.stdout).filter((l) => l.includes("global block"));
  assert.deepEqual(blockLines, [
    `! global block in ${claude} is stale (release-17 text; release-19 has another SHARED.md); run sync`,
    `! global block in ${codex} is hand-edited (its text no longer matches its release-17 stamp); run sync to restore it, a backup is made first`,
  ]);
  const j = await cli(m, ["status", "--json"]);
  const h = j.json!.harnesses as Record<string, { block: Record<string, unknown> }>;
  assert.deepEqual(h["claude-code"].block, {
    file: claude,
    present: true,
    current: false,
    status: "stale",
    ids: ["skills"],
    stamp: { release: "release-17", sha256: hash(SHARED_17) },
    latest: { release: "release-19", sha256: hash(SHARED_19) },
  });
  assert.equal(h.codex.block.status, "hand-edited");
  // read only: nothing written, GitHub only read
  assert.deepEqual(snapshot(m.home), edited);
  assert.ok(r.requests.every((q) => q.method === "GET"));
  assert.notDeepEqual(edited, before);
  // sync restores both, each after its one backup
  await cli(m, []);
  const after = await cli(m, ["status"]);
  assert.deepEqual(
    lines(after.stdout).filter((l) => l.includes("global block")),
    [`= global block in ${claude} current`, `= global block in ${codex} current`],
  );
  assert.equal(backups(codex).length, 1);
  assert.ok(read(path.join(path.dirname(codex), backups(codex)[0])).includes("Every repo, my way."));
});

test("in the cloud, sync writes SHARED.md as the whole sync and status judges the block against it", async () => {
  const gh = await library();
  const m = machine(gh);
  const r = await cli(m, ["--quiet"], CLOUD);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of files(m)) assert.equal(read(file), `${block("release-17", SHARED_17)}\n`);
  cut(gh, 19, SHARED_19);
  const s = await cli(m, ["status"], CLOUD);
  assert.equal(s.status, 1, s.stdout);
  assert.ok(s.stdout.includes("is stale (release-17 text; release-19 has another SHARED.md)"), s.stdout);
  // GitHub down in the cloud: the block is not judged, a note, and no red line for it
  const down = await cli(m, ["status"], { ...CLOUD, SKILLS_SYNC_GITHUB_API: "http://127.0.0.1:9" });
  assert.equal(down.status, 0, down.stdout);
  assert.ok(
    lines(down.stdout).some((l) => l.startsWith(". global block in") && l.includes("not compared")),
    down.stdout,
  );
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
