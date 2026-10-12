// Codex's trust identity for the session hook, worked out as Codex works it out (openai/codex a9b0815): the hash over
// the normalized entry (codex-rs/hooks/src/engine/discovery.rs, config/src/fingerprint.rs) and the key naming the
// hooks.json path, group and handler (hooks/src/lib.rs), the path canonical only when CODEX_HOME names the folder
// (utils/home-dir). The expected hashes are the ones Codex computes for these entries; nothing here runs codex.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vite-plus/test";
import { harnessTable } from "../src/harnesses.js";
import {
  HOOK_COMMAND,
  HOOK_MATCHER,
  HOOK_STATUS_MESSAGE,
  HOOK_TIMEOUT,
  codexHookHash,
  codexHookKey,
} from "../src/hooks.js";

const OWN = {
  matcher: HOOK_MATCHER,
  hooks: [{ type: "command", command: HOOK_COMMAND, statusMessage: HOOK_STATUS_MESSAGE, timeout: HOOK_TIMEOUT }],
};
const hashOf = (handler: Record<string, unknown>, group: Record<string, unknown> = { matcher: HOOK_MATCHER }) =>
  codexHookHash({ ...group, hooks: [{ type: "command", ...handler }] }, 0, "linux");

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

test("the entry sync writes hashes to the trust hash Codex records for it", () => {
  assert.equal(
    codexHookHash(OWN, 0, "linux"),
    "sha256:7d33866e59a40e27532f04e1517bd94ba3797a8b0db24913420cb94602933b0e",
  );
  // the same on Windows: no commandWindows, so command is what runs there too
  assert.equal(codexHookHash(OWN, 0, "win32"), codexHookHash(OWN, 0, "linux"));
});

test("Codex's normalization: timeout 600 and async false when unset, matcher and statusMessage only when set, additionalContextLimit unless 2500, timeout at least 1", () => {
  // what a user (or an older setup) wrote: timeout 30, no statusMessage
  assert.equal(
    hashOf({ command: HOOK_COMMAND, timeout: 30 }),
    "sha256:3d50e68a46728afb2a089d514e2318cc2a3b58b8fcf3d0c1d4dcc276a56712bb",
  );
  // no matcher, no timeout: the defaults
  assert.equal(
    hashOf({ command: HOOK_COMMAND }, {}),
    "sha256:450e72558c42929f234a7940f9aacbe589301194bbe1e06cec211d1c8a286964",
  );
  assert.equal(
    hashOf({ command: HOOK_COMMAND, timeout: 600, async: false }, {}),
    hashOf({ command: HOOK_COMMAND }, {}),
  );
  assert.equal(hashOf({ command: HOOK_COMMAND }, { matcher: null }), hashOf({ command: HOOK_COMMAND }, {}));
  const own = { command: HOOK_COMMAND, timeout: HOOK_TIMEOUT, statusMessage: HOOK_STATUS_MESSAGE };
  // the default limit is left out; another one and async are part of the identity
  assert.equal(hashOf({ ...own, additionalContextLimit: 2500 }), codexHookHash(OWN, 0, "linux"));
  assert.equal(
    hashOf({ ...own, additionalContextLimit: 4000, async: true }),
    "sha256:8792bfef84ca136cfbb89277526b5a9c363936f01d3fa2116910c562fc773f6e",
  );
  assert.equal(hashOf({ command: HOOK_COMMAND, timeout: 0 }), hashOf({ command: HOOK_COMMAND, timeout: 1 }));
  // keys Codex does not read change nothing; a changed statusMessage, timeout or matcher changes the hash
  assert.equal(hashOf({ ...own, comment: "mine" }), codexHookHash(OWN, 0, "linux"));
  for (const changed of [
    hashOf({ ...own, statusMessage: "Sync" }),
    hashOf({ ...own, timeout: 60 }),
    hashOf(own, { matcher: "startup" }),
    hashOf({ command: HOOK_COMMAND, timeout: HOOK_TIMEOUT }),
  ])
    assert.notEqual(changed, codexHookHash(OWN, 0, "linux"));
});

test("on Windows Codex hashes commandWindows in place of command; elsewhere commandWindows is not part of it", () => {
  const own = { command: HOOK_COMMAND, timeout: HOOK_TIMEOUT, statusMessage: HOOK_STATUS_MESSAGE };
  const group = {
    matcher: HOOK_MATCHER,
    hooks: [{ type: "command", ...own, commandWindows: `npx.cmd ${HOOK_COMMAND.slice(4)}` }],
  };
  assert.equal(
    codexHookHash(group, 0, "win32"),
    "sha256:f80fcab9282a0804e5d2923f64fe4acde3c9d3bafe63c77f34e734ce96c892b0",
  );
  assert.equal(codexHookHash(group, 0, "linux"), codexHookHash(OWN, 0, "linux"));
});

test("the handler is picked by its index in the group; an entry Codex would not load has no hash", () => {
  const two = { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "echo first" }, ...OWN.hooks] };
  assert.equal(codexHookHash(two, 1, "linux"), codexHookHash(OWN, 0, "linux"));
  assert.notEqual(codexHookHash(two, 0, "linux"), codexHookHash(OWN, 0, "linux"));
  for (const handler of [
    { type: "command", command: "  " },
    { type: "prompt" },
    { type: "command", command: HOOK_COMMAND, timeout: "120" },
  ])
    assert.equal(codexHookHash({ hooks: [handler] }, 0, "linux"), null, JSON.stringify(handler));
  assert.equal(codexHookHash({ hooks: [] }, 0, "linux"), null);
});

test("the key names hooks.json under CODEX_HOME's canonical path when CODEX_HOME is set, under ~/.codex as written when it is not", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-key-"));
  temps.push(base);
  const real = path.join(base, "real-home");
  fs.mkdirSync(path.join(real, ".codex"), { recursive: true });
  const linked = path.join(base, "linked-home");
  fs.symlinkSync(real, linked, process.platform === "win32" ? "junction" : "dir");
  const codexOf = (env: NodeJS.ProcessEnv) => harnessTable(linked, env).find((h) => h.id === "codex")!;
  const canonical = path.join(fs.realpathSync.native(path.join(real, ".codex")), "hooks.json");
  assert.equal(
    codexHookKey(codexOf({ CODEX_HOME: path.join(linked, ".codex") }), 2, 0),
    `${canonical}:session_start:2:0`,
  );
  assert.equal(codexHookKey(codexOf({}), 0, 1), `${path.join(linked, ".codex", "hooks.json")}:session_start:0:1`);
  // an empty CODEX_HOME is no CODEX_HOME
  assert.equal(
    codexHookKey(codexOf({ CODEX_HOME: "" }), 0, 0),
    `${path.join(linked, ".codex", "hooks.json")}:session_start:0:0`,
  );
});
