// Refresh (the update command): resolve every source, or only the ones named (the rest frozen, their lock entries kept
// as they are), at the tip of its ref, or at the release a held version or --to names (except skills held by a pin),
// and its upstream version; snapshot the selected skills under upstream/, rebuild the third-party working set, write
// skills-sync.lock.json (a version 1 skills-lock.json is migrated to it and removed). It never writes skills-sync.json:
// the change a --to needs is returned for the caller to land. Frozen: each skill at the commit the lock records (a
// version 1 lock read in memory), nothing moves, no lock is written. A skill whose snapshot already holds the content of the commit it
// resolves to is not fetched again, so a refresh with nothing new is silent and needs no clone.
import fs from "node:fs";
import path from "node:path";
import { moved, type Moved } from "./changelog.js";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { hasOldLock, LOCK_NAME, lockText, readLock, type LockedSkill, type LockedSource } from "./lock.js";
import { cloneUrl, cmp, findSkills, isCommit, readConfig, selection, skillHash, withName, type Selected } from "./sources.js";
import { discard, git, moveTo, remoteTip, stage, type Staged } from "./stage.js";
import { compareVersions, isPrerelease, listVersions, plainVersion, resolveVersion, type Release, type SourceVersion } from "./versions.js";

export interface RefreshOptions {
  /** every skill at the commit the lock records; a skill the lock does not know is left alone; the lock is not written */
  frozen: boolean;
  /** the sources resolved upstream (all when absent); every other one resolves frozen and keeps its lock entry as it is */
  only?: string[];
  /** per source, where to resolve it instead of its held version (or the tip when none is held): a plain version, previous or latest */
  to?: Record<string, string>;
  plan: boolean;
  /** skills an earlier refresh reported gone upstream; not looked for until --retry clears the list */
  unavailable: string[];
  log: (s: string) => void;
  /** checkouts the caller already staged (add), by source id; refresh discards them with its own */
  prestaged?: Record<string, Staged>;
}

export interface RefreshResult {
  report: Report;
  /** per source that resolved: its commit, its version and how many commits past it, and whether the snapshot was at another commit */
  sources: Record<string, SourceVersion & { commit: string; date: string; moved: boolean }>;
  /** selected skills not found upstream this run, as source:name */
  gone: string[];
  /** selected skills the lock records no commit for, in frozen mode, as source:name */
  unlocked: string[];
  /** sources that could not be staged; their lock entries and snapshots are kept as they were */
  problems: string[];
  /** per source whose commit is not the one the lock had: where it was (null for a source new to the lock), where it is
   *  now, and the upstream changelog sections between the two versions it brings or undoes (null with the reason) */
  updated: Moved[];
  /** the version edits skills-sync.json needs for a --to to hold (null: remove the hold); the tool never makes them */
  config: Array<{ source: string; version: string | null }>;
  /** a version asked for that the source has not released, with the ones it has: nothing was written */
  refused?: string;
}

export type { Position } from "./changelog.js";

/** What .snapshot.json records beside a source's snapshot. */
interface SnapshotMeta {
  source: string;
  repo: string;
  ref: string;
  commit: string;
  date: string;
  /** the source's version at commit, and how many commits past it; absent when not known (a frozen run from a version 1 lock) */
  version?: string | null;
  ahead?: number | null;
  skills: Record<string, { path: string; hash: string; commit: string }>;
  /** attribution files copied, and those the config lists that upstream lacks at this commit */
  attribution: string[];
  absent: string[];
}

/** One resolved skill: where its folder is right now (a checkout, or the snapshot when that already matches), its snapshot path and its lock entry (with its commit). */
interface Resolved extends Selected {
  source: string;
  dir: string;
  /** the skill folder relative to the repo root, / separators */
  rel: string;
  snapshot: string;
  fromSnapshot: boolean;
  locked: Required<LockedSkill>;
}

