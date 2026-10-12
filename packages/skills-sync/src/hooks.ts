// The one session-start hook entry this tool keeps in each harness's user hooks file (ADR-0010): Claude Code's
// ~/.claude/settings.json (hooks.SessionStart) and Codex's ~/.codex/hooks.json. The entry runs
// `npx --yes @oneezy/skills-sync@latest hook` when a session starts or resumes. The tool knows its own entry by its
// command, never by its place in the list, and never edits or removes another entry: the file is parsed, the one group
// appended at the end (Codex trusts a hook by its position, so nothing is reordered) and written back with the file's
// own indentation, line endings and trailing newline. The old hand-made sync-dev.sh entry goes only once the new entry
// is in the file and read back. Codex runs a user hook only after the user trusted it in its TUI; that trust is read
// from config.toml (hooks.state) and never written here: a missing one, or one recorded for another form of the entry,
// is a manual step the report names. Hook trust is the user's own tap, so the tool never writes it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, lexists, toHash } from "./fs.js";
import type { Harness } from "./harnesses.js";
import type { Action } from "./plan.js";

/** What the entry runs: the hook command of whatever version npm calls latest. */
export const HOOK_COMMAND = "npx --yes @oneezy/skills-sync@latest hook";
/** A new session and a resumed one; not clear or compact, which would run the sync on every compaction. */
export const HOOK_MATCHER = "startup|resume";
/** Seconds: a sync with a fetch and a GitHub read or two, well under either harness's default. */
export const HOOK_TIMEOUT = 120;
/** What Codex shows beside the hook while it runs, and in its review screen. */
export const HOOK_STATUS_MESSAGE = "Skills Sync";

/** The manual step only a person can take, once per machine or WSL distro (oneezy/skills#66): status shows it too. */
export const CODEX_TRUST_STEP =
  'Codex hook needs trust, once per machine: run codex; on "Hooks need review" choose 1. Review hooks (or type /hooks); ' +
  'select SessionStart, then the row "[!] Skills Sync · new", and press t; Esc twice. It runs from the next codex start';

/** The same step when Codex's trust record is for another form of the entry: Codex lists it as modified and runs it not. */
export const CODEX_RETRUST_STEP =
  'Codex hook changed since it was trusted, review again, once per machine: run codex; on "Hooks need review" choose ' +
  '1. Review hooks (or type /hooks); select SessionStart, then the row "[!] Skills Sync · modified", and press t; ' +
  "Esc twice. It runs from the next codex start";

/**
 * How Codex sees the tool's entry, as its hooks browser does: trusted (config.toml records the entry's key with the
 * entry's hash), new (no trusted hash for its key: "· new"), changed (a trusted hash for its key, but of another form of
 * the entry: "· modified", review required again). Codex runs the entry only when it is trusted.
 */
export type CodexTrust = "trusted" | "new" | "changed";

/** Codex's default for a handler's additionalContextLimit, left out of the trust hash (hooks/src/output_spill.rs). */
const CODEX_DEFAULT_CONTEXT_LIMIT = 2500;
/** Codex's default timeout in seconds for a handler that names none (hooks/src/engine/discovery.rs). */
const CODEX_DEFAULT_TIMEOUT = 600;

export interface HookState {
  /** the harness's user hooks file */
  file: string;
  /** the tool's own entry is in the file */
  present: boolean;
  /** a hand-made sync-dev.sh entry is in the file */
  old: boolean;
  /** Codex only: the entry is trusted in config.toml (hooks.state); false when not, or not yet written; null on Claude Code */
  trusted: boolean | null;
  /** Codex only: trusted, new or changed (see CodexTrust); new when the entry is not written yet; null on Claude Code */
  trust: CodexTrust | null;
  /** why the file cannot be worked on (not JSON, SessionStart not a list), or the manual step the user still owes */
  note?: string;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The tool's own entry: the package and the hook command, whatever the version suffix or the npx flags. */
export function isOwnCommand(command: unknown): boolean {
  return typeof command === "string" && /@oneezy\/skills-sync(?:@\S*)?\s+hook(?:\s|$)/.test(command);
}

/** The hook Justin made by hand before this tool wrote one (ADR-0010). */
export function isOldCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes("sync-dev.sh");
}

