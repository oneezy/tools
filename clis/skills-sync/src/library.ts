// The skills library: a folder with skills/ (own skills, flat or grouped by plugin) beside the committed config
// skills-sync.json (third-party sources, plugins) or the lock skills-lock.json (what is installed, in the npx skills format).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_NAME, configKind, LOCAL_NAME } from "./config.js";
import { isDir, isSkillDir, real } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import type { LockEntry } from "./sources.js";

export class Library {
  constructor(public root: string) {}

  get own(): string {
    return path.join(this.root, "skills");
  }
  get agents(): string {
    return path.join(this.root, ".agents", "skills");
  }
  /** The lock in the npx skills format: what is installed; written by refresh when a config exists. */
  get lockFile(): string {
    return path.join(this.root, "skills-lock.json");
  }
  /** The committed config: the hand-edited declaration of third-party sources, selections, renames, pins, plugins. */
  get configFile(): string {
    return path.join(this.root, CONFIG_NAME);
  }
  /** This machine's answers, gitignored. */
  get localFile(): string {
    return path.join(this.root, LOCAL_NAME);
  }
  /** Snapshots: upstream/<source>/<upstream path>, generated and never edited. */
  get upstream(): string {
    return path.join(this.root, "upstream");
  }
  /** A config library: refresh owns the third-party working set and the lock. A legacy answers-only skills-sync.json does not count. */
  hasConfig(): boolean {
    return configKind(this.root) === "config";
  }

  /** Own skill names, sorted. */
  ownSkills(): string[] {
    return this.scanOwn().skills.map((s) => s.name);
  }

