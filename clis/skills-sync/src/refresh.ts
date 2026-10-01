// Refresh: resolve every source (the tip of its ref, except skills held by a pin), snapshot the selected skills under
// upstream/, rebuild the third-party working set, write skills-lock.json. Frozen: each skill at the commit the lock
// records, nothing moves, the lock is not written. A skill whose snapshot already holds the content of the commit it
// resolves to is not fetched again, so a refresh with nothing new is silent and needs no clone.
import fs from "node:fs";
import path from "node:path";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cloneUrl, cmp, findSkills, isCommit, lockEntry, lockSource, lockText, readConfig, selection, skillHash, withName, type LockEntry, type Selected } from "./sources.js";
import { discard, remoteTip, stage, type Staged } from "./stage.js";

export interface RefreshOptions {
  /** every skill at the commit the lock records; a skill the lock does not know is left alone; the lock is not written */
  frozen: boolean;
  plan: boolean;
  /** skills an earlier refresh reported gone upstream; not looked for until --retry clears the list */
  unavailable: string[];
  log: (s: string) => void;
  /** checkouts the caller already staged (add), by source id; refresh discards them with its own */
  prestaged?: Record<string, Staged>;
}

export interface RefreshResult {
  report: Report;
  /** per source that resolved: its commit and whether the snapshot was at another one */
  sources: Record<string, { commit: string; date: string; moved: boolean }>;
  /** selected skills not found upstream this run, as source:name */
  gone: string[];
  /** selected skills the lock records no commit for, in frozen mode, as source:name */
  unlocked: string[];
  /** sources that could not be staged; their lock entries and snapshots are kept as they were */
  problems: string[];
}

/** What .snapshot.json records beside a source's snapshot. */
interface SnapshotMeta {
  source: string;
  repo: string;
  ref: string;
  commit: string;
  date: string;
  skills: Record<string, { path: string; hash: string; commit: string }>;
  /** attribution files copied, and those the config lists that upstream lacks at this commit */
  attribution: string[];
  absent: string[];
}

/** One resolved skill: where its folder is right now (a checkout, or the snapshot when that already matches), its snapshot path and its lock entry. */
interface Resolved extends Selected {
  source: string;
  dir: string;
  /** the skill folder relative to the repo root, / separators */
  rel: string;
  snapshot: string;
  fromSnapshot: boolean;
  locked: LockEntry;
}

