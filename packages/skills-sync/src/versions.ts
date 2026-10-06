// Which upstream version a source's commit is, in this order: the nearest release tag at or before it (a leading `v` or
// `name@` stripped; pre-release tags only when no stable one is reachable); else the `version` of the nearest plugin or
// package manifest at or above the source's root at that commit; else none. And how many commits past that version's
// own commit (the tag's, or the one that set the manifest to it) the commit is. And the versions a source has released,
// each at the commit update takes for it. Git over a staged checkout that has the history and tags (stage.ts fetches
// them); nothing here writes.
import path from "node:path";
import { discard, git, stage } from "./stage.js";

export interface SourceVersion {
  /** plain semver, or null when there is neither a release tag nor a manifest version */
  version: string | null;
  /** commits past the version's own commit; null when version is */
  ahead: number | null;
}

/** A release tag of a checkout: its name, the version it names, and the commit it points at (peeled). */
export interface Tag {
  name: string;
  version: string;
  commit: string;
}

/** The manifests that carry a version, in the order they are looked for in each folder. */
export const MANIFESTS = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", ".codex-plugin/plugin.json", "package.json"];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A tag name or manifest version as plain semver: `v1.3.1`, `name@1.3.1` and `1.3.1` all give 1.3.1; null when not semver. */
export function plainVersion(name: string): string | null {
  const m = /^(?:v|.*@v?)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(name.trim());
  return m ? m[1] : null;
}

export function isPrerelease(version: string): boolean {
  return !!SEMVER.exec(version)?.[4];
}

/** Semver precedence: negative when a is lower, 0 when equal, positive when higher (build metadata ignored). */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [n, m] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (n && m && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]);
    if (n !== m) return n ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

/** The release tags of a checkout (those naming a semver), each with its peeled commit; only those reachable from `at` when given. */
export function listTags(dir: string, at?: string): Tag[] {
  const r = git(["for-each-ref", ...(at ? [`--merged=${at}`] : []), "--format=%(refname:short) %(objectname) %(*objectname)", "refs/tags"], dir);
  if (!r.ok || !r.out) return [];
  const out: Tag[] = [];
  for (const line of r.out.split("\n")) {
    const [name, object, peeled] = line.trim().split(/\s+/);
    const version = name ? plainVersion(name) : null;
    if (version) out.push({ name, version, commit: peeled || object });
  }
  return out;
}

/** Commits reachable from `to` and not from `from` (git rev-list --count from..to); null when git cannot say. */
export function countCommits(dir: string, from: string, to: string): number | null {
  const r = git(["rev-list", "--count", `${from}..${to}`], dir);
  return r.ok ? Number(r.out) : null;
}

/** The nearest release tag at or before `commit`: stable ones first, the fewest commits away, the highest version on a tie. */
export function tagAt(dir: string, commit: string): (Tag & { ahead: number }) | null {
  const reachable = listTags(dir, commit);
  const stable = reachable.filter((t) => !isPrerelease(t.version));
  let best: (Tag & { ahead: number }) | null = null;
  for (const t of stable.length ? stable : reachable) {
    const ahead = countCommits(dir, t.commit, commit);
    if (ahead === null) continue;
    if (!best || ahead < best.ahead || (ahead === best.ahead && compareVersions(t.version, best.version) > 0)) best = { ...t, ahead };
  }
  return best;
}

/** The folders a source's manifest (and its changelog) is looked for in: its root, then each parent up to the repo root ("" is the root). */
export function manifestDirs(root: string | undefined): string[] {
  const dirs: string[] = [];
  for (let d = root ? path.posix.normalize(root.split("\\").join("/")).replace(/\/+$/, "") : "."; ; d = path.posix.dirname(d)) {
    dirs.push(d === "." ? "" : d);
    if (d === "." || d === "/") break;
  }
  return dirs;
}

/** The plain version a manifest file holds at a commit; null when it is absent, not JSON or has no semver `version`. */
function versionIn(dir: string, commit: string, file: string): string | null {
  const r = git(["show", `${commit}:${file}`], dir);
  if (!r.ok) return null;
  try {
    const v = (JSON.parse(r.out) as { version?: unknown }).version;
    return typeof v === "string" ? plainVersion(v) : null;
  } catch {
    return null;
  }
}

/** The nearest manifest at or above `root` that carries a version at `commit`, with that version. */
export function manifestVersionAt(dir: string, commit: string, root: string | undefined): { file: string; version: string } | null {
  for (const d of manifestDirs(root)) {
    for (const m of MANIFESTS) {
      const file = d ? `${d}/${m}` : m;
      const version = versionIn(dir, commit, file);
      if (version) return { file, version };
    }
  }
  return null;
}