  /**
   * Own skills under skills/: a folder that holds SKILL.md is a flat skill; a folder without one is a
   * group whose children are skills and whose name is their plugin id. A group's child without SKILL.md
   * is not a skill, and a second skill with a name already taken (paths in sorted order) loses; both are
   * reported once and never linked. Dot-folders are skipped at both levels.
   */
  scanOwn(): OwnScan {
    const out: OwnScan = { skills: [], ignored: [] };
    if (!isDir(this.own)) return out;
    const taken = new Map<string, string>();
    const add = (name: string, dir: string, plugin: string | null) => {
      const first = taken.get(name);
      if (first) out.ignored.push({ path: dir, note: `same name as ${path.relative(this.root, first).replace(/\\/g, "/")}, which wins; ignored` });
      else {
        taken.set(name, dir);
        out.skills.push({ name, dir, plugin });
      }
    };
    for (const n of folders(this.own)) {
      const dir = path.join(this.own, n);
      if (isSkillDir(dir)) {
        add(n, dir, null);
        continue;
      }
      for (const c of folders(dir)) {
        const child = path.join(dir, c);
        if (isSkillDir(child)) add(c, child, n);
        else out.ignored.push({ path: child, note: "no SKILL.md: not a skill, and only folders directly under skills/ are groups; ignored" });
      }
    }
    out.skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** name -> real folder, for every entry of .agents/skills that holds a SKILL.md */
  workingSet(): Map<string, string> {
    const out = new Map<string, string>();
    if (!isDir(this.agents)) return out;
    for (const n of fs.readdirSync(this.agents).sort()) {
      if (n.startsWith(".") || RESERVED.has(n)) continue;
      const p = path.join(this.agents, n);
      if (isSkillDir(p)) out.set(n, real(p));
    }
    return out;
  }

  lockedSkills(): string[] {
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockFile, "utf8")) as { skills?: Record<string, unknown> };
      return Object.keys(lock.skills ?? {}).sort();
    } catch {
      return [];
    }
  }

  /** Lock entries with no folder in .agents/skills yet. */
  missingFromLock(): string[] {
    return this.lockedSkills().filter((n) => !isSkillDir(path.join(this.agents, n)));
  }

  lockEntries(): Record<string, LockEntry> {
    try {
      return (JSON.parse(fs.readFileSync(this.lockFile, "utf8")) as { skills?: Record<string, LockEntry> }).skills ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Restore missing lock entries into .agents/skills: one shallow clone per source, then each skill
   * copied from its recorded path, or found by folder name when upstream moved it. Entries whose
   * source no longer has the skill are reported, never invented. (`npx skills experimental_install`
   * clones once per skill and stops at the first stale path, which is why this exists.)
   */
  restore(log: (s: string) => void, only?: string[]): RestoreResult {
    const result: RestoreResult = { restored: [], moved: [], missing: [], failed: [] };
    const wanted = new Set(only ?? this.missingFromLock());
    const bySource = new Map<string, Array<[string, LockEntry]>>();
    for (const [name, e] of Object.entries(this.lockEntries())) {
      if (!wanted.has(name)) continue;
      const url = cloneUrl(e);
      if (!url) {
        result.failed.push(`${name}: source type ${e.sourceType} is not restorable`);
        continue;
      }
      const key = `${url}#${e.ref ?? ""}`;
      bySource.set(key, [...(bySource.get(key) ?? []), [name, e]]);
    }
    for (const [key, entries] of bySource) {
      const [url, ref] = key.split("#");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-src-"));
      log(`cloning ${url}${ref ? "@" + ref : ""} for ${entries.length} skill(s)`);
      const args = ["clone", "--quiet", "--depth", "1", ...(ref ? ["--branch", ref] : []), url, tmp];
      const r = spawnSync("git", args, { encoding: "utf8" });
      if (r.status !== 0) {
        result.failed.push(`${url}: ${(r.stderr ?? "").trim().split("\n").pop()}`);
        fs.rmSync(tmp, { recursive: true, force: true });
        continue;
      }
      for (const [name, e] of entries) {
        const recorded = e.skillPath ? path.join(tmp, path.dirname(e.skillPath)) : null;
        let src = recorded && isSkillDir(recorded) ? recorded : null;
        if (!src) {
          src = findSkillByName(tmp, name);
          if (src) result.moved.push(`${name}: now at ${path.relative(tmp, src).replace(/\\/g, "/")}`);
        }
        if (!src) {
          result.missing.push(`${name}: not in ${url} any more (was ${e.skillPath ?? "?"})`);
          continue;
        }
        fs.mkdirSync(this.agents, { recursive: true });
        fs.cpSync(src, path.join(this.agents, name), { recursive: true });
        result.restored.push(name);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return result;
  }
}

/** One own skill: its folder name (the skill name), its real folder, and the group it sits in. */
export interface OwnSkill {
  name: string;
  dir: string;
  /** the group's name, which is the plugin id; null for a flat skill */
  plugin: string | null;
}

export interface OwnScan {
  skills: OwnSkill[];
  /** folders that are not skills where a skill could have been; each is reported once */
  ignored: Array<{ path: string; note: string }>;
}

/** Sub-folder names of `dir`, dot-folders excluded, sorted. */
function folders(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

export type { LockEntry } from "./sources.js";

export interface RestoreResult {
  restored: string[];
  moved: string[];
  missing: string[];
  failed: string[];
}

function cloneUrl(e: LockEntry): string | null {
  if (e.sourceType === "github") return `https://github.com/${e.source.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")}.git`;
  if (e.sourceType === "git" || e.sourceType === "gitlab") return e.sourceUrl ?? null;
  return null;
}

function findSkillByName(root: string, name: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === ".git" || ent.name === "node_modules") continue;
      const full = path.join(dir, ent.name);
      if (ent.name === name && isSkillDir(full)) return full;
      stack.push(full);
    }
  }
  return null;
}

export const DEFAULT_LIBRARY = "oneezy/skills";

/** ~/.skills-sync: the library itself, or a link to wherever the library really lives. */
export function homeLibrary(home = os.homedir()): string {
  return path.join(home, ".skills-sync");
}

/**
 * Where the library is, in this order: --repo, $SKILLS_REPO, ~/.skills-sync (a clone or a link),
 * a library folder above the current directory. null when none exists yet.
 */
export function findLibrary(from: string, env = process.env, home = os.homedir()): string | null {
  if (env.SKILLS_REPO && looksLikeLibrary(env.SKILLS_REPO)) return path.resolve(env.SKILLS_REPO);
  const hl = homeLibrary(home);
  if (looksLikeLibrary(hl)) return real(hl);
  let dir = path.resolve(from);
  for (;;) {
    // the walk-up never accepts a dot-folder: ~/.claude has a skills/ subfolder too
    if (!path.basename(dir).startsWith(".") && looksLikeLibrary(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Clone `owner/repo` (or a URL) into ~/.skills-sync. */
export function cloneLibrary(source: string, home = os.homedir(), log: (s: string) => void = () => undefined): { ok: boolean; root: string; error?: string } {
  const root = homeLibrary(home);
  const url = /^(https?:|git@|ssh:)/.test(source) ? source : `https://github.com/${source.replace(/\.git$/, "")}.git`;
  log(`no skills library here yet; cloning ${url} into ${root}`);
  const r = spawnSync("git", ["clone", "--quiet", url, root], { encoding: "utf8" });
  if (r.status !== 0) return { ok: false, root, error: (r.stderr ?? "").trim().split("\n").pop() };
  return { ok: true, root };
}

/**
 * Fast-forward the library from its remote, at most once per `minutes`, only when the tree is clean. `regenerated`
 * names tracked files the tool itself writes on every machine (a config library's lock): a local change to one of
 * them alone never counts as dirty. Each is put at HEAD so the pull can replace it, and put back as it was when
 * the pull fails: the refresh that follows a pull writes it again, and a frozen one reads it.
 */
export function pullLibrary(root: string, minutes: number, log: (s: string) => void, regenerated: string[] = []): "pulled" | "skipped" | "dirty" | "failed" | "throttled" {
  const stamp = path.join(root, ".git", "skills-sync-pulled");
  try {
    const last = fs.statSync(stamp).mtimeMs;
    if (Date.now() - last < minutes * 60_000) return "throttled";
  } catch {
    /* never pulled */
  }
  if (!fs.existsSync(path.join(root, ".git"))) return "skipped";
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (status.status !== 0) return "skipped";
  // porcelain v1: two status letters, a space, the path (relative to the repository root, which the library is)
  const changed = status.stdout.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
  if (changed.some((f) => !regenerated.includes(f))) return "dirty";
  const saved = changed.map((f) => [path.join(root, f), fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f)) : null] as const);
  if (changed.length) spawnSync("git", ["-C", root, "checkout", "--", ...changed], { encoding: "utf8" });
  const r = spawnSync("git", ["-C", root, "pull", "--ff-only", "--quiet"], { encoding: "utf8", timeout: 20_000 });
  try {
    fs.writeFileSync(stamp, new Date().toISOString());
  } catch {
    /* stamp is best-effort */
  }
  if (r.status !== 0) {
    for (const [file, bytes] of saved) {
      if (bytes) fs.writeFileSync(file, bytes);
      else fs.rmSync(file, { force: true });
    }
    log(`library pull skipped: ${(r.stderr ?? "").trim().split("\n").pop()}`);
    return "failed";
  }
  return "pulled";
}

/** The files that mark a library, either one beside skills/: the committed config, or the lock. */
export const LIBRARY_MARKERS = [CONFIG_NAME, "skills-lock.json"];

/**
 * A library has skills/ beside one of the marker files, and is never a dot-folder: a harness config dir
 * such as ~/.claude also has a skills/ subfolder, and must never be mistaken for one.
 */
export function looksLikeLibrary(dir: string): boolean {
  const abs = path.resolve(dir);
  return isDir(path.join(abs, "skills")) && LIBRARY_MARKERS.some((m) => fs.existsSync(path.join(abs, m)));
}

/** An empty lock, for a library that has no third-party skills yet. */
export const EMPTY_LOCK = JSON.stringify({ version: 1, skills: {} }, null, 2) + "\n";

/**
 * Codex reads policy from agents/openai.yaml next to SKILL.md. Derive it from the Claude frontmatter
 * of an own skill so one file is the source of truth. Returns the yaml text, or null when nothing to say.
 */
export function sidecarFor(skillDir: string): string | null {
  const md = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return null;
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  const manual = fm["disable-model-invocation"] === true;
  const desc = typeof fm.description === "string" ? fm.description : "";
  const short = desc.length > 80 ? desc.slice(0, 77).trimEnd() + "..." : desc;
  const doc: Record<string, unknown> = {
    interface: { display_name: String(fm.name ?? path.basename(skillDir)), short_description: short },
  };
  if (manual) doc.policy = { allow_implicit_invocation: false };
  return "# generated by skills-sync from SKILL.md frontmatter; edit SKILL.md, not this file\n" + YAML.stringify(doc);
}
