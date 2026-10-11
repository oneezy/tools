// The one managed block skills-sync writes into each harness's global instructions file (ADR-0011): ~/.claude/CLAUDE.md
// and ~/.codex/AGENTS.md, never a repository's AGENTS.md, CLAUDE.md or settings. Its text is the library's SHARED.md at
// the commit of the latest release (the commit the plugins come from), written verbatim; a release without SHARED.md
// (an older one) gets BLOCK_BODY, the tool's built-in text. The start marker is stamped with the release and the sha256
// of the text (`<!-- skills-sync:skills:start release-26 sha256:<hex> -->`), so status can tell a current block from a
// stale one (another text than the latest release's) and a hand-edited one (its text no longer hashes to its stamp). A
// release that carries the same text is no change: nothing is rewritten for the stamp alone. Only the bytes between the
// markers change; everything around them stays as the user wrote it, line endings included. A file whose content
// changes is copied beside itself first (CLAUDE-backup-<UTC yyyymmdd-HHMMSS>.md), never over an earlier backup. When
// the text cannot be read (GitHub or SHARED.md out of reach), a block already there stays as it is and a file without
// one gets BLOCK_BODY stamped `built-in`, so a session never starts without one. Only the `skills` and `brain` ids are
// the tool's: a marker with another id is the user's text. Blocks an older skills-sync left in repositories are found
// and reported here, never edited.
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, lexists, samePath, toHash } from "./fs.js";
import type { Harness } from "./harnesses.js";
import type { Action } from "./plan.js";
import { DEFAULT_REPO, type Release } from "./release.js";

/** The block's id in its markers: <!-- skills-sync:skills:start ... --> ... <!-- skills-sync:skills:end -->. */
export const BLOCK_ID = "skills";

/** The library file whose text the block carries, at the release's commit. */
export const SHARED_FILE = "SHARED.md";

/**
 * The built-in text, for a release without SHARED.md: how to call a skill per harness, never fetch a SKILL.md, and the
 * Brain routing the old `brain` block carried (the library's brain-routing.md), word for word.
 */
export const BLOCK_BODY = `## Skills

This block is written by skills-sync; edits here are overwritten. Skills come from the library ${DEFAULT_REPO}, installed into each harness in one form. Call one the way the harness you are in resolves it:

| Harness | How to call a skill |
| --- | --- |
| Claude Code | \`/<plugin>:<skill>\`, e.g. \`/oneezy:oneezy-status\` |
| Codex | \`$<skill>\` in the prompt (a plugin's skill: \`$<plugin>:<skill>\`), the \`/skills\` picker, or \`@<skill>\` on ChatGPT web |
| Hermes | \`/<skill>\` for a loose skill; a plugin's skill: \`/agent-plugin-<id>-<hash>:<skill>\` |

Never fetch a \`SKILL.md\` from GitHub, or run one from any folder this harness does not read: that bypasses the harness's own resolution and \`disable-model-invocation\`. When a typed skill does not resolve, show this table instead of improvising.

## Brain

For Brain capture, lookup, agenda, triage, task status or durable context, load \`/oneezy-brain\` and follow its current registry. The skill resolves the canonical Google Drive Brain and owns locations, schema, account selection and verification.

This delegation supersedes earlier Brain destinations in these instructions and their imports. Retain pinned sources, GitHub and Spaces as historical evidence. If the installed skill or its supported Drive route is unavailable, report that exact blocker and stop dependent Brain operations.`;

/** The release a block written without one is stamped with: the built-in text, written while GitHub was out of reach. */
export const BUILT_IN = "built-in";

/**
 * A marker is a whole line (trailing blanks allowed), so a mention in prose is not one; a byte order mark may come
 * before it (on line 1). Its id is the tool's, `skills` or the old tool's `brain`: a marker with any other id (a
 * fenced example of the user's) is text like any other. A start marker may carry words after its kind: the stamp,
 * `release-26 sha256:<hex>`.
 */
