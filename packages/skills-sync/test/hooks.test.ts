// The session hook (ADR-0010) as sync writes it on the pretend machine: one entry per harness in Claude Code's
// settings.json and Codex's hooks.json, known by its command; every other entry and key byte for byte as it was; the old
// sync-dev.sh entry gone only once the new one is in; Codex's trust read from config.toml and the manual step named
// while it is missing; --plan writes nothing. The CLI runs as a process against the fake GitHub; the assertions are on
// the files, the printed lines, --json and exit codes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, test } from "vite-plus/test";
import { CODEX_TRUST_STEP, HOOK_COMMAND } from "../src/hooks.js";
import { startFakeGithub, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";
import {
  cli,
  codexTrust,
  destroy,
  hookEntry,
  hooksFile,
  names,
  pretendMachine,
  snapshot,
  write,
  type PretendMachine,
} from "./machine.js";

interface ActionJson {
  kind: string;
  path: string;
  note?: string;
}

const CLOUD = { CLAUDE_CODE_REMOTE: "true" };
const OWN_CLAUDE = { matcher: "startup|resume", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 120 }] };
const OWN_CODEX = {
  matcher: "startup|resume",
  hooks: [{ type: "command", command: HOOK_COMMAND, statusMessage: "Skills Sync", timeout: 120 }],
};
const OLD = 'bash "$HOME/.claude/hooks/sync-dev.sh"';

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

/**
 * A machine with both harness folders, the fake claude on PATH and no codex: these tests are about the hook entries,
 * and with a codex on PATH the sync would also install Codex's plugins from GitHub (test/codex-form.test.ts covers it).
 */
function machine(options: Parameters<typeof pretendMachine>[0] = {}): PretendMachine {
  const m = pretendMachine({ github: gh, clis: ["claude"], ...options });
  machines.push(m);
  return m;
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const parse = (file: string) => JSON.parse(read(file)) as { hooks: { SessionStart: unknown[] } };
const lines = (text: string) => text.trimEnd().split("\n");
/** The action lines about `file`: `+ write  <file>  (<note>)`. */
const about = (text: string, file: string) => lines(text).filter((l) => l.includes(path.basename(file)));
const actions = (json: Record<string, unknown> | null, file: string) =>
  (json!.actions as ActionJson[]).filter((a) => a.path === file).map((a) => [a.kind, a.note]);

test("sync writes one session hook entry per harness, in the shape each harness reads; a second sync adds none and says the hook is current", async () => {
  const m = machine();
  const claude = hooksFile(m, "claude-code");
  const codex = hooksFile(m, "codex");
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parse(claude).hooks.SessionStart, [OWN_CLAUDE]);
  assert.deepEqual(parse(codex).hooks.SessionStart, [OWN_CODEX]);
  // a new file is written the way the harnesses write theirs: two spaces, a trailing newline
  for (const file of [claude, codex]) {
    assert.equal(read(file), JSON.stringify(JSON.parse(read(file)), null, 2) + "\n");
    assert.ok(
      about(r.stdout, file).some((l) => l.startsWith("+ write") && l.endsWith("(session hook)")),
      r.stdout,
    );
  }
  const texts = [read(claude), read(codex)];
  const again = await cli(m, ["--json"]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual([read(claude), read(codex)], texts);
  assert.deepEqual(actions(again.json, claude), [["skip", "session hook current"]]);
  assert.deepEqual(actions(again.json, codex), [
    ["skip", "session hook current"],
    ["note", CODEX_TRUST_STEP],
  ]);
});

test("the tool knows its entry by its command, whatever the version suffix, the npx flag or its place in the list: no second entry", async () => {
  const m = machine();
  const claude = hookEntry(m, "claude-code", "npx -y @oneezy/skills-sync@0.8.0 hook");
  hookEntry(m, "codex", 'echo "first"');
  const codex = hookEntry(m, "codex", "npx --yes @oneezy/skills-sync hook", {
    hooks: [{ type: "command", command: "npx --yes @oneezy/skills-sync hook" }],
  });
  const texts = [read(claude), read(codex)];
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([read(claude), read(codex)], texts);
  assert.deepEqual(actions(r.json, claude), [["skip", "session hook current"]]);
  assert.equal(parse(codex).hooks.SessionStart.length, 2);
});

test("every other entry and key stays byte for byte: a foreign SessionStart group, another event, custom keys, the file's own indentation, line endings and missing trailing newline", async () => {
  const m = machine();
  const claude = hooksFile(m, "claude-code");
  const codex = hooksFile(m, "codex");
  const claudeDoc = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow: ["Bash(git fetch *)", "Bash(gh api *)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine", timeout: 5 }] }],
    },
    theme: "dark",
  };
  // four spaces, CRLF, no trailing newline
  write(claude, JSON.stringify(claudeDoc, null, 4).replace(/\n/g, "\r\n"));
  const codexDoc = {
    description: "my hooks",
    hooks: {
      SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "echo codex", timeout: 9 }] }],
      Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
    },
  };
  // tabs, a trailing newline
  write(codex, JSON.stringify(codexDoc, null, "\t") + "\n");
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  const expectedClaude = structuredClone(claudeDoc);
  expectedClaude.hooks.SessionStart.push(OWN_CLAUDE);
  assert.equal(read(claude), JSON.stringify(expectedClaude, null, 4).replace(/\n/g, "\r\n"));
  const expectedCodex = structuredClone(codexDoc);
  expectedCodex.hooks.SessionStart.push(OWN_CODEX);
  assert.equal(read(codex), JSON.stringify(expectedCodex, null, "\t") + "\n");
  // the foreign group kept its place (Codex trusts a hook by its index); ours is last
  assert.equal((parse(codex).hooks.SessionStart[0] as { hooks: { command: string }[] }).hooks[0].command, "echo codex");
});

