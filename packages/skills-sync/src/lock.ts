// The lock of a config library, skills-sync.lock.json (version 2): per config source, the upstream version, commit and
// date it was resolved at, and its selected skills by working-set name (upstream path, recipe hash, and a commit only
// where a pin holds the skill at another commit than the source's). It never stores how far past its version a commit
// is; versions.ts counts that. The version 1 lock skills-sync 0.4.0 wrote (skills-lock.json, the npx skills format plus
// a commit per entry) is read as version 2 in memory until a command that writes the lock migrates it.
import fs from "node:fs";
import path from "node:path";
import { cmp, lockSource, selection, type Config, type LockEntry } from "./sources.js";

export const LOCK_NAME = "skills-sync.lock.json";
/** The npx skills lock: a lock-only library's record of what is installed, and the version 1 lock of a config library. */
export const NPX_LOCK_NAME = "skills-lock.json";

export interface Lock {
  version: 2;
  sources: Record<string, LockedSource>;
  /** read from a version 1 lock: no source's version or date is known */
  migrated?: true;
}

export interface LockedSource {
  /** as in the config */
  repo: string;
  ref: string;
  /** plain semver, or null when the source has no release tag and no manifest version at this commit */
  version: string | null;
  commit: string;
  /** the commit's ISO date */
  date: string;
  skills: Record<string, LockedSkill>;
}

export interface LockedSkill {
  /** the skill folder relative to the source's repo root, / separators */
  path: string;
  hash: string;
  /** only where a pin holds the skill at another commit than the source's */
  commit?: string;
}

/** The lock as written: sources and skills sorted, keys in their documented order, two spaces, trailing newline. */
export function lockText(sources: Record<string, LockedSource>): string {
  const out: Record<string, unknown> = {};
  for (const id of Object.keys(sources).sort(cmp)) {
    const s = sources[id];
    const skills: Record<string, LockedSkill> = {};
    for (const n of Object.keys(s.skills).sort(cmp)) {
      const k = s.skills[n];
      skills[n] = { path: k.path, hash: k.hash, ...(k.commit && k.commit !== s.commit ? { commit: k.commit } : {}) };
    }
    out[id] = { repo: s.repo, ref: s.ref, version: s.version, commit: s.commit, date: s.date, skills };
  }
  return JSON.stringify({ version: 2, sources: out }, null, 2) + "\n";
}

/** The version 2 lock file as it is, or null when absent or not a version 2 lock. */
export function readLockFile(root: string): Lock | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, LOCK_NAME), "utf8")) as Lock;
    return parsed?.version === 2 && parsed.sources && typeof parsed.sources === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The entries of skills-lock.json, when there is one; {} when absent or unreadable. */
export function npxLockEntries(root: string): Record<string, LockEntry> {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, NPX_LOCK_NAME), "utf8")) as { skills?: Record<string, LockEntry> }).skills ?? {};
  } catch {
    return {};
  }
}

/**
 * Whether skills-lock.json is a version 1 lock skills-sync wrote: it parses, has at least one entry, and every entry
 * carries the commit it was taken at, which npx skills never writes. An npx skills lock of its own (one without commits,
 * or with no skills), or a file that does not parse (a merge left conflict markers in it), is never migrated or removed.
 */
export function hasOldLock(root: string): boolean {
  let entries: unknown;
  try {
    entries = (JSON.parse(fs.readFileSync(path.join(root, NPX_LOCK_NAME), "utf8")) as { skills?: unknown })?.skills;
  } catch {
    return false;
  }
  if (!entries || typeof entries !== "object") return false;
  const all = Object.values(entries as Record<string, LockEntry>);
  return all.length > 0 && all.every((e) => typeof e?.commit === "string");
}

/** The lock of a config library: the version 2 file, else a version 1 lock read as version 2 in memory, else null. */
export function readLock(root: string, config: Config): Lock | null {
  const v2 = readLockFile(root);
  if (v2) return v2;
  return hasOldLock(root) ? fromV1(npxLockEntries(root), config) : null;
}

/**
 * Version 1 entries grouped by the config source each belongs to (an entry counts for a source when it names that
 * source's repo). The source's commit is an unpinned skill's, else any skill's; version and date are not known.
 */
export function fromV1(entries: Record<string, LockEntry>, config: Config): Lock {
  const sources: Record<string, LockedSource> = {};
  for (const id of Object.keys(config.sources).sort(cmp)) {
    const src = config.sources[id];
    const mine = selection(src)
      .map((s) => [s, entries[s.name]] as const)
      .filter(([, e]) => e && e.source === lockSource(src) && e.commit && e.skillPath);
    if (!mine.length) continue;
    const commit = (mine.find(([s]) => !src.pins?.[s.upstream]) ?? mine[0])[1].commit!;
    const skills: Record<string, LockedSkill> = {};
    for (const [s, e] of mine) skills[s.name] = { path: path.posix.dirname(e.skillPath!), hash: e.computedHash ?? "", ...(e.commit !== commit ? { commit: e.commit } : {}) };
    sources[id] = { repo: src.repo, ref: src.ref, version: null, commit, date: "", skills };
  }
  return { version: 2, sources, migrated: true };
}

/** A source's entry in the lock, which counts only while it names the repo the config gives the source. */
export function lockedSource(lock: Lock | null, id: string, src: { repo: string }): LockedSource | undefined {
  const s = lock?.sources[id];
  return s?.repo === src.repo ? s : undefined;
}

/** Every working-set name the lock records, sorted. */
export function lockedNames(lock: Lock | null): string[] {
  return Object.values(lock?.sources ?? {})
    .flatMap((s) => Object.keys(s.skills ?? {}))
    .sort(cmp);
}
