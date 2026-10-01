// Refresh: resolve every source per its policy, snapshot the selected skills under upstream/, write the lock, rebuild
// the third-party working set, regenerate skills-lock.json. Frozen: the lock's commits, nothing moves. A skill whose
// snapshot already holds the content of the commit it resolves to is not fetched again, so a refresh with nothing new
// is silent and needs no clone.
import fs from "node:fs";
import path from "node:path";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cloneUrl, cmp, compatLock, findSkills, isCommit, lockText, manifestHash, readManifest, readSourcesLock, selection, skillHash, transformsFor, withName, type LockedSkill, type Selected, type SourcesLock } from "./sources.js";
import { discard, remoteTip, stage, type Staged } from "./stage.js";

export interface RefreshOptions {
  /** use the lock's commits; a source or skill the lock does not know is left alone */
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
  /** per source that resolved: its commit and whether it differs from the lock's */
  sources: Record<string, { commit: string; date: string; moved: boolean }>;
  /** selected skills not found upstream this run, as source:name */
  gone: string[];
  /** manifest skills the lock does not have, in frozen mode, as source:name */
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
  skills: Record<string, { path: string; hash: string; pinnedCommit?: string }>;
  /** attribution files copied, and those the manifest lists that upstream lacks at this commit */
  attribution: string[];
  absent: string[];
}

/** One resolved skill: where its folder is right now (a checkout, or the snapshot when that already matches), its snapshot path and its lock entry. */
interface Resolved extends Selected {
  source: string;
  dir: string;
  snapshot: string;
  fromSnapshot: boolean;
  locked: LockedSkill;
}