export function refresh(lib: Library, opts: RefreshOptions): RefreshResult {
  const config = readConfig(lib.configFile);
  const old = readLock(lib.root, config);
  const next: Record<string, LockedSource> = {};
  const lockSkills = new Map<string, Record<string, LockedSkill>>(); // per source, the skills it won in the working set
  const result: RefreshResult = { report: new Report(), sources: {}, gone: [], unlocked: [], problems: [], updated: [], config: [] };
  const report = result.report;
  const staged = new Map<string, Staged>(Object.entries(opts.prestaged ?? {}).map(([id, s]) => [`${id}@${s.commit}`, s]));
  const found = new Map<string, Map<string, string>>(); // skills discovered per checkout
  const resolved: Resolved[] = [];
  const selected = new Set<string>();
  try {
    for (const id of Object.keys(config.sources).sort(cmp)) {
      const src = config.sources[id];
      const frozen = opts.frozen || (!!opts.only && !opts.only.includes(id));
      const sel = selection(src);
      for (const s of sel) selected.add(s.name);
      const wanted = sel.filter((s) => !opts.unavailable.includes(s.name));
      const url = cloneUrl(src.repo);
      const snapDir = path.join(lib.upstream, id);
      const meta = readMeta(snapDir);
      // this source in the lock, which counts only while it names the same repo; its skills by working-set name, each at its commit
      const prior = old?.sources[id]?.repo === src.repo ? old.sources[id] : undefined;
      const mine = (s: Selected): Required<LockedSkill> | undefined => {
        const k = prior?.skills?.[s.name];
        return k ? { path: k.path, hash: k.hash, commit: k.commit ?? prior!.commit } : undefined;
      };
      const checkout = (at: string): Staged | null => {
        const key = `${id}@${at}`;
        const have = staged.get(key);
        if (have) return have;
        // the source commit was seen as the tip of ref; a host that cannot serve a bare commit gets the ref cloned
        const r = stage(url, at, opts.log, at === commit && !isCommit(src.ref) ? src.ref : undefined);
        if (!r.ok) {
          result.problems.push(`${id}: ${r.error}`);
          return null;
        }
        staged.set(key, r.staged);
        return r.staged;
      };
      const keep = () => {
        if (!prior) return;
        const names = new Set(sel.map((s) => s.name));
        next[id] = { ...prior, skills: Object.fromEntries(Object.entries(prior.skills).filter(([n]) => names.has(n))) };
      };

      // 1. the source's commit: frozen takes the lock's; a version (--to, else the held one) that release's commit, found
      //    in a clone of ref's history; latest takes the tip of ref
      const want = frozen ? undefined : opts.to?.[id] ?? src.version;
      let commit: string | null;
      if (frozen) {
        if (!prior || !wanted.some((s) => mine(s))) {
          result.unlocked.push(...wanted.map((s) => `${id}:${s.name}`));
          keep();
          continue;
        }
        commit = prior.commit;
      } else if (want && want !== "latest") {
        const r = stage(url, src.ref, opts.log);
        if (!r.ok) {
          result.problems.push(`${id}: ${r.error}`);
          keep();
          continue;
        }
        const releases = listVersions(r.staged.dir, r.staged.commit, src.root);
        const pick = pickRelease(releases, want, prior?.version ?? null);
        const at = typeof pick === "string" ? null : moveTo(r.staged, pick.commit);
        if (!at) {
          discard(r.staged);
          const known = releases.length ? releases.map((x) => x.version).join(", ") : "none";
          result.refused = `${id}: ${typeof pick === "string" ? pick : `cannot check out ${want}`} (versions: ${known})`;
          return result;
        }
        staged.set(`${id}@${at.commit}`, at);
        commit = at.commit;
        if (opts.to?.[id] && src.version !== (pick as Release).version) result.config.push({ source: id, version: (pick as Release).version });
      } else if (isCommit(src.ref)) commit = src.ref;
      else {
        commit = remoteTip(url, src.ref);
        if (!commit) {
          result.problems.push(`${id}: cannot reach ${url} (${src.ref})`);
          keep();
          continue;
        }
      }

      // 2. each selected skill at its commit (the lock's when frozen; its pin, else the source's), from the snapshot when
      //    that already holds the content of that commit, else from a checkout
      const here: Resolved[] = [];
      let failed = false;
      for (const s of wanted) {
        const l = mine(s);
        if (frozen && !l) {
          result.unlocked.push(`${id}:${s.name}`);
          continue;
        }
        const at: string = frozen ? l!.commit : src.pins?.[s.upstream] ?? commit;
        const snap = l && l.commit === at ? path.join(snapDir, l.path) : null;
        if (snap && l!.hash && isSkillDir(snap) && skillHash(snap) === l!.hash) {
          here.push({ ...s, source: id, dir: snap, rel: l!.path, snapshot: snap, fromSnapshot: true, locked: { ...l!, commit: at } });
          continue;
        }
        const co = checkout(at);
        if (!co) {
          failed = true;
          break;
        }
        if (!found.has(co.dir)) found.set(co.dir, findSkills(co.dir, src.root));
        const rel = found.get(co.dir)!.get(s.upstream);
        if (!rel) {
          result.gone.push(`${id}:${s.name}`);
          continue;
        }
        here.push({ ...s, source: id, dir: path.join(co.dir, rel), rel, snapshot: path.join(snapDir, rel), fromSnapshot: false, locked: { path: rel, hash: skillHash(path.join(co.dir, rel)), commit: at } });
      }
      if (failed) {
        keep();
        continue;
      }

      // 3. attribution files and the version come from a checkout of the source's commit; the snapshot stands when it
      //    already has the files at this commit, and the version stands when the lock (or the snapshot) knows it there
      const attribution = src.attribution ?? [];
      const knownAbsent = (meta?.absent ?? []).filter((f) => attribution.includes(f));
      const snapshotLacks = attribution.some((f) => !knownAbsent.includes(f) && !fs.existsSync(path.join(snapDir, f)));
      const sameCommit = meta?.commit === commit;
      const fromLock = !!prior && !old!.migrated && prior.commit === commit;
      const fromMeta = sameCommit && meta!.version !== undefined;
      const known: SourceVersion | null = fromLock
        ? { version: prior!.version, ahead: fromMeta && meta!.version === prior!.version ? meta!.ahead ?? null : null }
        : fromMeta
          ? { version: meta!.version!, ahead: meta!.ahead ?? null }
          : null;
      let co = staged.get(`${id}@${commit}`);
      if (!co && (!sameCommit || snapshotLacks || (!known && !frozen))) co = checkout(commit) ?? undefined;
      if (!co && (!sameCommit || (!known && !frozen))) {
        keep();
        continue;
      }
      const absent = co ? attribution.filter((f) => !fs.existsSync(path.join(co!.dir, f))) : knownAbsent;
      const copied = attribution.filter((f) => !absent.includes(f));
      const date = co ? co.date : meta!.date;
      // frozen holds the lock's version; otherwise a checkout says what the commit is now (a tag may have come since)
      const fresh = co ? resolveVersion(co.dir, commit, src.root) : null;
      const v: SourceVersion | null = frozen && fromLock ? { version: known!.version, ahead: fresh?.version === known!.version ? fresh.ahead : known!.ahead } : fresh ?? known;
      result.sources[id] = { version: v?.version ?? null, ahead: v?.ahead ?? null, commit, date, moved: !sameCommit };
      if (!frozen) {
        next[id] = { repo: src.repo, ref: src.ref, version: v!.version, commit, date, skills: {} };
        if (opts.to?.[id] === "latest" && src.version) result.config.push({ source: id, version: null });
        if (prior?.commit !== commit) {
          if (!co) co = checkout(commit) ?? undefined;
          const from = prior ? { version: prior.version, commit: prior.commit, ahead: aheadOf(prior, meta, co, src.root) } : null;
          result.updated.push(moved(id, from, { version: v?.version ?? null, commit, ahead: v?.ahead ?? null }, co?.dir ?? null, src.root));
        }
      } else if (!opts.frozen) {
        // not named in an update: its lock entry as it is (a version 1 lock's gains the version and date it lacked)
        keep();
        if (next[id] && old!.migrated) next[id] = { ...next[id], version: v?.version ?? null, date };
      }

      // 4. the snapshot: the selected folders and attribution files at their upstream paths, plus .snapshot.json
      for (const r of here) {
        if (r.fromSnapshot || (isSkillDir(r.snapshot) && skillHash(r.snapshot) === r.locked.hash)) report.add({ kind: "skip", path: r.snapshot, note: "ok" });
        else report.add({ kind: "copy", path: r.snapshot, target: r.dir, note: `snapshot at ${r.locked.commit.slice(0, 7)}` });
      }
      const paths = new Set(here.map((r) => r.rel));
      if (frozen) for (const s of sel) if (mine(s)) paths.add(mine(s)!.path);
      for (const rel of findSkills(snapDir, undefined, 6).values()) if (!paths.has(rel)) report.add({ kind: "delete", path: path.join(snapDir, rel), note: "no longer selected" });
      for (const f of copied) {
        const dst = path.join(snapDir, f);
        const bytes = co ? fs.readFileSync(path.join(co.dir, f)) : null;
        if (bytes && (!fs.existsSync(dst) || !bytes.equals(fs.readFileSync(dst)))) report.add({ kind: "write", path: dst, payload: bytes, note: "attribution" });
        else report.add({ kind: "skip", path: dst, note: "ok" });
      }
      for (const f of meta?.attribution ?? []) if (!copied.includes(f) && fs.existsSync(path.join(snapDir, f))) report.add({ kind: "delete", path: path.join(snapDir, f), note: "no longer listed as attribution" });
      const skills: SnapshotMeta["skills"] = {};
      for (const r of [...here].sort((a, b) => cmp(a.upstream, b.upstream))) skills[r.upstream] = { path: r.rel, hash: r.locked.hash, commit: r.locked.commit };
      const metaNext: SnapshotMeta = { source: id, repo: src.repo, ref: src.ref, commit, date, version: v?.version, ahead: v ? v.ahead : undefined, skills, attribution: copied, absent };
      writeIfChanged(report, path.join(snapDir, ".snapshot.json"), JSON.stringify(metaNext, null, 2) + "\n", `${here.length} skills at ${commit.slice(0, 7)}`);
      resolved.push(...here);
    }

    // 5. snapshots of sources no longer in the config
    if (isDir(lib.upstream)) {
      for (const id of fs.readdirSync(lib.upstream).sort(cmp)) if (!config.sources[id] && isDir(path.join(lib.upstream, id))) report.add({ kind: "delete", path: path.join(lib.upstream, id), note: "source no longer in skills-sync.json" });
    }

    // 6. the working set: one copy per resolved skill with its rename applied; copies no longer selected go.
    // One name from two sources: the first source by id wins and owns the lock entry; the other is reported until the config renames it.
    const own = new Set(lib.scanOwn().skills.map((s) => s.name));
    const taken = new Map<string, string>();
    for (const r of resolved.sort((a, b) => cmp(a.name, b.name) || cmp(a.source, b.source))) {
      const winner = taken.get(r.name);
      if (winner) report.add({ kind: "conflict", path: path.join(lib.agents, r.name), note: `${r.source} also selects ${r.upstream} as ${r.name}; ${winner} wins; rename one in skills-sync.json` });
      else {
        taken.set(r.name, r.source);
        lockSkills.set(r.source, { ...lockSkills.get(r.source), [r.name]: r.locked });
        workingCopy(lib, r, own, report);
      }
    }
    if (isDir(lib.agents)) {
      for (const n of fs.readdirSync(lib.agents).sort(cmp)) {
        const p = path.join(lib.agents, n);
        if (n.startsWith(".") || RESERVED.has(n) || isLink(p) || !isSkillDir(p) || own.has(n) || selected.has(n)) continue;
        report.add({ kind: "delete", path: p, note: "no longer selected in skills-sync.json" });
      }
    }

    // 7. the lock: what this refresh resolved (a pinned skill's commit only where it differs from its source's), and a
    //    version 1 lock goes; never when frozen
    if (!opts.frozen) {
      for (const [id, skills] of lockSkills) if (next[id] && (!opts.only || opts.only.includes(id))) next[id].skills = skills;
      writeIfChanged(report, lib.lockFile, lockText(next), "what this refresh resolved");
      if (hasOldLock(lib.root)) report.add({ kind: "delete", path: lib.npxLockFile, note: `old lock format, migrated to ${LOCK_NAME}` });
    }

    apply(report, opts.plan);
  } finally {
    for (const s of staged.values()) discard(s);
  }
  return result;
}