const MARKER = /^(\uFEFF?)<!-- skills-sync:(skills|brain):(start|end)((?: [\w.:-]+)*) -->(?=[ \t]*\r?$)/gm;

export interface ManagedBlock {
  id: string;
  /** offset of the start marker */
  start: number;
  /** offset just past the end marker */
  end: number;
  /** the words after the start marker's kind (the stamp), "" for none */
  attrs: string;
  /** offset of the block's text: the start of the line after the start marker */
  bodyStart: number;
  /** offset just past the block's text: where the end marker begins */
  bodyEnd: number;
}

/** Every managed block in `text`, in order; null when markers are unpaired, nested or out of order. */
export function findBlocks(text: string): ManagedBlock[] | null {
  const blocks: ManagedBlock[] = [];
  let open: { id: string; start: number; attrs: string; bodyStart: number } | null = null;
  for (const m of text.matchAll(MARKER)) {
    const [whole, bom, id, kind, attrs] = m;
    // the byte order mark stays where it is, outside the block
    const at = m.index + bom.length;
    if (kind === "start") {
      if (open) return null;
      const eol = text.indexOf("\n", m.index + whole.length);
      open = { id, start: at, attrs: attrs.trim(), bodyStart: eol < 0 ? text.length : eol + 1 };
    } else {
      if (!open || open.id !== id) return null;
      blocks.push({ ...open, end: m.index + whole.length, bodyEnd: at });
      open = null;
    }
  }
  return open ? null : blocks;
}

/** The ids the markers in `text` name, each once, whether or not they pair up. */
export function blockIds(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => m[2]))];
}

/** What a start marker's stamp says: the release the text came from and the sha256 of the text. */
export interface Stamp {
  release: string;
  sha256: string;
}

function parseStamp(attrs: string): Stamp | null {
  const words = attrs.split(" ").filter(Boolean);
  const sha = words.find((w) => /^sha256:[0-9a-f]{64}$/.test(w));
  const release = words.find((w) => !w.startsWith("sha256:"));
  return sha && release ? { release, sha256: sha.slice("sha256:".length) } : null;
}

/** The text the block carries, from one release: what sync writes between the markers. */
export interface BlockSource {
  /** the release the text was read at: release-26 */
  release: string;
  /** the text between the markers: LF line endings, ending in one line break */
  body: string;
  /** sha256 (hex) of `body`, as the stamp carries it */
  sha256: string;
  /** the release has no SHARED.md: `body` is BLOCK_BODY */
  fallback: boolean;
}

/** What a run has to write: the release's text, or why there is none. */
export type SourceResult = { ok: true; source: BlockSource } | { ok: false; reason: string };

/**
 * The block's text for `release`, verbatim (a BOM dropped, line endings read as LF, a missing final line break added):
 * its SHARED.md, or BLOCK_BODY when it has none. Throws when the text cannot go between markers: empty, not UTF-8 text,
 * or holding a marker line of its own.
 */
export function blockSource(release: string, shared: string | null): BlockSource {
  if (shared === null) return { ...sourceOf(release, BLOCK_BODY), fallback: true };
  if (shared.includes("�") || shared.includes("\0")) throw new Error(`${SHARED_FILE} is not UTF-8 text`);
  if (!shared.trim()) throw new Error(`${SHARED_FILE} is empty`);
  if (blockIds(shared).length) throw new Error(`${SHARED_FILE} holds a skills-sync marker line`);
  return { ...sourceOf(release, shared), fallback: false };
}

function sourceOf(release: string, text: string): Omit<BlockSource, "fallback"> {
  const lf = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const body = lf.endsWith("\n") ? lf : `${lf}\n`;
  return { release, body, sha256: toHash(Buffer.from(body)) };
}