/** The commit that set `file` to the version it has at `commit`: the oldest of the unbroken run of changes to it carrying that version. */
export function manifestVersionCommit(dir: string, commit: string, file: string): string | null {
  const version = versionIn(dir, commit, file);
  if (!version) return null;
  const r = git(["log", "--format=%H", commit, "--", file], dir);
  if (!r.ok) return null;
  let since: string | null = null;
  for (const c of r.out.split("\n").filter(Boolean)) {
    if (versionIn(dir, c, file) !== version) break;
    since = c;
  }
  return since;
}

/** The version of a source at `commit` in a checkout with history, and how many commits past it the commit is. */
export function resolveVersion(dir: string, commit: string, root: string | undefined): SourceVersion {
  const tag = tagAt(dir, commit);
  if (tag) return { version: tag.version, ahead: tag.ahead };
  const manifest = manifestVersionAt(dir, commit, root);
  if (manifest) {
    const since = manifestVersionCommit(dir, commit, manifest.file);
    return { version: manifest.version, ahead: since ? countCommits(dir, since, commit) : null };
  }
  return { version: null, ahead: null };
}

/** A version a source has released, and the commit update takes for it. */
export interface Release {
  version: string;
  commit: string;
}

/**
 * The versions released on the history of `tip`, highest first, each at the commit it resolves to. By release tags when
 * any is reachable (stable ones only while there are any; of two tags naming one version, a `v1.2.0` or `1.2.0` one wins
 * over a `name@1.2.0` one); else by the manifest that versions the source at the tip, each distinct version at the
 * newest commit that carried it (the first parent of the commit that changed it, or the tip); else none.
 */
export function listVersions(dir: string, tip: string, root: string | undefined): Release[] {
  const tags = listTags(dir, tip);
  if (tags.length) {
    const stable = tags.filter((t) => !isPrerelease(t.version));
    const byVersion = new Map<string, Tag>();
    const plain = (t: Tag) => t.name === t.version || t.name === `v${t.version}`;
    for (const t of stable.length ? stable : tags) {
      const have = byVersion.get(t.version);
      if (!have || (plain(t) && !plain(have))) byVersion.set(t.version, t);
    }
    return [...byVersion.values()].map((t) => ({ version: t.version, commit: t.commit })).sort((a, b) => compareVersions(b.version, a.version));
  }
  const manifest = manifestVersionAt(dir, tip, root);
  if (!manifest) return [];
  const r = git(["log", "--format=%H", tip, "--", manifest.file], dir);
  if (!r.ok) return [];
  const out = new Map<string, string>();
  let newer: string | null = null; // the last commit seen (newer than this one) that touched the manifest
  let last: string | null | undefined; // the version that commit carried
  for (const c of r.out.split("\n").filter(Boolean)) {
    const v = versionIn(dir, c, manifest.file);
    if (v !== last && v && !out.has(v)) {
      // the newest commit carrying v: the tip, or the first parent of the commit that changed v to the newer version
      const parent = newer ? git(["rev-parse", `${newer}^`], dir) : null;
      out.set(v, !newer ? tip : parent?.ok && versionIn(dir, parent.out, manifest.file) === v ? parent.out : c);
    }
    last = v;
    newer = c;
  }
  return [...out].map(([version, commit]) => ({ version, commit })).sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * What `versions` lists: the releases on the history of `ref` (a clone staged and discarded here), highest first, each
 * with its commit's date, and where `locked` (the lock's commit) stands among them when the clone has it.
 */
export function releasesOf(url: string, ref: string, root: string | undefined, locked: string | null, log: (s: string) => void): { ok: true; releases: Array<Release & { date: string }>; current: (SourceVersion & { commit: string }) | null } | { ok: false; error: string } {
  const r = stage(url, ref, log);
  if (!r.ok) return r;
  try {
    const dir = r.staged.dir;
    const releases = listVersions(dir, r.staged.commit, root).map((x) => ({ ...x, date: git(["log", "-1", "--format=%cI", x.commit], dir).out }));
    const current = locked && git(["cat-file", "-e", `${locked}^{commit}`], dir).ok ? { ...resolveVersion(dir, locked, root), commit: locked } : null;
    return { ok: true, releases, current };
  } finally {
    discard(r.staged);
  }
}

/** How a source's version reads in output: `1.3.1`, `1.3.1 (+4 commits)`, or `<date> <short commit>` without a version. */
export function versionLabel(v: { version: string | null; ahead: number | null; commit: string; date: string }): string {
  if (v.version === null) return `${v.date.slice(0, 10)} ${v.commit.slice(0, 7)}`;
  return v.ahead ? `${v.version} (+${v.ahead} commit${v.ahead === 1 ? "" : "s"})` : v.version;
}