export function refresh(lib: Library, opts: RefreshOptions): RefreshResult {
  const manifest = readManifest(lib.configFile);
  const old = readSourcesLock(lib.sourcesLockFile);
  const next: SourcesLock = { version: 1, generated: { manifest: manifestHash(lib.configFile) }, sources: {}, releases: old.releases };
  const result: RefreshResult = { report: new Report(), sources: {}, gone: [], unlocked: [], problems: [] };
  const report = result.report;
  const staged = new Map<string, Staged>(Object.entries(opts.prestaged ?? {}).map(([id, s]) => [`${id}@${s.commit}`, s]));
  const found = new Map<string, Map<string, string>>(); // skills discovered per checkout
  const resolved: Resolved[] = [];
  const selected = new Set<string>();
  try {
    for (const id of Object.keys(manifest.sources).sort(cmp)) {
      const src = manifest.sources[id];
      const sel = selection(src);
      for (const s of sel) selected.add(s.name);
      const wanted = sel.filter((s) => !opts.unavailable.includes(s.name));
      const locked = old.sources[id];
      const url = cloneUrl(src.repo);
      const snapDir = path.join(lib.upstream, id);
      const meta = readMeta(snapDir);
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
        if (locked) next.sources[id] = locked;
      };

      // 1. the source's commit: the lock's when frozen or pinned, else the tip of ref
      let commit: string | null;
      if (opts.frozen) {
        if (!locked) {
          result.unlocked.push(...wanted.map((s) => `${id}:${s.name}`));
          continue;
        }
        commit = locked.commit;
      } else if (src.policy === "pin" && locked) commit = locked.commit;
      else if (isCommit(src.ref)) commit = src.ref;
      else {
        commit = remoteTip(url, src.ref);
        if (!commit) {
          result.problems.push(`${id}: cannot reach ${url} (${src.ref})`);
          keep();
          continue;
        }
      }

      // 2. each selected skill, from the snapshot when it already holds that commit's content, else from a checkout
      const here: Resolved[] = [];
      const skills: Record<string, LockedSkill> = {};
      let failed = false;
      const inLock = (s: Selected) => !!locked?.skills[s.upstream];
      for (const s of opts.frozen ? wanted.filter(inLock) : wanted) {
        const l = locked?.skills[s.upstream];
        // a pinned skill always records its pin, even when it equals the source's commit today
        const pin = opts.frozen ? l!.pinnedCommit : src.pins?.[s.upstream];
        const at: string = pin ?? commit;
        const entry = (p: string, hash: string): LockedSkill => ({ path: p, hash, ...(pin ? { pinnedCommit: pin } : {}), transforms: transformsFor(s) });
        const snap = l && (l.pinnedCommit ?? locked!.commit) === at ? path.join(snapDir, l.path) : null;
        if (snap && isSkillDir(snap) && skillHash(snap) === l!.hash) {
          here.push({ ...s, source: id, dir: snap, snapshot: snap, fromSnapshot: true, locked: entry(l!.path, l!.hash) });
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
        here.push({ ...s, source: id, dir: path.join(co.dir, rel), snapshot: path.join(snapDir, rel), fromSnapshot: false, locked: entry(rel, skillHash(path.join(co.dir, rel))) });
      }
      if (opts.frozen) result.unlocked.push(...wanted.filter((s) => !inLock(s)).map((s) => `${id}:${s.name}`));
      if (failed) {
        keep();
        continue;
      }
      for (const r of here) skills[r.upstream] = r.locked;
      // frozen never rewrites the lock, so its entry stays exactly what it was
      const lockedSkills = opts.frozen ? locked!.skills : skills;

      // 3. attribution files come from a checkout; the snapshot stands when it already has them at this commit
      const attribution = src.attribution ?? [];
      const knownAbsent = (meta?.absent ?? []).filter((f) => attribution.includes(f));
      const snapshotLacks = attribution.some((f) => !knownAbsent.includes(f) && !fs.existsSync(path.join(snapDir, f)));
      let co = staged.get(`${id}@${commit}`);
      if (!co && (locked?.commit !== commit || snapshotLacks)) co = checkout(commit) ?? undefined;
      if (!co && locked?.commit !== commit) {
        keep();
        continue;
      }
      const absent = co ? attribution.filter((f) => !fs.existsSync(path.join(co!.dir, f))) : knownAbsent;
      const copied = attribution.filter((f) => !absent.includes(f));
      const date = co ? co.date : locked!.date;
      next.sources[id] = { commit, date, skills: lockedSkills };
      result.sources[id] = { commit, date, moved: locked?.commit !== commit };

      // 4. the snapshot: the selected folders and attribution files at their upstream paths, plus .snapshot.json
      for (const r of here) {
        if (r.fromSnapshot || (isSkillDir(r.snapshot) && skillHash(r.snapshot) === r.locked.hash)) report.add({ kind: "skip", path: r.snapshot, note: "ok" });
        else report.add({ kind: "copy", path: r.snapshot, target: r.dir, note: `snapshot at ${(r.locked.pinnedCommit ?? commit).slice(0, 7)}` });
      }
      const paths = new Set(Object.values(lockedSkills).map((s) => s.path));
      for (const rel of findSkills(snapDir, undefined, 6).values()) if (!paths.has(rel)) report.add({ kind: "delete", path: path.join(snapDir, rel), note: "no longer in the lock" });
      for (const f of copied) {
        const dst = path.join(snapDir, f);
        const bytes = co ? fs.readFileSync(path.join(co.dir, f)) : null;
        if (bytes && (!fs.existsSync(dst) || !bytes.equals(fs.readFileSync(dst)))) report.add({ kind: "write", path: dst, payload: bytes, note: "attribution" });
        else report.add({ kind: "skip", path: dst, note: "ok" });
      }
      for (const f of meta?.attribution ?? []) if (!copied.includes(f) && fs.existsSync(path.join(snapDir, f))) report.add({ kind: "delete", path: path.join(snapDir, f), note: "no longer listed as attribution" });
      const metaNext: SnapshotMeta = { source: id, repo: src.repo, ref: src.ref, commit, date, skills: metaSkills(lockedSkills), attribution: copied, absent };
      writeIfChanged(report, path.join(snapDir, ".snapshot.json"), JSON.stringify(metaNext, null, 2) + "\n", `${Object.keys(lockedSkills).length} skills at ${commit.slice(0, 7)}`);
      resolved.push(...here);
    }

    // 5. snapshots of sources no longer in the manifest
    if (isDir(lib.upstream)) {
      for (const id of fs.readdirSync(lib.upstream).sort(cmp)) if (!manifest.sources[id] && isDir(path.join(lib.upstream, id))) report.add({ kind: "delete", path: path.join(lib.upstream, id), note: "source no longer in skills-sync.json" });
    }

    // 6. the working set: one copy per resolved skill with its transforms applied; copies no longer selected go.
    // One name from two sources: the first source by id wins, the other is reported until the manifest renames it.
    const own = new Set(lib.scanOwn().skills.map((s) => s.name));
    const taken = new Map<string, string>();
    for (const r of resolved.sort((a, b) => cmp(a.name, b.name) || cmp(a.source, b.source))) {
      const winner = taken.get(r.name);
      if (winner) report.add({ kind: "conflict", path: path.join(lib.agents, r.name), note: `${r.source} also selects ${r.upstream} as ${r.name}; ${winner} wins; rename one in skills-sync.json` });
      else {
        taken.set(r.name, r.source);
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

    // 7. the locks: the sources lock (never when frozen), and the compatibility lock regenerated from it
    if (!opts.frozen) writeIfChanged(report, lib.sourcesLockFile, lockText(next), "what this refresh resolved");
    writeIfChanged(report, lib.lockFile, compatLock(manifest, opts.frozen ? old : next), "npx skills format, regenerated from skills-sources-lock.json");

    apply(report, opts.plan);
  } finally {
    for (const s of staged.values()) discard(s);
  }
  return result;
}

/** The working-set copy of one resolved skill; skipped when its files already equal the snapshot's with the transforms applied. */
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
  const rename = r.locked.transforms?.find((t) => t.kind === "rename");
  const expected = folderFiles(r.dir);
  if (rename) expected.set("SKILL.md", Buffer.from(withName(expected.get("SKILL.md")?.toString("utf8") ?? "", rename.to)));
  if (isDir(dst) && sameFiles(folderFiles(dst), expected)) {
    report.add({ kind: "skip", path: dst, note: "ok" });
    return;
  }
  // copied from the snapshot, which exists by then: its copy action comes earlier in the same report
  report.add({ kind: "copy", path: dst, target: r.snapshot, note: rename ? `renamed from ${r.upstream}` : undefined });
  if (rename) report.add({ kind: "write", path: path.join(dst, "SKILL.md"), payload: expected.get("SKILL.md"), note: `frontmatter name: ${rename.to}` });
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

function metaSkills(skills: Record<string, LockedSkill>): SnapshotMeta["skills"] {
  const out: SnapshotMeta["skills"] = {};
  for (const n of Object.keys(skills).sort(cmp)) {
    const { path: p, hash, pinnedCommit } = skills[n];
    out[n] = pinnedCommit ? { path: p, hash, pinnedCommit } : { path: p, hash };
  }
  return out;
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
