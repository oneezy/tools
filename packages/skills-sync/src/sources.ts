// The committed config (skills-sync.json), the npx skills lock entry (lock.ts has the lock itself) and the skill hash
// recipe. Reading, hashing and shaping only; refresh.ts moves files.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSkillDir } from "./fs.js";
import { shippedSchema, validate } from "./schema.js";

export interface Config {
  version: 1;
  library?: { name?: string; owner?: string; homepage?: string };
  /** the two forms, each behind a switch: the loose-skill layers and the plugin packages; both true when absent */
  generate: { skills: boolean; plugins: boolean };
  sources: Record<string, Source>;
  plugins: Record<string, Plugin>;
  /** the ChatGPT upload record per plugin id, written by hand after each upload; read by build --artifacts */
  releases?: Record<string, Release>;
}

/** What the last ChatGPT upload of a plugin returned, and the archive it was: the next build says whether it changed. */
export interface Release {
  plugin_id: string;
  release_id: string;
  sha256: string;
  scope: "personal" | "workspace";
  date: string;
  /** the archive's entries at that upload, so a later build can list what a new archive lacks */
  files?: string[];
}

export interface Source {
  /** owner/repo on GitHub, a git URL, or a local path */
  repo: string;
  /** the branch or tag followed: its tip at every refresh, except skills held by a pin; a full commit holds the whole source */
  ref: string;
  /** where skill folders live in the repo; the repo root when omitted */
  root?: string;
  /** selected folder names, or a map upstream name -> working-set name */
  skills: string[] | Record<string, string>;
  /** per-skill commits (by upstream folder name) that hold a skill while its siblings follow ref */
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

/**
 * An entry of skills-lock.json: the npx skills local lock (version 1), keyed by the working-set name. skills-sync 0.4.0
 * wrote it for a config library with `commit`, the resolved commit the skill was taken at; lock.ts migrates that one.
 */
export interface LockEntry {
  source: string;
  sourceUrl?: string;
  ref?: string;
  sourceType: string;
  skillPath?: string;
  computedHash?: string;
  commit?: string;
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

/** The config, validated against the shipped schema, with the switches, sources and plugins filled in when absent; throws with every problem listed. */
export function readConfig(file: string): Config {
  const parsed = readConfigRaw(file) as Partial<Config>;
  return { ...parsed, version: 1, generate: { skills: true, plugins: true, ...parsed.generate }, sources: parsed.sources ?? {}, plugins: parsed.plugins ?? {} };
}

/** The config exactly as the file holds it, validated; what add writes back with one more source. */
export function readConfigRaw(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file}: not JSON (${String(e)})`);
  }
  const errors = validate(shippedSchema("skills-sync"), parsed);
  if (errors.length) throw new Error(`${file} is not a valid config:\n  ${errors.join("\n  ")}`);
  return parsed as Record<string, unknown>;
}

export function configText(c: Record<string, unknown>): string {
  return JSON.stringify(c, null, 2) + "\n";
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

/** What a version 1 lock entry holds as `source` for a config source: owner/repo for GitHub, else the repo as given. */
export function lockSource(src: Source): string {
  return githubSlug(src.repo) ?? src.repo;
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
