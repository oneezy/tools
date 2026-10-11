// The one session-start hook entry this tool keeps in each harness's user hooks file (ADR-0010): Claude Code's
// ~/.claude/settings.json (hooks.SessionStart) and Codex's ~/.codex/hooks.json. The entry runs
// `npx --yes @oneezy/skills-sync@latest hook` when a session starts or resumes. The tool knows its own entry by its
// command, never by its place in the list, and never edits or removes another entry: the file is parsed, the one group
// appended at the end (Codex trusts a hook by its position, so nothing is reordered) and written back with the file's
// own indentation, line endings and trailing newline. The old hand-made sync-dev.sh entry goes only once the new entry
// is in the file and read back. Codex runs a user hook only after the user trusted it in its TUI; that trust is read
// from config.toml (hooks.state) and never written here: a missing one is a manual step the report names.
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, lexists, real, samePath, toHash } from "./fs.js";
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

export interface HookState {
  /** the harness's user hooks file */
  file: string;
  /** the tool's own entry is in the file */
  present: boolean;
  /** a hand-made sync-dev.sh entry is in the file */
  old: boolean;
  /** Codex only: the entry is trusted in config.toml (hooks.state); false when not, or not yet written; null on Claude Code */
  trusted: boolean | null;
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

/** Where the tool's own entry sits: group index and handler index, the two halves of Codex's trust key; null when absent. */
function ownPosition(groups: unknown[]): { group: number; handler: number } | null {
  for (const [group, g] of groups.entries()) {
    const handler = handlersOf(g).findIndex((h) => isOwnCommand(h.command));
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

/** A copy of `doc` without the sync-dev.sh handlers; a group that held nothing else goes with them. */
function withoutOld(doc: Json): Json {
  const next = structuredClone(doc);
  const hooks = next.hooks as Json;
  hooks.SessionStart = (hooks.SessionStart as unknown[]).filter((g) => {
    if (!isObject(g) || !Array.isArray(g.hooks)) return true;
    const kept = g.hooks.filter((h) => !(isObject(h) && isOldCommand(h.command)));
    const emptied = kept.length === 0 && g.hooks.length > 0;
    g.hooks = kept;
    return !emptied;
  });
  return next;
}

/** The hook's state in the harness's user hooks file, nothing written; null for a harness whose table row names none. */
export function readHook(h: Harness): HookState | null {
  if (!h.userHooks) return null;
  const file = h.userHooks;
  const r = inspect(file);
  if (!r.ok) return { file, present: false, old: false, trusted: null, note: `${r.reason}; left alone` };
  const groups = groupsOf(r.parsed.doc);
  const own = ownPosition(groups);
  const state: HookState = { file, present: own !== null, old: hasOld(groups), trusted: null };
  if (h.id === "codex") {
    state.trusted = own !== null && codexTrusted(h.configDir, file, own);
    if (own && !state.trusted) state.note = CODEX_TRUST_STEP;
  }
  return state;
}

/**
 * The actions that make the harness's hooks file carry the one entry: a write appending it when it is absent; a second
 * write dropping the old sync-dev.sh entry, planned against the first write's bytes so it runs only once the new entry
 * was written and read back (apply() checks the hash and reads back every write); a skip when all is as it should be;
 * a conflict when the file cannot be edited. On Codex, a note names the trust step while config.toml lacks it.
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
  if (!actions.length) actions.push({ kind: "skip", path: file, note: "session hook current" });
  if (h.id === "codex") {
    const own = ownPosition(groupsOf(doc));
    if (!own || !codexTrusted(h.configDir, file, own))
      actions.push({ kind: "note", path: file, note: CODEX_TRUST_STEP });
  }
  return actions;
}

/**
 * Codex records a trusted user hook in config.toml as `[hooks.state."<hooks.json>:session_start:<group>:<handler>"]`
 * with a `trusted_hash` (oneezy/skills#66). The table is read leniently (a header table; a dotted key at the top,
 * under [hooks] or under [hooks.state]; an inline table under either) and never written: the hash is Codex's own, and
 * trusting on its behalf would defeat the review. The key's path half is compared as a path, so a case or separator
 * difference on Windows does not matter.
 */
function codexTrusted(configDir: string, hooksFile: string, own: { group: number; handler: number }): boolean {
  let toml: string;
  try {
    toml = fs.readFileSync(path.join(configDir, "config.toml"), "utf8");
  } catch {
    return false;
  }
  for (const key of trustedKeys(toml)) {
    const m = /^(.*):session_start:(\d+):(\d+)$/.exec(key);
    if (!m || Number(m[2]) !== own.group || Number(m[3]) !== own.handler) continue;
    if (samePath(m[1], hooksFile) || samePath(m[1], real(hooksFile))) return true;
  }
  return false;
}

/** Every hooks.state key with a trusted_hash in `toml`, unescaped. */
function trustedKeys(toml: string): string[] {
  const out: string[] = [];
  const quoted = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)')`;
  const header = new RegExp(String.raw`^\s*\[\s*hooks\s*\.\s*state\s*\.\s*${quoted}\s*\]`);
  // the key's dotted and inline forms, each with the prefix its table leaves out: hooks.state at the top, state under
  // [hooks], nothing under [hooks.state]
  const dotted = (prefix: string) => new RegExp(String.raw`^\s*${prefix}${quoted}\s*\.\s*trusted_hash\s*=`);
  const inline = (prefix: string) => new RegExp(String.raw`^\s*${prefix}${quoted}\s*=\s*\{[^}]*\btrusted_hash\s*=`);
  const forms: Record<string, RegExp[]> = {
    "": [dotted(String.raw`hooks\s*\.\s*state\s*\.\s*`), inline(String.raw`hooks\s*\.\s*state\s*\.\s*`)],
    hooks: [dotted(String.raw`state\s*\.\s*`), inline(String.raw`state\s*\.\s*`)],
    "hooks.state": [dotted(""), inline("")],
  };
  const unescape = (m: RegExpExecArray) => (m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]);
  let table = "";
  let pending: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    let m = header.exec(line);
    if (m) {
      pending = unescape(m);
      table = "";
      continue;
    }
    const any = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (any) {
      table = any[1].replace(/\s/g, "");
      pending = null;
      continue;
    }
    if (pending !== null && /^\s*trusted_hash\s*=/.test(line)) out.push(pending);
    for (const form of forms[table] ?? []) if ((m = form.exec(line))) out.push(unescape(m));
  }
  return out;
}
