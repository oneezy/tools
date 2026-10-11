// The one managed block skills-sync writes into each harness's global instructions file (ADR-0011): ~/.claude/CLAUDE.md
// and ~/.codex/AGENTS.md, never a repository's AGENTS.md, CLAUDE.md or settings. It says how to call a skill in each
// harness and that an agent never fetches a SKILL.md to run one. The text is the same on every machine and needs no
// release and no library, so it is written even when GitHub cannot be read. Only the bytes between the markers change;
// everything around them stays as the user wrote it, line endings included. Blocks an older skills-sync left in
// repositories are found and reported here, never edited.
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, lexists, samePath, toHash } from "./fs.js";
import type { Harness } from "./harnesses.js";
import type { Action } from "./plan.js";

/** The block's id in its markers: <!-- skills-sync:skills:start --> ... <!-- skills-sync:skills:end -->. */
export const BLOCK_ID = "skills";

/** The one block, without its markers. Short on purpose: an agent reads it at the start of every session. */
export const BLOCK_BODY = `## Skills

This block is written by skills-sync; edits here are overwritten. Skills come from the library oneezy/skills, installed into each harness in one form. Call one the way the harness you are in resolves it:

| Harness | How to call a skill |
| --- | --- |
| Claude Code | \`/<plugin>:<skill>\`, e.g. \`/oneezy:oneezy-status\` |
| Codex | \`$<skill>\` in the prompt (a plugin's skill: \`$<plugin>:<skill>\`), the \`/skills\` picker, or \`@<skill>\` on ChatGPT web |
| Hermes | \`/<skill>\` for a loose skill; a plugin's skill: \`/agent-plugin-<id>-<hash>:<skill>\` |

Never fetch a \`SKILL.md\` from GitHub, or run one from any copy this harness did not load: that bypasses the harness's own resolution and \`disable-model-invocation\`. When a typed skill does not resolve, show this table instead of improvising.`;

const MARKER = /<!-- skills-sync:([\w-]+):(start|end) -->/g;

export interface ManagedBlock {
  id: string;
  /** offset of the start marker */
  start: number;
  /** offset just past the end marker */
  end: number;
}

/** Every managed block in `text`, in order; null when markers are unpaired, nested or out of order. */
export function findBlocks(text: string): ManagedBlock[] | null {
  const blocks: ManagedBlock[] = [];
  let open: { id: string; start: number } | null = null;
  for (const m of text.matchAll(MARKER)) {
    const [whole, id, kind] = m;
    if (kind === "start") {
      if (open) return null;
      open = { id, start: m.index };
    } else {
      if (!open || open.id !== id) return null;
      blocks.push({ id, start: open.start, end: m.index + whole.length });
      open = null;
    }
  }
  return open ? null : blocks;
}

/** The ids the markers in `text` name, each once, whether or not they pair up. */
export function blockIds(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((m) => m[1]))];
}

/**
 * `text` with the one block in place: an existing managed block (whatever its id, so the old tool's `brain` block is
 * replaced where it stands) becomes this one; otherwise the block is appended. Throws when the markers are broken or
 * the file holds several blocks: that is a human's to sort out.
 */
export function withBlock(text: string, body = BLOCK_BODY): string {
  const blocks = findBlocks(text);
  if (!blocks) throw new Error("duplicate or incomplete managed block; left alone");
  if (blocks.length > 1)
    throw new Error(
      `${blocks.length} managed blocks (${blocks.map((b) => b.id).join(", ")}); one is the rule; left alone`,
    );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const block = `<!-- skills-sync:${BLOCK_ID}:start -->\n${body}\n<!-- skills-sync:${BLOCK_ID}:end -->`.replace(
    /\n/g,
    newline,
  );
  if (blocks.length) return text.slice(0, blocks[0].start) + block + text.slice(blocks[0].end);
  const gap = !text || text.endsWith(newline + newline) ? "" : text.endsWith(newline) ? newline : newline + newline;
  return text + gap + block + newline;
}

export type BlockStatus = "current" | "missing" | "outdated" | "conflict";

export interface BlockState {
  /** the harness's global instructions file */
  file: string;
  status: BlockStatus;
  /** the ids of the managed blocks the file holds today (the old tool wrote `brain`) */
  ids: string[];
  /** why the block cannot be written, when it cannot */
  reason?: string;
}

/** The harness's global instructions file; null for a harness whose table row names none (Hermes today). */
export function globalFile(h: Harness): string | null {
  return h.userInstructions?.[0] ? path.join(h.configDir, h.userInstructions[0]) : null;
}

interface Inspected {
  state: BlockState;
  /** the file as it is; null when absent */
  bytes: Buffer | null;
  /** the file as it should be; null on a conflict */
  next: string | null;
}

function inspect(file: string): Inspected {
  const conflict = (reason: string, ids: string[] = []): Inspected => ({
    state: { file, status: "conflict", ids, reason },
    bytes: null,
    next: null,
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
  let next: string;
  try {
    next = withBlock(text);
  } catch (error) {
    return conflict(error instanceof Error ? error.message : String(error), ids);
  }
  const status: BlockStatus = next === text ? "current" : ids.length ? "outdated" : "missing";
  return { state: { file, status, ids }, bytes, next };
}

/** The block's state in `file`, nothing written: what the probe records and status shows. */
export function readBlock(file: string): BlockState {
  return inspect(file).state;
}

/**
 * The action that makes `file` carry the block: a write (checked against the file's hash at apply time, as plan.ts
 * does for every instruction write), a skip when it is current, a conflict when it cannot be written.
 */
export function blockAction(file: string): Action {
  const { state, bytes, next } = inspect(file);
  if (state.status === "conflict") return { kind: "conflict", path: file, note: state.reason };
  if (state.status === "current") return { kind: "skip", path: file, note: "skills block current" };
  return {
    kind: "write",
    path: file,
    payload: next!,
    expectedHash: bytes ? toHash(bytes) : null,
    note: state.status === "outdated" ? `skills block replaces ${state.ids.join(", ")}` : "skills block",
  };
}

export interface RepoBlock {
  file: string;
  ids: string[];
}

/**
 * Managed blocks in repository instruction files, where the old tool wrote them: `names` (a harness's project
 * instruction file names) directly under each of `roots`. `except` are the global files, never repository files
 * even when a root is a harness's config folder. Found, never edited: each is a cleanup line in the report.
 */
export function repoBlocks(roots: string[], names: string[], except: string[] = []): RepoBlock[] {
  const out: RepoBlock[] = [];
  for (const root of roots) {
    for (const name of names) {
      const file = path.join(root, name);
      if (out.some((b) => samePath(b.file, file)) || except.some((e) => samePath(e, file))) continue;
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