test("the old sync-dev.sh entry goes in the same run, after the new entry was written and read back; a foreign handler in its group stays, a group of its own goes", async () => {
  const m = machine();
  // Claude Code: the old handler shares a group with another one, and a foreign group follows
  const claude = hookEntry(m, "claude-code", OLD, {
    matcher: "startup|resume",
    hooks: [
      { type: "command", command: OLD, timeout: 30 },
      { type: "command", command: "echo keep-me" },
    ],
  });
  hookEntry(m, "claude-code", "echo foreign");
  // Codex: the old handler alone in its group
  const codex = hookEntry(m, "codex", OLD);
  const r = await cli(m, ["--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(actions(r.json, claude), [
    ["write", "session hook"],
    ["write", "old sync-dev.sh hook removed"],
  ]);
  assert.deepEqual(parse(claude).hooks.SessionStart, [
    { matcher: "startup|resume", hooks: [{ type: "command", command: "echo keep-me" }] },
    { matcher: "startup|resume", hooks: [{ type: "command", command: "echo foreign", timeout: 30 }] },
    OWN_CLAUDE,
  ]);
  assert.deepEqual(parse(codex).hooks.SessionStart, [OWN_CODEX]);
  assert.ok(!read(claude).includes("sync-dev.sh") && !read(codex).includes("sync-dev.sh"));
  // the next run has nothing to do
  const again = await cli(m, ["--json"]);
  assert.deepEqual(actions(again.json, claude), [["skip", "session hook current"]]);
});

test("a hooks file that is not valid JSON, or whose SessionStart is not a list, is a conflict: nothing written, the old entry kept, the other harness still served, exit 1", async () => {
  const m = machine();
  const claude = hooksFile(m, "claude-code");
  const codex = hooksFile(m, "codex");
  const broken = `{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "${OLD}" } ] } ] }`;
  write(claude, broken);
  const r = await cli(m, []);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(read(claude), broken);
  const reds = lines(r.stdout).filter((l) => l.startsWith("!"));
  assert.equal(reds.length, 1, r.stdout);
  assert.ok(reds[0].includes("settings.json") && reds[0].includes("not valid JSON; left alone"), reds[0]);
  assert.deepEqual(parse(codex).hooks.SessionStart, [OWN_CODEX]);
  // the --json shows the conflict and no write for that file
  const j = await cli(m, ["--json"]);
  assert.deepEqual(actions(j.json, claude), [["conflict", "not valid JSON; left alone"]]);
  // a list that is not a list
  write(codex, JSON.stringify({ hooks: { SessionStart: { matcher: "startup" } } }, null, 2) + "\n");
  const text = read(codex);
  const k = await cli(m, ["--json"]);
  assert.equal(k.status, 1, k.stderr);
  assert.equal(read(codex), text);
  assert.deepEqual(actions(k.json, codex), [["conflict", "hooks.SessionStart is not a list; left alone"]]);
});

