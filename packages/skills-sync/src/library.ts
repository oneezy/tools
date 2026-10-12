// The skills library: a checkout with skills/ (own skills, flat or grouped by plugin) beside the committed config
// skills-sync.json (third-party sources, plugins; its lock is skills-sync.lock.json) or the npx skills lock
// skills-lock.json alone. Only the library commands (update, refresh, versions, add, build, check and the brain and alias
// migrations) run in one, named by --repo or found above the current folder; a machine command never looks for a library
// and never clones one (ADR-0007). ~/.skills-sync, where older versions kept their clone, is only ever detected now.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_NAME, configKind, LOCAL_NAME } from "./config.js";
import { isDir, isSkillDir, real } from "./fs.js";
import { RESERVED } from "./harnesses.js";
import { LOCK_NAME, NPX_LOCK_NAME, readLock, type Lock } from "./lock.js";
import { readConfig } from "./sources.js";

export class Library {
  constructor(public root: string) {}

  get own(): string {
    return path.join(this.root, "skills");
  }
  get agents(): string {
    return path.join(this.root, ".agents", "skills");
  }
  /** A config library's lock: per source, the version, commit and skills refresh resolved; written by refresh. */
  get lockFile(): string {
    return path.join(this.root, LOCK_NAME);
  }
  /** The npx skills lock: what a library without a config has installed; in a config library, the version 1 lock refresh migrates. */
  get npxLockFile(): string {
    return path.join(this.root, NPX_LOCK_NAME);
  }
  /** The committed config: the hand-edited declaration of third-party sources, selections, renames, pins, plugins. */
  get configFile(): string {
    return path.join(this.root, CONFIG_NAME);
  }
  /** The checkout's gitignored local file: the skills an update found gone upstream. */
  get localFile(): string {
    return path.join(this.root, LOCAL_NAME);
  }
  /** Snapshots: upstream/<source>/<upstream path>, generated and never edited. */
  get upstream(): string {
    return path.join(this.root, "upstream");
  }
  /** Built packages: plugins/<id>/, written by build and committed. */
  get plugins(): string {
    return path.join(this.root, "plugins");
  }
  /** Upload archives: artifacts/<id>-<version>.zip and their record, written by build --artifacts, never committed. */
  get artifacts(): string {
    return path.join(this.root, "artifacts");
  }
  /** The Claude Code marketplace catalog, written by build and committed. */
  get claudeCatalog(): string {
    return path.join(this.root, ".claude-plugin", "marketplace.json");
  }
  /** The Codex marketplace catalog, written by build and committed. */
  get codexCatalog(): string {
    return path.join(this.root, ".agents", "plugins", "marketplace.json");
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
      if (first)
        out.ignored.push({
          path: dir,
          note: `same name as ${path.relative(this.root, first).replace(/\\/g, "/")}, which wins; ignored`,
        });
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
        else
          out.ignored.push({
            path: child,
            note: "no SKILL.md: not a skill, and only folders directly under skills/ are groups; ignored",
          });
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

  /** A config library's lock, a version 1 lock read in memory when there is no other; null without one, or when the config is invalid. */
  lock(): Lock | null {
    try {
      return readLock(this.root, readConfig(this.configFile));
    } catch {
      return null;
    }
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

/** ~/.skills-sync: where older versions kept the library clone, or a link to it. Detected by the probe; never read or made. */
export function homeLibrary(home = os.homedir()): string {
  return path.join(home, ".skills-sync");
}

/**
 * Where the library is, for a library command run without --repo: $SKILLS_REPO, else a library folder above the
 * current directory. null when there is none. ~/.skills-sync is not looked at: nothing keeps a clone there any more.
 */
export function findLibrary(from: string, env = process.env): string | null {
  if (env.SKILLS_REPO && looksLikeLibrary(env.SKILLS_REPO)) return path.resolve(env.SKILLS_REPO);
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

/** Verify a clean library checkout at the exact, currently advertised remote revision (migrate-aliases). */
export function verifyLibraryRevision(root: string, expected?: string, ref = "refs/heads/main"): string | null {
  if (!expected || !/^[a-f0-9]{40}$/i.test(expected) || !/^refs\/(heads|tags)\/[\w./-]+$/.test(ref))
    return "revision verification requires a full commit SHA and an exact refs/heads or refs/tags remote ref";
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim().toLowerCase() !== expected.toLowerCase())
    return `library HEAD does not match expected revision ${expected}; links left alone`;
  const dirty = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  });
  const changed = dirty.stdout?.split(/\r?\n/).filter((line) => line && line !== "?? skills-sync.local.json") ?? [];
  if (dirty.status !== 0 || changed.length)
    return "library source differs from the expected commit; links left alone";
  const remote = spawnSync("git", ["-C", root, "ls-remote", "--exit-code", "origin", ref, `${ref}^{}`], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const refs =
    remote.stdout
      ?.trim()
      .split("\n")
      .map((line) => line.split(/\s+/)) ?? [];
  const revision = (refs.find(([, name]) => name === `${ref}^{}`) ?? refs.find(([, name]) => name === ref))?.[0];
  if (remote.status !== 0 || revision?.toLowerCase() !== expected.toLowerCase())
    return `origin ${ref} does not match expected revision ${expected}, or is unavailable; links left alone`;
  return null;
}

/** The files that mark a library, any one beside skills/: the committed config, the npx skills lock, or the lock. */
export const LIBRARY_MARKERS = [CONFIG_NAME, NPX_LOCK_NAME, LOCK_NAME];

/**
 * A library has skills/ beside one of the marker files, and is never a dot-folder: a harness config dir
 * such as ~/.claude also has a skills/ subfolder, and must never be mistaken for one.
 */
export function looksLikeLibrary(dir: string): boolean {
  const abs = path.resolve(dir);
  return isDir(path.join(abs, "skills")) && LIBRARY_MARKERS.some((m) => fs.existsSync(path.join(abs, m)));
}