/** The text for this run: the release's SHARED.md (or the built-in text), or why it cannot be had. */
export function releaseSource(release: Release | null, error: string | null): SourceResult {
  if (!release) return { ok: false, reason: `latest release not read: ${error ?? "unknown error"}` };
  if (release.sharedError) return { ok: false, reason: `${release.tag}: ${release.sharedError}` };
  try {
    return { ok: true, source: blockSource(release.tag, release.shared) };
  } catch (e) {
    return { ok: false, reason: `${release.tag}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** "release-26 SHARED.md", or for the built-in text why it stands in. */
export function sourceLabel(s: BlockSource): string {
  if (s.release === BUILT_IN) return `built-in text; ${SHARED_FILE} not read`;
  return s.fallback ? `built-in text; ${s.release} has no ${SHARED_FILE}` : `${s.release} ${SHARED_FILE}`;
}

/** What a stamp's release names, for a line: "release-25 text", or "built-in text". */
export function stampLabel(s: Stamp): string {
  return s.release === BUILT_IN ? "built-in text" : `${s.release} text`;
}

/**
 * `text` with the one block in place: an existing managed block (whatever its id, so the old tool's `brain` block is
 * replaced where it stands) becomes this one; otherwise the block is appended. Throws when the markers are broken or
 * the file holds several blocks: that is a human's to sort out.
 */
export function withBlock(text: string, source: BlockSource): string {
  const blocks = findBlocks(text);
  if (!blocks) throw new Error("duplicate or incomplete managed block; left alone");
  if (blocks.length > 1)
    throw new Error(
      `${blocks.length} managed blocks (${blocks.map((b) => b.id).join(", ")}); one is the rule; left alone`,
    );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const start = `<!-- skills-sync:${BLOCK_ID}:start ${source.release} sha256:${source.sha256} -->`;
  const block = `${start}\n${source.body}<!-- skills-sync:${BLOCK_ID}:end -->`.replace(/\n/g, newline);
  if (blocks.length) return text.slice(0, blocks[0].start) + block + text.slice(blocks[0].end);
  const gap = !text || text.endsWith(newline + newline) ? "" : text.endsWith(newline) ? newline : newline + newline;
  return text + gap + block + newline;
}

/**
 * current; outdated (an older block, or another text than the latest release's: "stale" in the lines a user reads, the
 * --json value kept from before); hand-edited; or unknown (the latest text could not be read).
 */
export type BlockStatus = "current" | "missing" | "outdated" | "hand-edited" | "unknown" | "conflict";

/** The block in a global file as the probe finds it, before it is judged against a release's text. */
export interface BlockState {
  /** the harness's global instructions file */
  file: string;
  /** the ids of the managed blocks the file holds today (the old tool wrote `brain`) */
  ids: string[];
  /** a managed block is in the file */
  present: boolean;
  /** what the start marker's stamp says; null for an unstamped (older) block or none */
  stamp: Stamp | null;
  /** the text between the markers no longer hashes to the stamp: someone edited it */
  handEdited: boolean;
  /** why the block cannot be written, when it cannot: a conflict */
  reason?: string;
}

/** The block against the latest text (null when it could not be read). */
export function blockStatus(b: BlockState, source: BlockSource | null): BlockStatus {
  if (b.reason) return "conflict";
  if (!b.present) return "missing";
  if (b.handEdited) return "hand-edited";
  if (!b.stamp || b.ids[0] !== BLOCK_ID) return "outdated";
  if (!source) return "unknown";
  return b.stamp.sha256 === source.sha256 ? "current" : "outdated";
}

/** The harness's global instructions file; null for a harness whose table row names none (Hermes today). */
export function globalFile(h: Harness): string | null {
  return h.userInstructions?.[0] ? path.join(h.configDir, h.userInstructions[0]) : null;
}

interface Inspected {
  state: BlockState;
  /** the file as it is; null when absent or unreadable */
  bytes: Buffer | null;
  text: string;
}

function inspect(file: string): Inspected {
  const conflict = (reason: string, ids: string[] = []): Inspected => ({
    state: { file, ids, present: ids.length > 0, stamp: null, handEdited: false, reason },
    bytes: null,
    text: "",
  });
  if (hasLinkedParent(file)) return conflict("linked instruction file or parent; left alone");
  let bytes: Buffer | null = null;
  if (lexists(file)) {
    try {
      if (!fs.statSync(file).isFile()) return conflict("not a file; left alone");
      bytes = fs.readFileSync(file);
    } catch (error) {
      return conflict(`unreadable (${error instanceof Error ? error.message : String(error)}); left alone`);
    }
  }
  const text = bytes?.toString("utf8") ?? "";
  if (bytes && (!Buffer.from(text).equals(bytes) || text.includes("\0"))) return conflict("not UTF-8 text; left alone");
  const ids = blockIds(text);
  const blocks = findBlocks(text);
  if (!blocks) return conflict("duplicate or incomplete managed block; left alone", ids);
  if (blocks.length > 1)
    return conflict(
      `${blocks.length} managed blocks (${blocks.map((b) => b.id).join(", ")}); one is the rule; left alone`,
      ids,
    );
  const b = blocks.at(0);
  const stamp = b ? parseStamp(b.attrs) : null;
  // the text as written, its line endings read as LF (a CRLF file carries the same text)
  const body = b ? text.slice(b.bodyStart, b.bodyEnd).replace(/\r\n/g, "\n") : "";
  const handEdited = !!stamp && toHash(Buffer.from(body)) !== stamp.sha256;
  return { state: { file, ids, present: !!b, stamp, handEdited }, bytes, text };
}

/** The block in `file`, nothing written: what the probe records and status judges. */
export function readBlock(file: string): BlockState {
  return inspect(file).state;
}

/** How old a temp file of a write must be before it counts as left behind by a run that died. */
const TEMP_STALE_MS = 60_000;

/**
 * The temp files a write of `file` left beside it (`<name>.skills-sync.<pid>.<random>.tmp`) more than a minute ago,
 * as delete actions: a run that died between writing its temp file and the rename. A younger one may be a run writing
 * now and stays. None when the folder cannot be read.
 */
export function leftoverTemps(file: string, now: Date = new Date()): Action[] {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.skills-sync.`;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Action[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || now.getTime() - st.mtimeMs < TEMP_STALE_MS) continue;
    } catch {
      continue;
    }
    out.push({ kind: "delete", path: p, note: "a temp file a skills-sync run left behind" });
  }
  return out;
}

