// Refresh (the update command): resolve every source, or only the ones named (the rest frozen, their lock entries kept
// as they are), at the tip of its ref, or at the release a held version or --to names (except skills held by a pin),
// and its upstream version; snapshot the selected skills under upstream/, rebuild the third-party working set, write
// skills-sync.lock.json (a version 1 skills-lock.json is migrated to it and removed). It never writes skills-sync.json:
// the change a --to needs is returned for the caller to land. Frozen: each skill at the commit the lock records (a
// version 1 lock read in memory), nothing moves, no lock is written. A skill whose snapshot already holds the content of the commit it
// resolves to is not fetched again, so a refresh with nothing new is silent and needs no clone. What upstream has under
// a source's root at its commit is recorded in .snapshot.json: a "*" source selects all of it, and a source that selects
// by a list or a map is told each folder it leaves out (`unselected`), so a skill upstream adds is never skipped in silence.
import fs from "node:fs";
import path from "node:path";
import { adaptFiles, compileAdapt, forbiddenInFiles, hasAdapt } from "./adapt.js";
import { lf } from "./build.js";
import { moved, type Moved } from "./changelog.js";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import {
  hasOldLock,
  LOCK_NAME,
  lockedSource,
  lockText,
  readLock,
  type Lock,
  type LockedSkill,
  type LockedSource,
} from "./lock.js";
import {
  cloneUrl,
  cmp,
  findSkills,
  isCommit,
  lockedUpstream,
  readConfig,
  selection,
  selectsAll,
  skillHash,
  withName,
  type Config,
  type Selected,
  type Source,
} from "./sources.js";
import { discard, git, moveTo, remoteTip, stage, type Staged } from "./stage.js";
import {
  compareVersions,
  isPrerelease,
  listVersions,
  plainVersion,
  resolveVersion,
  type Release,
  type SourceVersion,
} from "./versions.js";

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
  /** per source resolved upstream that selects by a list or a map: every skill folder under its root at the commit that
   *  it does not select, as source:upstream-name (a "*" source selects them all, so it never has any) */
  unselected: string[];
  /** folders a "*" source found upstream under a name another source already ships, or an own skill has: left out (a
   *  name only "*" brings in never displaces one), as source:name; shadowedBy says whose name it is (a source id, or
   *  "an own skill"), keyed the same */
  shadowed: string[];
  shadowedBy: Record<string, string>;
  /** per source resolved upstream with adapt rules or forbid patterns: every forbidden term its rules leave in a skill
   *  whose content is new to the lock, as source:skill/file:line: term (a warning: check fails on it after the build) */
  forbidden: string[];
  /** per such source, every adapt rule that matches nothing in its skills at the new commit */
  unusedRules: Array<{ source: string; rule: number; find: string }>;
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
  /** every skill folder name under the source's root at commit, selected or not: what a "*" source takes and what a
   *  listed one is told it leaves out, known without a clone while the commit stands; absent before 0.10.0 */
  upstream?: string[];
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
  const result: RefreshResult = {
    report: new Report(),
    sources: {},
    gone: [],
    unselected: [],
    shadowed: [],
    shadowedBy: {},
    forbidden: [],
    unusedRules: [],
    unlocked: [],
    problems: [],
    updated: [],
    config: [],
  };
  const report = result.report;
  const staged = new Map<string, Staged>(
    Object.entries(opts.prestaged ?? {}).map(([id, s]) => [`${id}@${s.commit}`, s]),
  );
  const found = new Map<string, Map<string, string>>(); // skills discovered per checkout
  const resolved: Resolved[] = [];
  const selected = new Set<string>();
  const own = new Set(lib.scanOwn().skills.map((s) => s.name));
  const claims = claimed(config, old, own);
  try {
    for (const id of Object.keys(config.sources).sort(cmp)) {
      const src = config.sources[id];
      const frozen = opts.frozen || (!!opts.only && !opts.only.includes(id));
      const url = cloneUrl(src.repo);
      const snapDir = path.join(lib.upstream, id);
      const meta = readMeta(snapDir);
      // this source in the lock (only while it names the same repo); its skills by working-set name, each at its commit
      const prior = lockedSource(old, id, src);
      // a "*" source selects what upstream has at its commit, known once the commit is (below); frozen, what the lock
      // holds, or without a lock entry what the snapshot holds, so its working copies stay as a list source's do
      const all = selectsAll(src);
      const held = prior ? lockedUpstream(prior.skills) : Object.keys(meta?.skills ?? {});
      let sel = all && !frozen ? [] : selection(src, held);
      for (const s of sel) selected.add(s.name);
      let wanted = sel.filter((s) => !opts.unavailable.includes(s.name));
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
        // a "*" source that did not resolve keeps every skill the lock (or the snapshot) has, working copies included
        if (all) for (const s of selection(src, held)) selected.add(s.name);
        if (!prior) return;
        const names = new Set(all ? Object.keys(prior.skills) : sel.map((s) => s.name));
        next[id] = { ...prior, skills: Object.fromEntries(Object.entries(prior.skills).filter(([n]) => names.has(n))) };
      };
      const listed = (co: Staged): string[] => {
        if (!found.has(co.dir)) found.set(co.dir, findSkills(co.dir, src.root));
        return [...found.get(co.dir)!.keys()].sort(cmp);
      };

      // 1. the source's commit: frozen takes the lock's; a version (--to, else the held one) that release's commit, found
      //    in a clone of ref's history; latest takes the tip of ref
      const want = frozen ? undefined : (opts.to?.[id] ?? src.version);
      let commit: string | null;
      if (frozen) {
        if (!prior || !wanted.some((s) => mine(s))) {
          result.unlocked.push(...(all && !wanted.length ? [`${id}:*`] : wanted.map((s) => `${id}:${s.name}`)));
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
        if (opts.to?.[id] && src.version !== (pick as Release).version)
          result.config.push({ source: id, version: (pick as Release).version });
      } else if (isCommit(src.ref)) commit = src.ref;
      else {
        commit = remoteTip(url, src.ref);
        if (!commit) {
          result.problems.push(`${id}: cannot reach ${url} (${src.ref})`);
          keep();
          continue;
        }
      }

      // 1b. what upstream has under the root at that commit: the snapshot's record while the commit stands, else a
      //     checkout's (one the version or the move needs anyway). A "*" source selects it all (pins included, renames
      //     applied); a list or a map is told every folder it leaves out. A frozen run lists nothing it lacks.
      let listing: string[] | null = meta?.commit === commit && Array.isArray(meta.upstream) ? meta.upstream : null;
      if (!listing && !frozen) {
        const co = checkout(commit);
        if (!co) {
          keep();
          continue;
        }
        listing = listed(co);
      }
      if (!frozen && listing) {
        if (all) {
          // a rename onto a name another upstream folder keeps (or two renames onto one name) gives two skills one name
          const clash = renameClashes(id, src, listing);
          if (clash.length) {
            result.problems.push(...clash);
            keep();
            continue;
          }
          // a name only "*" brings in (not in this source's lock, not a rename or a pin the config asks for) never
          // displaces another source's skill or an own skill: it is left out and named
          const explicit = (s: Selected) =>
            !!prior?.skills?.[s.name] || !!src.rename?.[s.upstream] || !!src.pins?.[s.upstream];
          sel = selection(src, listing).filter((s) => {
            const by = claims.get(s.name);
            if (!by || by === id || explicit(s)) return true;
            result.shadowed.push(`${id}:${s.name}`);
            result.shadowedBy[`${id}:${s.name}`] = by;
            return false;
          });
          for (const s of sel) selected.add(s.name);
          wanted = sel.filter((s) => !opts.unavailable.includes(s.name));
          // a rename for a folder upstream does not have is a name the config gives to nothing
          for (const [from, to] of Object.entries(src.rename ?? {}))
            if (!listing.includes(from) && !src.pins?.[from] && !opts.unavailable.includes(to))
              result.gone.push(`${id}:${to}`);
        } else {
          const taken = new Set(sel.map((s) => s.upstream));
          result.unselected.push(...listing.filter((n) => !taken.has(n)).map((n) => `${id}:${n}`));
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
        const at: string = frozen ? l!.commit : (src.pins?.[s.upstream] ?? commit);
        const snap = l && l.commit === at ? path.join(snapDir, l.path) : null;
        if (snap && l!.hash && isSkillDir(snap) && skillHash(snap) === l!.hash) {
          here.push({
            ...s,
            source: id,
            dir: snap,
            rel: l!.path,
            snapshot: snap,
            fromSnapshot: true,
            locked: { ...l!, commit: at },
          });
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
        here.push({
          ...s,
          source: id,
          dir: path.join(co.dir, rel),
          rel,
          snapshot: path.join(snapDir, rel),
          fromSnapshot: false,
          locked: { path: rel, hash: skillHash(path.join(co.dir, rel)), commit: at },
        });
      }
      if (failed) {
        keep();
        continue;
      }
      // 2b. the source's adapt rules over what upstream has now, when any skill's content is new: a forbidden term they
      //     leave there, or a rule that no longer matches, is named now rather than first seen as a failed check
      if (!frozen && hasAdapt(src.adapt)) {
        const fresh = here.filter((r) => prior?.skills?.[r.name]?.hash !== r.locked.hash);
        const c = compileAdapt(src.adapt, `sources.${id}.adapt`);
        if (fresh.length && c.ok) {
          const counts = c.compiled.rules.map(() => 0);
          for (const r of here) {
            // the text as build will see it: the working-set copy (its rename applied) in a package's line endings
            const files = new Map([...folderFiles(r.dir)].map(([rel, bytes]) => [rel, lf(bytes)]));
            const md = files.get("SKILL.md");
            if (md && r.name !== r.upstream) files.set("SKILL.md", Buffer.from(withName(md.toString("utf8"), r.name)));
            const a = adaptFiles(files, c.compiled);
            a.counts.forEach((n, i) => (counts[i] += n));
            if (fresh.includes(r))
              for (const h of forbiddenInFiles(a.files, c.compiled))
                result.forbidden.push(`${id}:${r.name}/${h.rel}:${h.line}: ${h.term}`);
          }
          (src.adapt.rules ?? []).forEach((rule, i) => {
            if (!counts[i]) result.unusedRules.push({ source: id, rule: i, find: rule.find });
          });
        }
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
        ? {
            version: prior!.version,
            ahead: fromMeta && meta!.version === prior!.version ? (meta!.ahead ?? null) : null,
          }
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
      const v: SourceVersion | null =
        frozen && fromLock
          ? { version: known!.version, ahead: fresh?.version === known!.version ? fresh.ahead : known!.ahead }
          : (fresh ?? known);
      result.sources[id] = { version: v?.version ?? null, ahead: v?.ahead ?? null, commit, date, moved: !sameCommit };
      if (!frozen) {
        next[id] = { repo: src.repo, ref: src.ref, version: v!.version, commit, date, skills: {} };
        if (opts.to?.[id] === "latest" && src.version) result.config.push({ source: id, version: null });
        if (prior?.commit !== commit) {
          if (!co) co = checkout(commit) ?? undefined;
          const from = prior
            ? { version: prior.version, commit: prior.commit, ahead: aheadOf(prior, meta, co, src.root) }
            : null;
          result.updated.push(
            moved(
              id,
              from,
              { version: v?.version ?? null, commit, ahead: v?.ahead ?? null },
              co?.dir ?? null,
              src.root,
            ),
          );
        }
      } else if (!opts.frozen) {
        // not named in an update: its lock entry as it is (a version 1 lock's gains the version and date it lacked)
        keep();
        if (next[id] && old!.migrated) next[id] = { ...next[id], version: v?.version ?? null, date };
      }

      // 4. the snapshot: the selected folders and attribution files at their upstream paths, plus .snapshot.json
      for (const r of here) {
        if (r.fromSnapshot || (isSkillDir(r.snapshot) && skillHash(r.snapshot) === r.locked.hash))
          report.add({ kind: "skip", path: r.snapshot, note: "ok" });
        else
          report.add({
            kind: "copy",
            path: r.snapshot,
            target: r.dir,
            note: `snapshot at ${r.locked.commit.slice(0, 7)}`,
          });
      }
      const paths = new Set(here.map((r) => r.rel));
      if (frozen) for (const s of sel) if (mine(s)) paths.add(mine(s)!.path);
      for (const rel of findSkills(snapDir, undefined, 6).values())
        if (!paths.has(rel)) report.add({ kind: "delete", path: path.join(snapDir, rel), note: "no longer selected" });
      for (const f of copied) {
        const dst = path.join(snapDir, f);
        const bytes = co ? fs.readFileSync(path.join(co.dir, f)) : null;
        if (bytes && (!fs.existsSync(dst) || !bytes.equals(fs.readFileSync(dst))))
          report.add({ kind: "write", path: dst, payload: bytes, note: "attribution" });
        else report.add({ kind: "skip", path: dst, note: "ok" });
      }
      for (const f of meta?.attribution ?? [])
        if (!copied.includes(f) && fs.existsSync(path.join(snapDir, f)))
          report.add({ kind: "delete", path: path.join(snapDir, f), note: "no longer listed as attribution" });
      const skills: SnapshotMeta["skills"] = {};
      for (const r of [...here].sort((a, b) => cmp(a.upstream, b.upstream)))
        skills[r.upstream] = { path: r.rel, hash: r.locked.hash, commit: r.locked.commit };
      const metaNext: SnapshotMeta = {
        source: id,
        repo: src.repo,
        ref: src.ref,
        commit,
        date,
        version: v?.version,
        ahead: v ? v.ahead : undefined,
        skills,
        upstream: listing ?? (co ? listed(co) : undefined),
        attribution: copied,
        absent,
      };
      writeIfChanged(
        report,
        path.join(snapDir, ".snapshot.json"),
        JSON.stringify(metaNext, null, 2) + "\n",
        `${here.length} skills at ${commit.slice(0, 7)}`,
      );
      resolved.push(...here);
    }

    // 5. snapshots of sources no longer in the config
    if (isDir(lib.upstream)) {
      for (const id of fs.readdirSync(lib.upstream).sort(cmp))
        if (!config.sources[id] && isDir(path.join(lib.upstream, id)))
          report.add({
            kind: "delete",
            path: path.join(lib.upstream, id),
            note: "source no longer in skills-sync.json",
          });
    }

    // 6. the working set: one copy per resolved skill with its rename applied; copies no longer selected go.
    // One name from two sources: the first source by id wins and owns the lock entry; the other is reported until the
    // config renames it (a name only "*" brings in was left out above instead, so it never wins here).
    const taken = new Map<string, string>();
    for (const r of resolved.sort((a, b) => cmp(a.name, b.name) || cmp(a.source, b.source))) {
      const winner = taken.get(r.name);
      if (winner)
        report.add({
          kind: "conflict",
          path: path.join(lib.agents, r.name),
          note: `${r.source} also selects ${r.upstream} as ${r.name}; ${winner} wins; rename one in skills-sync.json`,
        });
      else {
        taken.set(r.name, r.source);
        lockSkills.set(r.source, { ...lockSkills.get(r.source), [r.name]: r.locked });
        workingCopy(lib, r, own, report);
      }
    }
    if (isDir(lib.agents)) {
      for (const n of fs.readdirSync(lib.agents).sort(cmp)) {
        const p = path.join(lib.agents, n);
        if (n.startsWith(".") || RESERVED.has(n) || isLink(p) || !isSkillDir(p) || own.has(n) || selected.has(n))
          continue;
        report.add({ kind: "delete", path: p, note: "no longer selected in skills-sync.json" });
      }
    }

    // 7. the lock: what this refresh resolved (a pinned skill's commit only where it differs from its source's), and a
    //    version 1 lock goes; never when frozen
    if (!opts.frozen) {
      for (const [id, skills] of lockSkills)
        if (next[id] && (!opts.only || opts.only.includes(id))) next[id].skills = skills;
      writeIfChanged(report, lib.lockFile, lockText(next), "what this refresh resolved");
      if (hasOldLock(lib.root))
        report.add({ kind: "delete", path: lib.npxLockFile, note: `old lock format, migrated to ${LOCK_NAME}` });
    }

    apply(report, opts.plan);
  } finally {
    for (const s of staged.values()) discard(s);
  }
  return result;
}

/**
 * The lock a refresh would write from the snapshots as they are, with no network (a "*" source selects what its snapshot
 * holds, or the lock without one): per source that has a snapshot, its version, commit and date as the snapshot
 * records them and one entry per selected skill the snapshot holds, hashed from its folder there; a source without a snapshot keeps what the lock has for it, as a refresh that cannot reach it
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
    const prior = lockedSource(old, id, src);
    // a "*" source selects what the snapshot holds, or without one what the lock has
    const held = meta ? Object.keys(meta.skills ?? {}) : lockedUpstream(prior?.skills);
    const sel = selection(src, held).filter((s) => !taken.has(s.name));
    if (!meta) {
      if (!prior) continue;
      next[id] = {
        ...prior,
        skills: Object.fromEntries(sel.filter((s) => prior.skills[s.name]).map((s) => [s.name, prior.skills[s.name]])),
      };
    } else {
      snapshots++;
      const skills: Record<string, LockedSkill> = {};
      for (const s of sel) {
        const snap = meta.skills?.[s.upstream];
        if (!snap) continue;
        const dir = path.join(snapDir, snap.path);
        skills[s.name] = { path: snap.path, hash: isSkillDir(dir) ? skillHash(dir) : snap.hash, commit: snap.commit };
      }
      next[id] = {
        repo: src.repo,
        ref: src.ref,
        version: meta.version ?? null,
        commit: meta.commit,
        date: meta.date,
        skills,
      };
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
    return (
      releases.find((r) => !isPrerelease(r.version) && compareVersions(r.version, current) < 0) ??
      `previous: no release below ${current}`
    );
  }
  const v = plainVersion(want) ?? want;
  return releases.find((r) => r.version === v) ?? `${want} is not a release`;
}

/** How far past its version a source's locked commit was: what the snapshot recorded there, else counted in a checkout that has that commit. */
function aheadOf(
  prior: LockedSource,
  meta: SnapshotMeta | null,
  co: Staged | undefined,
  root: string | undefined,
): number | null {
  if (meta?.commit === prior.commit && meta.version === prior.version && meta.ahead !== undefined) return meta.ahead;
  if (!co || prior.version === null || !git(["cat-file", "-e", `${prior.commit}^{commit}`], co.dir).ok) return null;
  const v = resolveVersion(co.dir, prior.commit, root);
  return v.version === prior.version ? v.ahead : null;
}

/** The working-set copy of one resolved skill; skipped when its files already equal the snapshot's with the rename applied. */
function workingCopy(lib: Library, r: Resolved, own: Set<string>, report: Report): void {
  const dst = path.join(lib.agents, r.name);
  if (own.has(r.name)) {
    report.add({
      kind: "conflict",
      path: dst,
      note: `an own skill is named ${r.name}; the third-party one is left out of the working set`,
    });
    return;
  }
  if (isLink(dst)) {
    report.add({ kind: "conflict", path: dst, note: "a link is in the way of a third-party copy; left alone" });
    return;
  }
  const renamed = r.name !== r.upstream;
  const expected = folderFiles(r.dir);
  if (renamed)
    expected.set("SKILL.md", Buffer.from(withName(expected.get("SKILL.md")?.toString("utf8") ?? "", r.name)));
  if (isDir(dst) && sameFiles(folderFiles(dst), expected)) {
    report.add({ kind: "skip", path: dst, note: "ok" });
    return;
  }
  // copied from the snapshot, which exists by then: its copy action comes earlier in the same report
  report.add({ kind: "copy", path: dst, target: r.snapshot, note: renamed ? `renamed from ${r.upstream}` : undefined });
  if (renamed)
    report.add({
      kind: "write",
      path: path.join(dst, "SKILL.md"),
      payload: expected.get("SKILL.md"),
      note: `frontmatter name: ${r.name}`,
    });
}

/** A write of `text` unless the file already says it: CRLF line endings on disk (a checkout under core.autocrlf=true) are no difference. */
function writeIfChanged(report: Report, file: string, text: string, note: string): void {
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  if (fs.existsSync(file) && lf(fs.readFileSync(file, "utf8")) === lf(text))
    report.add({ kind: "skip", path: file, note: "ok" });
  else report.add({ kind: "write", path: file, payload: text, note });
}

/**
 * Every working-set name something already has, and whose it is: an own skill ("an own skill"), a name a list or a map
 * selects, and a "*" source's locked names and rename targets (its source id). A name only "*" brings in is checked
 * against these before it is taken.
 */
function claimed(config: Config, old: Lock | null, own: Set<string>): Map<string, string> {
  const out = new Map<string, string>([...own].map((n) => [n, "an own skill"]));
  for (const id of Object.keys(config.sources).sort(cmp)) {
    const src = config.sources[id];
    const names = selectsAll(src)
      ? [...Object.keys(lockedSource(old, id, src)?.skills ?? {}), ...Object.values(src.rename ?? {})]
      : selection(src).map((s) => s.name);
    for (const n of names) if (!out.has(n)) out.set(n, id);
  }
  return out;
}

/** A "*" source's renames that give two of its upstream folders one name: onto a folder kept as it is, or two onto one. */
function renameClashes(id: string, src: Source, listing: string[]): string[] {
  const rename = src.rename ?? {};
  const out: string[] = [];
  const onto = new Map<string, string>();
  for (const [from, to] of Object.entries(rename)) {
    if (!listing.includes(from)) continue;
    if (listing.includes(to) && !rename[to])
      out.push(
        `${id}: rename ${from} -> ${to} takes the name of the folder ${to} upstream also has; pick another name`,
      );
    const first = onto.get(to);
    if (first) out.push(`${id}: rename ${first} -> ${to} and ${from} -> ${to} give two skills one name; pick another`);
    else onto.set(to, from);
  }
  return out;
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