interface Format {
  indent: string;
  eol: string;
  trailingNewline: boolean;
}

interface Parsed {
  doc: Json;
  bytes: Buffer | null;
  format: Format;
}

type Inspected = { ok: true; parsed: Parsed } | { ok: false; reason: string };

/** The file as a document plus how it is laid out, or why it cannot be edited. An absent file is an empty document. */
function inspect(file: string): Inspected {
  if (hasLinkedParent(file)) return { ok: false, reason: "linked hooks file or parent" };
  if (!lexists(file))
    return { ok: true, parsed: { doc: {}, bytes: null, format: { indent: "  ", eol: "\n", trailingNewline: true } } };
  let bytes: Buffer;
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, reason: "not a file" };
    bytes = fs.readFileSync(file);
  } catch (error) {
    return { ok: false, reason: `unreadable (${error instanceof Error ? error.message : String(error)})` };
  }
  const text = bytes.toString("utf8");
  let doc: unknown = {};
  if (text.trim()) {
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, reason: "not valid JSON" };
    }
  }
  if (!isObject(doc)) return { ok: false, reason: "not a JSON object" };
  if (doc.hooks !== undefined && !isObject(doc.hooks)) return { ok: false, reason: "hooks is not an object" };
  const start = isObject(doc.hooks) ? doc.hooks.SessionStart : undefined;
  if (start !== undefined && !Array.isArray(start)) return { ok: false, reason: "hooks.SessionStart is not a list" };
  const format: Format = {
    indent: /^([ \t]+)\S/m.exec(text)?.[1] ?? "  ",
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    trailingNewline: /\r?\n$/.test(text),
  };
  return { ok: true, parsed: { doc, bytes, format } };
}

/** The document as the harness wrote it: its indentation, its line endings, its trailing newline (or none). */
function serialise(doc: Json, f: Format): string {
  let text = JSON.stringify(doc, null, f.indent);
  if (f.eol !== "\n") text = text.replace(/\n/g, f.eol);
  return f.trailingNewline ? text + f.eol : text;
}

/** The SessionStart groups of a document (an empty list when it has none); every entry as it is, whatever its shape. */
function groupsOf(doc: Json): unknown[] {
  const start = isObject(doc.hooks) ? doc.hooks.SessionStart : undefined;
  return Array.isArray(start) ? start : [];
}

/** A group's command handlers; a group of another shape has none. */
function handlersOf(group: unknown): Json[] {
  return isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter(isObject) : [];
}

/**
 * Where the tool's own entry sits: group index and handler index in the lists as written, the two halves of Codex's
 * trust key; null when absent.
 */
function ownPosition(groups: unknown[]): { group: number; handler: number } | null {
  for (const [group, g] of groups.entries()) {
    if (!isObject(g) || !Array.isArray(g.hooks)) continue;
    const handler = g.hooks.findIndex((h) => isObject(h) && isOwnCommand(h.command));
    if (handler >= 0) return { group, handler };
  }
  return null;
}

const hasOld = (groups: unknown[]): boolean => groups.some((g) => handlersOf(g).some((h) => isOldCommand(h.command)));

/** The entry in the shape the harness reads; Codex shows statusMessage in its review screen and while the hook runs. */
function ownGroup(harnessId: string): Json {
  const handler: Json = { type: "command", command: HOOK_COMMAND };
  if (harnessId === "codex") handler.statusMessage = HOOK_STATUS_MESSAGE;
  handler.timeout = HOOK_TIMEOUT;
  return { matcher: HOOK_MATCHER, hooks: [handler] };
}

/** A copy of `doc` with the tool's group appended to hooks.SessionStart; nothing else moves. */
function withOwn(doc: Json, harnessId: string): Json {
  const next = structuredClone(doc);
  const hooks = isObject(next.hooks) ? next.hooks : (next.hooks = {});
  const start = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : (hooks.SessionStart = []);
  start.push(ownGroup(harnessId));
  return next;
}