/**
 * The lock a refresh would write from the snapshots as they are, with no network: per source that has a snapshot, its
 * version, commit and date as the snapshot records them and one entry per selected skill the snapshot holds, hashed
 * from its folder there; a source without a snapshot keeps what the lock has for it, as a refresh that cannot reach it
 * does. One name from two sources goes to the first source by id, as in refresh. null when no source has a snapshot.
 */
export function snapshotLock(lib: Library): Record<string, LockedSource> | null {
  const config = readConfig(lib.configFile);
  const old = readLock(lib.root, config);
  const next: Record<string, LockedSource> = {};
  const taken = new Set<string>();
  let snapshots = 0;
  for (const id of Object.keys(config.sources).sort(cmp)) {
    const src = config.sources[id];
    const snapDir = path.join(lib.upstream, id);
    const meta = readMeta(snapDir);
    const sel = selection(src).filter((s) => !taken.has(s.name));
    if (!meta) {
      const prior = old?.sources[id]?.repo === src.repo ? old.sources[id] : undefined;
      if (!prior) continue;
      next[id] = { ...prior, skills: Object.fromEntries(sel.filter((s) => prior.skills[s.name]).map((s) => [s.name, prior.skills[s.name]])) };
    } else {
      snapshots++;
      const skills: Record<string, LockedSkill> = {};
      for (const s of sel) {
        const snap = meta.skills?.[s.upstream];
        if (!snap) continue;
        const dir = path.join(snapDir, snap.path);
        skills[s.name] = { path: snap.path, hash: isSkillDir(dir) ? skillHash(dir) : snap.hash, commit: snap.commit };
      }
      next[id] = { repo: src.repo, ref: src.ref, version: meta.version ?? null, commit: meta.commit, date: meta.date, skills };
    }
    for (const n of Object.keys(next[id].skills)) taken.add(n);
  }
  return snapshots ? next : null;
}