/** `<name>-backup-<UTC yyyymmdd-HHMMSS><ext>` beside `file`: CLAUDE-backup-20261011-221500.md. */
export function backupName(file: string, now: Date = new Date()): string {
  const ext = path.extname(file);
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return path.join(path.dirname(file), `${path.basename(file, ext)}-backup-${stamp}${ext}`);
}

/**
 * The action that makes `file` carry `source`'s block: a write (checked against the file's hash at apply time, as
 * plan.ts does for every instruction write; an existing file is copied to `backup` first), a skip when it is current,
 * a conflict when it cannot be written. Without a source (the text was not read) a block already there stays as it is
 * (null: the run says why once), and a file without one gets the built-in text, stamped `built-in`.
 */
export function blockAction(file: string, given: BlockSource | null, now: Date = new Date()): Action | null {
  const { state, bytes, text } = inspect(file);
  const status = blockStatus(state, given);
  if (status === "conflict") return { kind: "conflict", path: file, note: state.reason };
  if (!given && status !== "missing") return null;
  const source = given ?? blockSource(BUILT_IN, null);
  if (status === "current") return { kind: "skip", path: file, note: "skills block current" };
  const label = sourceLabel(source);
  const why =
    status === "missing"
      ? `skills block (${label})`
      : status === "hand-edited"
        ? `skills block was hand-edited; restored to ${label}`
        : state.ids.join(", ") === BLOCK_ID
          ? `skills block updated to ${label}`
          : `skills block replaces ${state.ids.join(", ")} (${label})`;
  const backup = bytes ? backupName(file, now) : undefined;
  return {
    kind: "write",
    path: file,
    payload: withBlock(text, source),
    expectedHash: bytes ? toHash(bytes) : null,
    note: backup ? `${why}; backup ${backup}` : why,
    ...(backup ? { backup } : {}),
  };
}