test("Codex: an untrusted entry is a note with the manual step; trust recorded in config.toml for its position silences it, trust for another position does not; config.toml is never written", async () => {
  const m = machine();
  const codex = hooksFile(m, "codex");
  const config = path.join(m.codexHome, "config.toml");
  hookEntry(m, "codex", "echo first");
  const r = await cli(m, []);
  assert.equal(r.status, 0, r.stderr);
  const note = lines(r.stdout).filter((l) => l.startsWith(". note") && l.includes("hooks.json"));
  assert.equal(note.length, 1, r.stdout);
  assert.ok(note[0].includes("Codex hook needs trust") && note[0].includes("press t"), note[0]);
  assert.ok(!lines(r.stdout).some((l) => l.includes("settings.json") && l.includes("trust")), r.stdout);
  assert.equal(fs.existsSync(config), false);
  // ours is the second group: trust at index 0 is the first group's, not ours
  codexTrust(m, 0);
  const still = await cli(m, ["--json"]);
  assert.deepEqual(actions(still.json, codex), [
    ["skip", "session hook current"],
    ["note", CODEX_TRUST_STEP],
  ]);
  codexTrust(m, 1);
  const toml = read(config);
  const trusted = await cli(m, ["--json"]);
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.deepEqual(actions(trusted.json, codex), [["skip", "session hook current"]]);
  assert.equal(read(config), toml);
  assert.ok(!trusted.stdout.includes("needs trust"), trusted.stdout);
  // the other shapes Codex could write the same record in are read too; a record for another position is not
  const key = (group: number) => `${codex.replace(/\\/g, "\\\\")}:session_start:${group}:0`;
  const hash = `"sha256:${"cd".repeat(32)}"`;
  const forms = (g: number) => [
    `[hooks.state]\n"${key(g)}".trusted_hash = ${hash}\n`,
    `[hooks.state]\n"${key(g)}" = { trusted_hash = ${hash} }\n`,
    `[hooks]\nstate."${key(g)}".trusted_hash = ${hash}\n`,
    `[hooks]\nstate."${key(g)}" = { trusted_hash = ${hash} }\n`,
    `hooks.state."${key(g)}".trusted_hash = ${hash}\n`,
  ];
  for (const [g, want] of [
    [1, [["skip", "session hook current"]]],
    [
      0,
      [
        ["skip", "session hook current"],
        ["note", CODEX_TRUST_STEP],
      ],
    ],
  ] as const)
    for (const form of forms(g)) {
      write(config, form);
      const again = await cli(m, ["--json"]);
      assert.deepEqual(actions(again.json, codex), want, form);
    }
});

test("--plan lists both hook writes and writes nothing; a cloud session writes no hook at all", async () => {
  const m = machine();
  hookEntry(m, "claude-code", OLD);
  const before = snapshot(m.home);
  const r = await cli(m, ["--plan", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(m.home), before);
  assert.deepEqual(actions(r.json, hooksFile(m, "claude-code")), [
    ["write", "session hook"],
    ["write", "old sync-dev.sh hook removed"],
  ]);
  assert.deepEqual(actions(r.json, hooksFile(m, "codex")), [
    ["write", "session hook"],
    ["note", CODEX_TRUST_STEP],
  ]);
  const cloud = await cli(m, ["--quiet"], CLOUD);
  assert.equal(cloud.status, 0, cloud.stderr);
  assert.deepEqual(
    names(snapshot(m.home)).filter((e) => !names(before).includes(e)),
    [".claude/CLAUDE.md", ".codex/AGENTS.md"],
  );
  assert.ok(read(hooksFile(m, "claude-code")).includes("sync-dev.sh"));
  assert.equal(fs.existsSync(hooksFile(m, "codex")), false);
});
