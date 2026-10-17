// What a Development project's modules share, kept apart so none of them imports another to reach it: the project
// record and the Library's projects.json (their paths, shapes and readers), the Harness adapter interface, the test
// switch for unverified adapters, and the one question both adapters ask git. develop-project.ts (core),
// develop-claude-code.ts, develop-codex.ts and develop-watcher.ts all import from here; this file imports none of them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { developmentDirs, type DevelopmentBuild } from "./develop-build.js";
import { lexists } from "./fs.js";
import type { Library } from "./library.js";
import type { Report } from "./plan.js";

/** The project record, / separators, relative to the project. */
export const RECORD_PATH = ".agents/skills-sync-project.json";
/** The Source alias: a link to the Library root, relative to the project. */
export const ALIAS_PATH = ".agents/skills-library";

export interface ProjectRecord {
  version: 1;
  /** the Library root this project is connected to (its real path) */
  library: string;
  /** the selected Plugins, by their exact Library ids, sorted */
  plugins: string[];
  /** the Source alias, relative to the project */
  alias: string;
  /** folders setup made, relative to the project: removed by remove when they are empty again */
  created: string[];
  /**
   * the git exclude file holding this setup's block, whether setup made the file, and the entries the block lists (its
   * own two and the verified adapters' excludes; absent in a record written before adapters could add any); null
   * outside git
   */
  exclude: { file: string; created: boolean; entries?: string[] } | null;
  /** what each Harness adapter owns in this project, by Harness id; empty while no adapter is verified */
  harnesses: Record<string, unknown>;
}

/** What a Harness adapter is handed: the project, its Library, the selected Plugins, and what it owned before. */
export interface AdapterContext {
  project: string;
  library: Library;
  plugins: string[];
  /** what this adapter's last setup returned as owned (record.harnesses[harness]); null the first time */
  owned: unknown;
  plan: boolean;
  /**
   * setup: the Development build of the selection, made before any adapter is asked (on plan: previewed, nothing
   * written). No selected Plugin in it is failed: setup refuses that before it calls an adapter. A stale one keeps its
   * last successful output. null in remove and status.
   */
  build: DevelopmentBuild | null;
}

/**
 * What an adapter's setup or remove gives back. `report` holds the file actions core applies with its own, all or none
 * (install and uninstall actions in it are only shown: apply() never runs them). `commands` is the adapter's Harness
 * CLI work (claude plugin ..., codex plugin ...): core calls it at most once, never on plan, and merges the Report it
 * returns; an action in it marked failed stops the run. In setup it runs after every planned action is applied and
 * before the record is written. On a failure the adapter undoes what its own commands did in that call, and core takes
 * back the earlier adapters' activations through their remove, so the record names only what could not be taken back
 * (none: no record, and the next setup tries again). In remove it runs before any planned action, so a failure keeps the
 * whole setup, record included, for a retry. With no record (ctx.owned null), an adapter counts what an interrupted
 * setup of its own left as its own. Reading Harness state while planning (a plugin listing) is allowed; writing it is
 * not.
 */
export interface AdapterResult {
  report: Report;
  commands?: () => Report;
}

/**
 * The one place a Harness plugs in. setup plans the project's activation for the selection as actions (applied with
 * setup's own, all or none) and returns what it now owns, kept in the record; remove plans taking exactly that back,
 * checking each entry first. Neither runs a command on plan. An adapter stays unverified, and is never run, until the
 * Harness's runtime proof exists.
 */
export interface HarnessAdapter {
  harness: string;
  verified: boolean;
  /**
   * project files this adapter's setup or commands may create, as exclude patterns anchored at the project root
   * (`/.claude/settings.local.json`): setup lists them in the exclude block, so git never sees them
   */
  excludes?: string[];
  /** `owned` is kept as record.harnesses[harness]; null or undefined keeps nothing for this Harness */
  setup(ctx: AdapterContext): AdapterResult & { owned: unknown };
  remove(ctx: AdapterContext): AdapterResult | Report;
  status?(ctx: AdapterContext): { state: string; note: string };
}

