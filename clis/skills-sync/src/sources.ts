// The sources manifest (skills-sources.json), its lock (skills-sources-lock.json), the skill hash recipe, and the
// compatibility lock (skills-lock.json) regenerated from them. Reading, hashing and shaping only; refresh.ts moves files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSkillDir } from "./fs.js";
import { shippedSchema, validate } from "./schema.js";

export interface Manifest {
  version: 1;
  library?: { name?: string; owner?: string; homepage?: string };
  sources: Record<string, Source>;
  plugins?: Record<string, Plugin>;
}

export interface Source {
  /** owner/repo on GitHub, a git URL, or a local path */
  repo: string;
  /** the branch or tag to follow, or a commit to hold */
  ref: string;
  /** follow: the tip of ref at every refresh; pin: the lock's commit until the lock is edited */
  policy: "follow" | "pin";
  /** where skill folders live in the repo; the repo root when omitted */
  root?: string;
  /** selected folder names, or a map upstream name -> working-set name */
  skills: string[] | Record<string, string>;
  /** per-skill commits that override the policy */
  pins?: Record<string, string>;
  /** upstream paths of the LICENSE and README files to carry */
  attribution?: string[];
}

export interface Plugin {
  displayName: string;
  description?: string;
  group?: string;
  source?: string;
}

export interface SourcesLock {
  version: 1;
  generated: { manifest: string };
  sources: Record<string, LockedSource>;
  releases: Record<string, Release>;
}

export interface LockedSource {
  commit: string;
  date: string;
  /** keyed by upstream folder name */
  skills: Record<string, LockedSkill>;
}

export interface LockedSkill {
  /** the skill folder relative to the repo root, / separators */
  path: string;
  hash: string;
  pinnedCommit?: string;
  transforms?: Transform[];
}

export type Transform = { kind: "rename"; to: string };

export interface Release {
  plugin_id: string;
  release_id: string;
  sha256: string;
  scope: string;
  date: string;
}

/** One selected skill: its folder name upstream and the name it takes in the working set. */
export interface Selected {
  upstream: string;
  name: string;
}

export function selection(s: Source): Selected[] {
  const pairs = Array.isArray(s.skills) ? s.skills.map((n) => [n, n] as const) : Object.entries(s.skills);
  return pairs.map(([upstream, name]) => ({ upstream, name })).sort((a, b) => cmp(a.upstream, b.upstream));
}

export function transformsFor(sel: Selected): Transform[] | undefined {
  return sel.name === sel.upstream ? undefined : [{ kind: "rename", to: sel.name }];
}

/** The manifest, validated against the shipped schema; throws with every problem listed. */
export function readManifest(file: string): Manifest {
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: not JSON (${String(e)})`);
  }
  const errors = validate(shippedSchema("skills-sources"), parsed);
  if (errors.length) throw new Error(`${file} is not a valid manifest:\n  ${errors.join("\n  ")}`);
  return parsed as Manifest;
}

/** The lock, or an empty one when it does not exist yet. */
export function readSourcesLock(file: string): SourcesLock {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SourcesLock>;
    return { version: 1, generated: parsed.generated ?? { manifest: "" }, sources: parsed.sources ?? {}, releases: parsed.releases ?? {} };
  } catch {
    return { version: 1, generated: { manifest: "" }, sources: {}, releases: {} };
  }
}

export function manifestHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Stable JSON: sorted source and skill keys, two spaces, trailing newline. */
export function lockText(lock: SourcesLock): string {
  const sources: Record<string, LockedSource> = {};
  for (const id of Object.keys(lock.sources).sort(cmp)) {
    const s = lock.sources[id];
    const skills: Record<string, LockedSkill> = {};
    for (const n of Object.keys(s.skills).sort(cmp)) skills[n] = s.skills[n];
    sources[id] = { commit: s.commit, date: s.date, skills };
  }
  const releases: Record<string, Release> = {};
  for (const id of Object.keys(lock.releases).sort(cmp)) releases[id] = lock.releases[id];
  return JSON.stringify({ version: 1, generated: lock.generated, sources, releases }, null, 2) + "\n";
}

/**
 * The npx skills recipe (vercel-labs/skills src/local-lock.ts computeSkillFolderHash): every regular file under the
 * folder except inside .git and node_modules, relative path with / separators, sorted by localeCompare, one SHA-256
 * fed the path then the bytes of each file. Equal to `computedHash` in a lock npx skills wrote for the same tree.
 */
export function skillHash(dir: string): string {
  const files: Array<{ rel: string; full: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== "node_modules") walk(full);
      } else if (e.isFile()) files.push({ rel: path.relative(dir, full).split("\\").join("/"), full });
    }
  };
  walk(dir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.rel);
    h.update(fs.readFileSync(f.full));
  }
  return h.digest("hex");
}

/**
 * Skill folders under `root` in a checkout: a folder holding SKILL.md, up to three levels down (the npx skills depth),
 * never below another skill. Returns folder name -> path relative to the checkout; the first by sorted path wins.
 */
export function findSkills(checkout: string, root: string | undefined, depth = 3): Map<string, string> {
  const out = new Map<string, string>();
  const base = root ? path.join(checkout, root) : checkout;
  const walk = (dir: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.filter((x) => x.isDirectory() && x.name !== ".git" && x.name !== "node_modules").sort((a, b) => cmp(a.name, b.name))) {
      const full = path.join(dir, e.name);
      if (isSkillDir(full)) {
        if (!out.has(e.name)) out.set(e.name, path.relative(checkout, full).split("\\").join("/"));
      } else if (left > 1) walk(full, left - 1);
    }
  };
  walk(base, depth);
  return out;
}

export function isCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

/** owner/repo -> its GitHub clone URL; a URL or a path is used as given. */
export function cloneUrl(repo: string): string {
  return githubSlug(repo) && !/[:@]/.test(repo) ? `https://github.com/${githubSlug(repo)}.git` : repo;
}