export function refresh(lib: Library, opts: RefreshOptions): RefreshResult {
  const config = readConfig(lib.configFile);
  const old = lib.lockEntries();
  const next: Record<string, LockEntry> = {};
  const result: RefreshResult = { report: new Report(), sources: {}, gone: [], unlocked: [], problems: [] };
  const report = result.report;
  const staged = new Map<string, Staged>(Object.entries(opts.prestaged ?? {}).map(([id, s]) => [`${id}@${s.commit}`, s]));
  const found = new Map<string, Map<string, string>>(); // skills discovered per checkout
  const resolved: Resolved[] = [];
  const selected = new Set<string>();
  try {
    for (const id of Object.keys(config.sources).sort(cmp)) {
      const src = config.sources[id];
      const sel = selection(src);
      for (const s of sel) selected.add(s.name);
      const wanted = sel.filter((s) => !opts.unavailable.includes(s.name));
      const url = cloneUrl(src.repo);
      const snapDir = path.join(lib.upstream, id);
      const meta = readMeta(snapDir);
      // this source's lock entries, by working-set name; an entry counts only when it names this source's repo
      const mine = (s: Selected): LockEntry | undefined => {
        const e = old[s.name];
        return e && e.source === lockSource(src) ? e : undefined;
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
        for (const s of sel) {
          const e = mine(s);
          if (e) next[s.name] = e;
        }
      };

      // 1. the source's commit: frozen takes an unpinned entry's from the lock (else any entry's); latest takes the tip of ref
      let commit: string | null;
      if (opts.frozen) {
        const known = wanted.map((s) => [s, mine(s)] as const).filter(([, e]) => e?.commit);
        if (!known.length) {
          result.unlocked.push(...wanted.map((s) => `${id}:${s.name}`));
          keep();
          continue;
        }
        commit = (known.find(([s]) => !src.pins?.[s.upstream]) ?? known[0])[1]!.commit!;
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
        if (opts.frozen && !l?.commit) {
          result.unlocked.push(`${id}:${s.name}`);
          continue;
        }
        const at: string = opts.frozen ? l!.commit! : src.pins?.[s.upstream] ?? commit;
        const lockedDir = l?.skillPath ? path.posix.dirname(l.skillPath) : null;
        const snap = lockedDir && l!.commit === at ? path.join(snapDir, lockedDir) : null;
        if (snap && l!.computedHash && isSkillDir(snap) && skillHash(snap) === l!.computedHash) {
          here.push({ ...s, source: id, dir: snap, rel: lockedDir!, snapshot: snap, fromSnapshot: true, locked: lockEntry(src, lockedDir!, l!.computedHash, at) });
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
        here.push({ ...s, source: id, dir: path.join(co.dir, rel), rel, snapshot: path.join(snapDir, rel), fromSnapshot: false, locked: lockEntry(src, rel, skillHash(path.join(co.dir, rel)), at) });
      }
      if (failed) {
        keep();
        continue;
      }

      // 3. attribution files come from a checkout; the snapshot stands when it already has them at this commit
      const attribution = src.attribution ?? [];
      const knownAbsent = (meta?.absent ?? []).filter((f) => attribution.includes(f));
      const snapshotLacks = attribution.some((f) => !knownAbsent.includes(f) && !fs.existsSync(path.join(snapDir, f)));
      const sameCommit = meta?.commit === commit;
      let co = staged.get(`${id}@${commit}`);
      if (!co && (!sameCommit || snapshotLacks)) co = checkout(commit) ?? undefined;
      if (!co && !sameCommit) {
        keep();
        continue;
      }
      const absent = co ? attribution.filter((f) => !fs.existsSync(path.join(co!.dir, f))) : knownAbsent;
      const copied = attribution.filter((f) => !absent.includes(f));
      const date = co ? co.date : meta!.date;
      result.sources[id] = { commit, date, moved: !sameCommit };

      // 4. the snapshot: the selected folders and attribution files at their upstream paths, plus .snapshot.json
      for (const r of here) {
        if (r.fromSnapshot || (isSkillDir(r.snapshot) && skillHash(r.snapshot) === r.locked.computedHash)) report.add({ kind: "skip", path: r.snapshot, note: "ok" });
        else report.add({ kind: "copy", path: r.snapshot, target: r.dir, note: `snapshot at ${r.locked.commit!.slice(0, 7)}` });
      }
      const paths = new Set(here.map((r) => r.rel));
      if (opts.frozen) for (const s of sel) if (mine(s)?.skillPath) paths.add(path.posix.dirname(mine(s)!.skillPath!));
      for (const rel of findSkills(snapDir, undefined, 6).values()) if (!paths.has(rel)) report.add({ kind: "delete", path: path.join(snapDir, rel), note: "no longer selected" });
      for (const f of copied) {
        const dst = path.join(snapDir, f);
        const bytes = co ? fs.readFileSync(path.join(co.dir, f)) : null;
        if (bytes && (!fs.existsSync(dst) || !bytes.equals(fs.readFileSync(dst)))) report.add({ kind: "write", path: dst, payload: bytes, note: "attribution" });
        else report.add({ kind: "skip", path: dst, note: "ok" });
      }
      for (const f of meta?.attribution ?? []) if (!copied.includes(f) && fs.existsSync(path.join(snapDir, f))) report.add({ kind: "delete", path: path.join(snapDir, f), note: "no longer listed as attribution" });
      const skills: SnapshotMeta["skills"] = {};
      for (const r of [...here].sort((a, b) => cmp(a.upstream, b.upstream))) skills[r.upstream] = { path: r.rel, hash: r.locked.computedHash!, commit: r.locked.commit! };
      const metaNext: SnapshotMeta = { source: id, repo: src.repo, ref: src.ref, commit, date, skills, attribution: copied, absent };
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
        next[r.name] = r.locked;
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

    // 7. the lock: what this refresh resolved, in the npx skills format plus the commit; never when frozen
    if (!opts.frozen) writeIfChanged(report, lib.lockFile, lockText(next), "what this refresh resolved");

    apply(report, opts.plan);
  } finally {
    for (const s of staged.values()) discard(s);
  }
  return result;
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