/** The environment variable that switches unverified adapters on for a test. */
export const TEST_SWITCH = "SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS";

/**
 * Is this Harness's unverified adapter switched on for a test? SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS lists Harness ids
 * (claude-code,codex) whose adapters the CLI then runs as if verified. It exists for the tests, which run the built CLI
 * against fake Harness CLIs; nothing else sets it, and a real Harness must not be driven by an unproven adapter.
 */
export function testSwitch(harness: string): boolean {
  return (process.env[TEST_SWITCH] ?? "").split(",").includes(harness);
}

const at = (project: string, relative: string) => path.join(project, ...relative.split("/"));

/** The project's record: null without one; an error when it is there but is not a record this tool wrote. */
export function readRecord(project: string): { record: ProjectRecord | null; error: string | null } {
  const file = at(project, RECORD_PATH);
  if (!lexists(file)) return { record: null, error: null };
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectRecord;
    if (
      r.version !== 1 ||
      typeof r.library !== "string" ||
      !path.isAbsolute(r.library) ||
      !Array.isArray(r.plugins) ||
      !r.plugins.every((p) => typeof p === "string") ||
      r.alias !== ALIAS_PATH ||
      // setup only ever makes .agents; anything else here would point remove outside what setup made
      !Array.isArray(r.created) ||
      !r.created.every((d) => d === ".agents") ||
      (r.exclude !== null &&
        (typeof r.exclude?.file !== "string" ||
          typeof r.exclude.created !== "boolean" ||
          (r.exclude.entries !== undefined &&
            (!Array.isArray(r.exclude.entries) || !r.exclude.entries.every((e) => typeof e === "string"))))) ||
      typeof r.harnesses !== "object" ||
      r.harnesses === null
    )
      throw new Error("not a version 1 project record");
    return { record: r, error: null };
  } catch (error) {
    return { record: null, error: `${RECORD_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The Library's list of connected projects, beside its Development builds. */
export const PROJECTS_FILE = "projects.json";

/** projects.json: every project setup connected to this Library and its selection, by the project's real path. */
export interface ProjectsIndex {
  version: 1;
  projects: Record<string, { plugins: string[] }>;
}

export const projectsFile = (lib: Library) => path.join(developmentDirs(lib).output, PROJECTS_FILE);

/** The Library's projects.json as it is: null when there is none or it does not parse. */
export function readProjectsIndex(lib: Library): ProjectsIndex | null {
  try {
    const i = JSON.parse(fs.readFileSync(projectsFile(lib), "utf8")) as ProjectsIndex;
    if (i.version === 1 && i.projects && typeof i.projects === "object") return i;
  } catch {
    // none, or not JSON
  }
  return null;
}

/** The Library's projects.json; empty when there is none or it does not parse (setup writes it again). */
export function readProjects(lib: Library): ProjectsIndex {
  return readProjectsIndex(lib) ?? { version: 1, projects: {} };
}

/**
 * Does git track this file of the project: true or false as git says. A project in no repository (no .git at or above
 * it) and a file that does not exist are untracked: nothing of them can be committed. null when git cannot say (no git,
 * an error) about a file that exists in a repository, so a caller refuses instead of guessing.
 */
export function gitTracks(project: string, relative: string, env: NodeJS.ProcessEnv = {}): boolean | null {
  if (!lexists(at(project, relative)) || !repositoryRoot(project)) return false;
  const r = spawnSync("git", ["-C", project, "ls-files", "--error-unmatch", "--", relative], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (r.status === 0) return true;
  return r.status === 1 && !r.error && /did not match/.test(r.stderr) ? false : null;
}

/** The nearest folder at or above `project` holding .git; null outside a repository. */
export function repositoryRoot(project: string): string | null {
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    if (lexists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}