/** owner/repo for a GitHub source (as given, or from a github.com URL); null for anything else. */
export function githubSlug(repo: string): string | null {
  if (/^[\w.-]+\/[\w.-]+$/.test(repo) && !fs.existsSync(repo)) return repo.replace(/\.git$/, "");
  const m = /^(?:https?:\/\/|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo);
  return m ? m[1] : null;
}

/** An entry of skills-lock.json, the npx skills local lock (version 1). */
export interface CompatEntry {
  source: string;
  sourceUrl?: string;
  ref?: string;
  sourceType?: "github" | "git";
  skillPath?: string;
  computedHash?: string;
}

/**
 * The compatibility lock: one npx skills entry per working-set skill, keyed by its working-set name, so older
 * skills-sync versions and npx skills keep restoring. `ref` is written only when it is a branch or tag: those tools
 * clone with --branch, which a commit cannot satisfy, so a source held at a commit restores from its ref's tip there.
 */
export function compatLock(manifest: Manifest, lock: SourcesLock): string {
  const skills: Record<string, CompatEntry> = {};
  for (const id of Object.keys(lock.sources).sort(cmp)) {
    const src = manifest.sources[id];
    if (!src) continue;
    const slug = githubSlug(src.repo);
    for (const [upstream, s] of Object.entries(lock.sources[id].skills)) {
      const name = s.transforms?.find((t) => t.kind === "rename")?.to ?? upstream;
      // keys in the order npx skills writes them
      const entry: CompatEntry = { source: slug ?? src.repo };
      if (!slug) entry.sourceUrl = cloneUrl(src.repo);
      if (!isCommit(src.ref)) entry.ref = src.ref;
      Object.assign(entry, { sourceType: slug ? "github" : "git", skillPath: `${s.path}/SKILL.md`, computedHash: s.hash });
      skills[name] = entry;
    }
  }
  const sorted: Record<string, CompatEntry> = {};
  for (const n of Object.keys(skills).sort(cmp)) sorted[n] = skills[n];
  return JSON.stringify({ version: 1, skills: sorted }, null, 2) + "\n";
}

/** SKILL.md with its frontmatter `name` set to `name`; every other byte as upstream wrote it. */
export function withName(md: string, name: string): string {
  const fm = /^---(\r?\n)([\s\S]*?)(\r?\n)---/.exec(md);
  if (!fm) return `---\nname: ${name}\n---\n${md}`;
  const [whole, open, body, close] = fm;
  const next = /^name:/m.test(body) ? body.replace(/^name:[^\r\n]*$/m, `name: ${name}`) : `name: ${name}${open}${body}`;
  return `---${open}${next}${close}---` + md.slice(whole.length);
}

/** Plain code-point order, the same on every machine (localeCompare is only for the hash, where the recipe demands it). */
export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