export interface RepoBlock {
  file: string;
  ids: string[];
}

/**
 * Managed blocks outside the global file, where the old tool wrote them: `names` directly under each of `roots` (a
 * harness's project instruction file names under each project, or its secondary global files such as
 * AGENTS.override.md under its config folder). `except` are the global files themselves. Found, never edited: each is
 * a cleanup line in the report.
 */
export function repoBlocks(roots: string[], names: string[], except: string[] = []): RepoBlock[] {
  const out: RepoBlock[] = [];
  for (const root of roots) {
    for (const name of names) {
      const file = path.join(root, name);
      if (except.some((e) => samePath(e, file))) continue;
      let text: string;
      try {
        if (!fs.statSync(file).isFile()) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const ids = blockIds(text);
      if (ids.length) out.push({ file, ids });
    }
  }
  return out;
}

/**
 * `text` without its managed blocks: every well-formed block, whatever its id, and the line ending that closed its end
 * marker; everything else byte for byte but one blank line: a block that ended the file takes the blank line before it
 * (the gap blockAction appended it after, which cannot be told from a blank line a human left there). Throws when the
 * markers are broken (a human's to sort out). unlink's half.
 */
export function withoutBlock(text: string): string {
  const blocks = findBlocks(text);
  if (!blocks) throw new Error("duplicate or incomplete managed block; left alone");
  let out = "";
  let at = 0;
  for (const b of blocks) {
    out += text.slice(at, b.start);
    at = b.end;
    if (text.startsWith("\r\n", at)) at += 2;
    else if (text.startsWith("\n", at)) at += 1;
  }
  const rest = text.slice(at);
  // a block that ended the file was appended after one blank line (blockAction's gap): that line goes with it, so the
  // file is as it was before the block came
  if (!rest) for (const nl of ["\r\n", "\n"]) if (out.endsWith(nl + nl)) return out.slice(0, -nl.length);
  return out + rest;
}

/**
 * The action that takes the managed block out of `file`: a write of the text around it (checked against the file's
 * hash at apply time, the file copied to its backup first), a delete when the file held nothing else (nothing of the
 * user's to keep), a conflict when it cannot be read or its markers are broken; null when there is no file or no
 * block, so a second unlink has nothing to do.
 */
export function blockRemoval(file: string, now: Date = new Date()): Action | null {
  const conflict = (note: string): Action => ({ kind: "conflict", path: file, note });
  if (!lexists(file)) return null;
  if (hasLinkedParent(file)) return conflict("linked instruction file or parent; left alone");
  let bytes: Buffer;
  try {
    if (!fs.statSync(file).isFile()) return conflict("not a file; left alone");
    bytes = fs.readFileSync(file);
  } catch (error) {
    return conflict(`unreadable (${error instanceof Error ? error.message : String(error)}); left alone`);
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || text.includes("\0")) return conflict("not UTF-8 text; left alone");
  const ids = blockIds(text);
  if (!ids.length) return null;
  let next: string;
  try {
    next = withoutBlock(text);
  } catch (error) {
    return conflict(error instanceof Error ? error.message : String(error));
  }
  if (next === "") return { kind: "delete", path: file, note: `held only the skills-sync block (${ids.join(", ")})` };
  const backup = backupName(file, now);
  return {
    kind: "write",
    path: file,
    payload: next,
    expectedHash: toHash(bytes),
    note: `skills-sync block (${ids.join(", ")}) removed; backup ${backup}`,
    backup,
  };
}