/**
 * The release a --to (or a held version) names: a plain version (a leading v allowed), or previous, the highest stable
 * release below the lock's version; the reason when there is none.
 */
function pickRelease(releases: Release[], want: string, current: string | null): Release | string {
  if (want === "previous") {
    if (!current) return "previous: the lock records no version to go below";
    return releases.find((r) => !isPrerelease(r.version) && compareVersions(r.version, current) < 0) ?? `previous: no release below ${current}`;
  }
  const v = plainVersion(want) ?? want;
  return releases.find((r) => r.version === v) ?? `${want} is not a release`;
}

/** How far past its version a source's locked commit was: what the snapshot recorded there, else counted in a checkout that has that commit. */
function aheadOf(prior: LockedSource, meta: SnapshotMeta | null, co: Staged | undefined, root: string | undefined): number | null {
  if (meta?.commit === prior.commit && meta.version === prior.version && meta.ahead !== undefined) return meta.ahead;
  if (!co || prior.version === null || !git(["cat-file", "-e", `${prior.commit}^{commit}`], co.dir).ok) return null;
  const v = resolveVersion(co.dir, prior.commit, root);
  return v.version === prior.version ? v.ahead : null;
}

/** The working-set copy of one resolved skill; skipped when its files already equal the snapshot's with the rename applied. */
function workingCopy(lib: Library, r: Resolved, own: Set<string>, report: Report): void {
  const dst = path.join(lib.agents, r.name);
  if (own.has(r.name)) {
    report.add({ kind: "conflict", path: dst, note: `an own skill is named ${r.name}; the third-party one is left out of the working set` });
    return;
  }
  if (isLink(dst)) {
    report.add({ kind: "conflict", path: dst, note: "a link is in the way of a third-party copy; left alone" });
    return;
  }
  const renamed = r.name !== r.upstream;
  const expected = folderFiles(r.dir);
  if (renamed) expected.set("SKILL.md", Buffer.from(withName(expected.get("SKILL.md")?.toString("utf8") ?? "", r.name)));
  if (isDir(dst) && sameFiles(folderFiles(dst), expected)) {
    report.add({ kind: "skip", path: dst, note: "ok" });
    return;
  }
  // copied from the snapshot, which exists by then: its copy action comes earlier in the same report
  report.add({ kind: "copy", path: dst, target: r.snapshot, note: renamed ? `renamed from ${r.upstream}` : undefined });
  if (renamed) report.add({ kind: "write", path: path.join(dst, "SKILL.md"), payload: expected.get("SKILL.md"), note: `frontmatter name: ${r.name}` });
}

function writeIfChanged(report: Report, file: string, text: string, note: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) report.add({ kind: "skip", path: file, note: "ok" });
  else report.add({ kind: "write", path: file, payload: text, note });
}

function readMeta(snapDir: string): SnapshotMeta | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(snapDir, ".snapshot.json"), "utf8")) as SnapshotMeta;
  } catch {
    return null;
  }
}

/** Every file under a folder, relative path (/ separators) -> bytes. */
function folderFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.set(path.relative(dir, full).split("\\").join("/"), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function sameFiles(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !v.equals(w)) return false;
  }
  return true;
}