/** A copy of `doc` without the handlers `drop` names; a group that held nothing else goes with them. */
function without(doc: Json, drop: (command: unknown) => boolean): Json {
  const next = structuredClone(doc);
  const hooks = next.hooks as Json;
  hooks.SessionStart = (hooks.SessionStart as unknown[]).filter((g) => {
    if (!isObject(g) || !Array.isArray(g.hooks)) return true;
    const kept = g.hooks.filter((h) => !(isObject(h) && drop(h.command)));
    const emptied = kept.length === 0 && g.hooks.length > 0;
    g.hooks = kept;
    return !emptied;
  });
  return next;
}

/** A copy of `doc` without the sync-dev.sh handlers; a group that held nothing else goes with them. */
const withoutOld = (doc: Json): Json => without(doc, isOldCommand);

/**
 * A copy of `doc` without the tool's own entry (unlink's half of withOwn): its handlers, a group left empty, and a
 * SessionStart list or hooks object left empty by that, so a file the tool alone wrote into reads as before it did.
 */
function withoutOwn(doc: Json): Json {
  const next = without(doc, isOwnCommand);
  const hooks = next.hooks as Json;
  if (Array.isArray(hooks.SessionStart) && !hooks.SessionStart.length) delete hooks.SessionStart;
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

/** The hook's state in the harness's user hooks file, nothing written; null for a harness whose table row names none. */
export function readHook(h: Harness): HookState | null {
  if (!h.userHooks) return null;
  const file = h.userHooks;
  const r = inspect(file);
  if (!r.ok) return { file, present: false, old: false, trusted: null, trust: null, note: `${r.reason}; left alone` };
  const groups = groupsOf(r.parsed.doc);
  const own = ownPosition(groups);
  const state: HookState = { file, present: own !== null, old: hasOld(groups), trusted: null, trust: null };
  if (h.id === "codex") {
    state.trust = own ? codexTrust(h, groups, own) : "new";
    state.trusted = state.trust === "trusted";
    if (own && state.trust !== "trusted") state.note = trustStep(state.trust);
  }
  return state;
}

/**
 * The actions that make the harness's hooks file carry the one entry: a write appending it when it is absent; a second
 * write dropping the old sync-dev.sh entry, planned against the first write's bytes so it runs only once the new entry
 * was written and read back (apply() checks the hash and reads back every write); a skip when all is as it should be;
 * a conflict when the file cannot be edited. On Codex, the skip says the entry is trusted when it is, and a note names
 * the trust step while config.toml lacks the entry's trust, or the review again when its trust is for another form.
 */
export function hookActions(h: Harness, hook: HookState): Action[] {
  const file = hook.file;
  const r = inspect(file);
  if (!r.ok) return [{ kind: "conflict", path: file, note: `${r.reason}; left alone` }];
  const actions: Action[] = [];
  let { doc } = r.parsed;
  let expectedHash = r.parsed.bytes ? toHash(r.parsed.bytes) : null;
  const write = (next: Json, note: string) => {
    const payload = serialise(next, r.parsed.format);
    actions.push({ kind: "write", path: file, payload, expectedHash, note });
    doc = next;
    expectedHash = toHash(Buffer.from(payload));
  };
  if (!ownPosition(groupsOf(doc))) write(withOwn(doc, h.id), "session hook");
  if (hasOld(groupsOf(doc))) write(withoutOld(doc), "old sync-dev.sh hook removed");
  const trust = h.id === "codex" ? codexTrustOf(h, groupsOf(doc)) : null;
  if (!actions.length)
    actions.push({
      kind: "skip",
      path: file,
      note: trust === "trusted" ? "session hook current, trusted in Codex" : "session hook current",
    });
  if (trust && trust !== "trusted") actions.push({ kind: "note", path: file, note: trustStep(trust) });
  return actions;
}

/**
 * The action that takes the tool's own entry out of the harness's hooks file (unlink): a write of the file without it,
 * checked against the file's bytes at apply time, every other entry and key kept byte for byte as when the entry was
 * written; a delete when the file then holds nothing, so it was the tool's alone; a conflict when the file cannot be
 * edited; null when there is no file or no own entry, so a second unlink has nothing to do. Codex's trust record in
 * config.toml is Codex's own and stays.
 */
export function hookRemoval(h: Harness, hook: HookState): Action | null {
  const file = hook.file;
  const r = inspect(file);
  if (!r.ok) return { kind: "conflict", path: file, note: `${r.reason}; left alone` };
  if (!r.parsed.bytes || !ownPosition(groupsOf(r.parsed.doc))) return null;
  const next = withoutOwn(r.parsed.doc);
  if (!Object.keys(next).length)
    return { kind: "delete", path: file, note: `held only the skills-sync session hook (${h.name})` };
  return {
    kind: "write",
    path: file,
    payload: serialise(next, r.parsed.format),
    expectedHash: toHash(r.parsed.bytes),
    note: "session hook removed",
  };
}

/** The manual step for a Codex entry that is not trusted: trust it, or review it again when it changed. */
const trustStep = (trust: "new" | "changed"): string => (trust === "changed" ? CODEX_RETRUST_STEP : CODEX_TRUST_STEP);

/** How Codex sees the tool's entry in `groups` (hooks.json's SessionStart list); new when the entry is not there. */
function codexTrustOf(h: Harness, groups: unknown[]): CodexTrust {
  const own = ownPosition(groups);
  return own ? codexTrust(h, groups, own) : "new";
}

/**
 * Codex records a trusted user hook in config.toml as `[hooks.state."<key>"]` with a `trusted_hash` (oneezy/skills#66),
 * and runs the hook only while that hash is the hash of the entry as hooks.json has it now (openai/codex,
 * hooks/src/engine/discovery.rs hook_trust_status): no hash for the key is a new hook, another hash a modified one.
 * The key is compared as the exact string Codex builds (codexHookKey), as Codex looks it up. config.toml is read,
 * never written: the hash is Codex's own, and trusting on its behalf would defeat the review.
 */
function codexTrust(h: Harness, groups: unknown[], own: { group: number; handler: number }): CodexTrust {
  let toml: string;
  try {
    toml = fs.readFileSync(path.join(h.configDir, "config.toml"), "utf8");
  } catch {
    return "new";
  }
  const recorded = trustedHashes(toml).get(codexHookKey(h, own.group, own.handler));
  if (recorded === undefined) return "new";
  return recorded === codexHookHash(groups[own.group], own.handler) ? "trusted" : "changed";
}

/**
 * Codex's key for a user hook in hooks.json (hooks/src/lib.rs hook_key): `<hooks.json>:session_start:<group>:<handler>`.
 * The path is Codex's home joined with hooks.json: CODEX_HOME canonicalized when it is set, ~/.codex as written when
 * it is not (utils/home-dir find_codex_home), so a key under another spelling of the same folder is not this key.
 */
export function codexHookKey(h: Harness, group: number, handler: number): string {
  let dir = h.configDir;
  if (h.canonicalConfigDir)
    try {
      dir = fs.realpathSync.native(dir);
    } catch {
      // Codex does not start with a CODEX_HOME it cannot canonicalize; the key as written then matches no record
    }
  return `${path.join(dir, "hooks.json")}:session_start:${group}:${handler}`;
}

/**
 * Codex's trust hash for the command handler at `handler` in a SessionStart `group` (hooks/src/engine/discovery.rs
 * hook_hash, config/src/fingerprint.rs version_for_toml): sha256 over the compact JSON, keys sorted, of
 * `{ event_name: "session_start", matcher, hooks: [handler] }`, the handler as Codex normalizes it: `type`, `command`
 * (on Windows `commandWindows` in its place when set), `timeout` (600 when unset, at least 1), `async` (false when
 * unset), `statusMessage` when set, `additionalContextLimit` when set and not the default 2500; the matcher only when
 * set; keys Codex does not read left out. Null for an entry Codex would not load: not a command, an empty command, a
 * value of the wrong type.
 */
export function codexHookHash(
  group: unknown,
  handler: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!isObject(group) || !Array.isArray(group.hooks)) return null;
  const h: unknown = group.hooks[handler];
  if (!isObject(h) || h.type !== "command" || typeof h.command !== "string") return null;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v);
  const isString = (v: unknown) => typeof v === "string";
  const windows = h.commandWindows ?? h.command_windows;
  if (
    !optional(windows, isString) ||
    !optional(h.timeout, count) ||
    !(h.async === undefined || typeof h.async === "boolean") ||
    !optional(h.statusMessage, isString) ||
    !optional(h.additionalContextLimit, count) ||
    !optional(group.matcher, isString)
  )
    return null;
  const command = platform === "win32" && typeof windows === "string" ? windows : h.command;
  if (!command.trim()) return null;
  const normal: Json = {
    type: "command",
    command,
    timeout: Math.max(1, (h.timeout as number | null | undefined) ?? CODEX_DEFAULT_TIMEOUT),
    async: h.async ?? false,
  };
  if (typeof h.statusMessage === "string") normal.statusMessage = h.statusMessage;
  if (typeof h.additionalContextLimit === "number" && h.additionalContextLimit !== CODEX_DEFAULT_CONTEXT_LIMIT)
    normal.additionalContextLimit = h.additionalContextLimit;
  const identity: Json = { event_name: "session_start", hooks: [normal] };
  if (typeof group.matcher === "string") identity.matcher = group.matcher;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortedKeys(identity)))
    .digest("hex")}`;
}

/** A copy of `value` with every object's keys in sorted order, as serde_json's sort_all_objects leaves them. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortedKeys(value[k])]),
  );
}

/**
 * Every hooks.state key with a trusted_hash in `toml`, unescaped, and that hash; the last one written wins. The table
 * is read leniently: a header table; a dotted key at the top, under [hooks] or under [hooks.state]; an inline table
 * under either.
 */
function trustedHashes(toml: string): Map<string, string> {
  const out = new Map<string, string>();
  // a TOML basic or literal string: its text in the first group or the second
  const str = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
  const header = new RegExp(String.raw`^\s*\[\s*hooks\s*\.\s*state\s*\.\s*${str}\s*\]`);
  const value = new RegExp(String.raw`^\s*trusted_hash\s*=\s*${str}`);
  // the key's dotted and inline forms, each with the prefix its table leaves out: hooks.state at the top, state under
  // [hooks], nothing under [hooks.state]
  const dotted = (prefix: string) => new RegExp(String.raw`^\s*${prefix}${str}\s*\.\s*trusted_hash\s*=\s*${str}`);
  const inline = (prefix: string) =>
    new RegExp(String.raw`^\s*${prefix}${str}\s*=\s*\{[^}]*\btrusted_hash\s*=\s*${str}`);
  const forms: Record<string, RegExp[]> = {
    "": [dotted(String.raw`hooks\s*\.\s*state\s*\.\s*`), inline(String.raw`hooks\s*\.\s*state\s*\.\s*`)],
    hooks: [dotted(String.raw`state\s*\.\s*`), inline(String.raw`state\s*\.\s*`)],
    "hooks.state": [dotted(""), inline("")],
  };
  const text = (m: RegExpExecArray, at: number) =>
    m[at] !== undefined ? m[at].replace(/\\(["\\])/g, "$1") : m[at + 1];
  let table = "";
  let pending: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    let m = header.exec(line);
    if (m) {
      pending = text(m, 1);
      table = "";
      continue;
    }
    const any = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (any) {
      table = any[1].replace(/\s/g, "");
      pending = null;
      continue;
    }
    if (pending !== null && (m = value.exec(line))) out.set(pending, text(m, 1));
    for (const form of forms[table] ?? []) if ((m = form.exec(line))) out.set(text(m, 1), text(m, 3));
  }
  return out;
}
