// The skills library: a folder with skills/<name>/ (own skills) and skills-lock.json (third-party pins).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { isDir, isSkillDir, real } from "./fs.js";
import { RESERVED } from "./harnesses.js";

export class Library {
  constructor(public root: string) {}

  get own(): string {
    return path.join(this.root, "skills");
  }
  get agents(): string {
    return path.join(this.root, ".agents", "skills");
  }
  get lockFile(): string {
    return path.join(this.root, "skills-lock.json");
  }

  ownSkills(): string[] {
    if (!isDir(this.own)) return [];
    return fs
      .readdirSync(this.own)
      .filter((n) => !n.startsWith(".") && isSkillDir(path.join(this.own, n)))
      .sort();
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

export interface LockEntry {
  source: string;
  sourceType: string;
  sourceUrl?: string;
  ref?: string;
  skillPath?: string;
  computedHash?: string;
}

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

/** Walk up from `from` for a folder with skills/ and skills-lock.json (or skills/ alone), then env, then the usual homes. */
export function findLibrary(from: string, env = process.env, home = os.homedir()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (looksLikeLibrary(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (env.SKILLS_REPO && looksLikeLibrary(env.SKILLS_REPO)) return path.resolve(env.SKILLS_REPO);
  for (const c of [path.join(home, "dev", "skills"), path.join(home, "skills")]) if (looksLikeLibrary(c)) return c;
  return null;
}

export function looksLikeLibrary(dir: string): boolean {
  return isDir(path.join(dir, "skills")) && (fs.existsSync(path.join(dir, "skills-lock.json")) || fs.readdirSync(path.join(dir, "skills")).some((n) => isSkillDir(path.join(dir, "skills", n))));
}

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
