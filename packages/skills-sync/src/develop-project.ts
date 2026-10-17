// develop setup, status and remove: a Development project, connected to the one editable Library. Setup links the
// project's Source alias (.agents/skills-library) to the Library root, keeps both out of git through a marked block in
// the repository's info/exclude, and writes the project record (.agents/skills-sync-project.json): the Library, the
// selected Plugins, and what setup made, so that remove takes away exactly that and nothing a person changed since.
// Nothing here activates a Plugin in a Harness: that is a Harness adapter's job, and none is verified yet.
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, isDir, isLink, lexists, linkTarget, real, samePath, toHash, under } from "./fs.js";
import { developmentDirs, readDevelopmentStatus } from "./develop-build.js";
import { Library } from "./library.js";
import { apply, Report, type Action } from "./plan.js";
import { cmp, readConfig } from "./sources.js";

/** The project record, / separators, relative to the project. */
export const RECORD_PATH = ".agents/skills-sync-project.json";
/** The Source alias: a link to the Library root, relative to the project. */
export const ALIAS_PATH = ".agents/skills-library";

const START = "# skills-sync:development-project:start";
const END = "# skills-sync:development-project:end";

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
  /** the git exclude file holding this setup's block, and whether setup made the file; null outside git */
  exclude: { file: string; created: boolean } | null;
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
  setup(ctx: AdapterContext): { report: Report; owned: unknown };
  remove(ctx: AdapterContext): Report;
  status?(ctx: AdapterContext): { state: string; note: string };
}

/** The adapters this version has: none is verified yet (Claude Code is #213, Codex #214). */
export const ADAPTERS: HarnessAdapter[] = [];

export interface ProjectOptions {
  plan: boolean;
  adapters?: HarnessAdapter[];
}

const at = (project: string, relative: string) => path.join(project, ...relative.split("/"));

/**
 * The project a command in `cwd` acts on: the nearest folder at or above it with a project record, else the nearest
 * one with .git, else `cwd` itself.
 */
export function findProject(cwd: string): string {
  const up = (test: (dir: string) => boolean): string | null => {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      if (test(dir)) return dir;
      if (path.dirname(dir) === dir) return null;
    }
  };
  return up((d) => lexists(at(d, RECORD_PATH))) ?? up((d) => lexists(path.join(d, ".git"))) ?? path.resolve(cwd);
}

/** The project's record: null without one; an error when it is there but is not a record this tool wrote. */
export function readRecord(project: string): { record: ProjectRecord | null; error: string | null } {
  const file = at(project, RECORD_PATH);
  if (!lexists(file)) return { record: null, error: null };
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as ProjectRecord;
    if (
      r.version !== 1 ||
      typeof r.library !== "string" ||
      !Array.isArray(r.plugins) ||
      r.alias !== ALIAS_PATH ||
      !Array.isArray(r.created) ||
      typeof r.harnesses !== "object" ||
      r.harnesses === null
    )
      throw new Error("not a version 1 project record");
    return { record: r, error: null };
  } catch (error) {
    return { record: null, error: `${RECORD_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The info/exclude file git reads for this project (a linked worktree's is its repository's); null outside git. */
export function gitExcludeFile(project: string): string | null {
  const dotgit = path.join(project, ".git");
  if (isDir(dotgit)) return path.join(dotgit, "info", "exclude");
  if (!lexists(dotgit)) return null;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, "utf8"));
  if (!m) return null;
  const gitdir = path.resolve(project, m[1]);
  const common = path.join(gitdir, "commondir");
  const root = lexists(common) ? path.resolve(gitdir, fs.readFileSync(common, "utf8").trim()) : gitdir;
  return path.join(root, "info", "exclude");
}

/** The paths setup keeps out of git, as exclude patterns anchored at the project root. */
const EXCLUDED = [`/${ALIAS_PATH}`, `/${RECORD_PATH}`];

/** The exclude file's text with this setup's block in it (once, at the end), or without it. */
export function excludeText(before: string, present: boolean): string {
  const start = before.indexOf(START);
  const end = before.indexOf(END);
  if (start < 0 !== end < 0 || (start >= 0 && end < start)) throw new Error("incomplete development exclude markers");
  const rest = start < 0 ? before : before.slice(0, start) + before.slice(end + END.length).replace(/^\r?\n/, "");
  if (!present) return rest;
  const head = rest && !rest.endsWith("\n") ? `${rest}\n` : rest;
  return `${head}${START}\n${EXCLUDED.join("\n")}\n${END}\n`;
}

/** The block as this setup writes it; anything else between the markers is a person's edit. */
function blockOf(text: string): string | null {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  return start < 0 || end < start ? null : text.slice(start, end + END.length);
}

/**
 * Connect the project to the Library with the selected Plugins: plan every change, and apply none when anything is in
 * the way. Repeated with the same Library and Plugins, it changes nothing.
 */
export function setupProject(project: string, lib: Library, plugins: string[], options: ProjectOptions): Report {
  const report = new Report();
  const conflict = (file: string, note: string) => report.add({ kind: "conflict", path: file, note });
  project = path.resolve(project);
  const { record: previous, error } = readRecord(project);
  if (error) conflict(at(project, RECORD_PATH), `${error}; left untouched`);
  if (!isDir(project)) conflict(project, "The project must be an existing folder");
  if (!lib.hasConfig()) conflict(lib.root, `No ${path.basename(lib.configFile)}: not a config Library`);
  if (report.conflicts().length) return report;
  let configured: Record<string, { displayName?: string }>;
  try {
    configured = readConfig(lib.configFile).plugins;
  } catch (e) {
    conflict(lib.configFile, e instanceof Error ? e.message : String(e));
    return report;
  }
  const ids = Object.keys(configured).sort(cmp);
  const requested = plugins.length ? plugins : (previous?.plugins ?? []);
  if (!requested.length)
    conflict(project, `Name the Plugins this project uses: ${ids.join(", ") || "none in this Library"}`);
  for (const why of selectionProblems(requested, configured)) conflict(project, why);
  if (report.conflicts().length) return report;
  const library = real(lib.root);
  if (under(real(project), library)) {
    conflict(project, "The project is inside the Library; its alias would contain itself");
    return report;
  }
  if (previous && !samePath(previous.library, library)) {
    conflict(project, `This project is connected to ${previous.library}; run develop remove first`);
    return report;
  }
  const aliasPath = at(project, ALIAS_PATH);
  const recordPath = at(project, RECORD_PATH);
  for (const file of [aliasPath, recordPath])
    if (hasLinkedParent(path.dirname(file))) conflict(file, "A parent folder is a link; left untouched");
  if (report.conflicts().length) return report;

  const created = previous?.created ?? (isDir(path.join(project, ".agents")) ? [] : [".agents"]);
  if (!lexists(aliasPath)) report.add({ kind: "link", path: aliasPath, target: library });
  else if (isLink(aliasPath) && samePath(real(aliasPath), library)) report.add({ kind: "skip", path: aliasPath });
  else conflict(aliasPath, "Something else is at the Source alias; left untouched");

  const excludeFile = gitExcludeFile(project);
  let exclude: ProjectRecord["exclude"] = null;
  if (excludeFile) {
    const exists = lexists(excludeFile);
    exclude = { file: excludeFile, created: previous?.exclude?.created ?? !exists };
    const before = exists ? fs.readFileSync(excludeFile) : null;
    try {
      write(report, excludeFile, excludeText(before?.toString("utf8") ?? "", true), before);
    } catch (e) {
      conflict(excludeFile, `${String(e)}; left untouched`);
    }
  }

  const next: ProjectRecord = {
    version: 1,
    library,
    plugins: [...new Set(requested)].sort(cmp),
    alias: ALIAS_PATH,
    created,
    exclude,
    harnesses: { ...previous?.harnesses },
  };
  for (const adapter of options.adapters ?? ADAPTERS) {
    if (!adapter.verified) {
      report.add({
        kind: "note",
        path: project,
        note: `${adapter.harness}: not activated: its adapter is not verified`,
      });
      continue;
    }
    const ctx = { project, library: lib, plugins: next.plugins, owned: previous?.harnesses[adapter.harness] ?? null };
    const planned = adapter.setup({ ...ctx, plan: options.plan });
    report.merge(planned.report);
    next.harnesses[adapter.harness] = planned.owned;
  }
  if (hasLinkedParent(path.dirname(projectsFile(lib))))
    conflict(projectsFile(lib), "A parent folder is a link; left untouched");
  else planProjects(report, lib, project, next.plugins);
  if (report.conflicts().length) return report;
  apply(report, options.plan);
  if (report.actions.some((a) => a.failed)) return report;
  const last = new Report();
  const before = lexists(recordPath) ? fs.readFileSync(recordPath) : null;
  write(last, recordPath, JSON.stringify(next, null, 2) + "\n", before);
  apply(last, options.plan);
  report.merge(last);
  const active = Object.keys(next.harnesses);
  report.add({
    kind: "note",
    path: project,
    note: `Development project of ${library} with ${next.plugins.join(", ")}; edit the Library through ${ALIAS_PATH}. ${active.length ? `Activated in ${active.join(", ")}` : "No Harness is activated yet (no verified adapter)"}; develop status shows each Plugin's build`,
  });
  return report;
}

/**
 * Why a selection cannot be used: each name must be exactly one Library Plugin's id. A Harness id (play@origin) names
 * where a copy came from, not the Plugin; a name that matches an id only under case folding, or matches a display
 * name, is ambiguous: a Harness tells Plugins apart by their exact name, and Windows folders ignore case.
 */
export function selectionProblems(requested: string[], plugins: Record<string, { displayName?: string }>): string[] {
  const ids = Object.keys(plugins).sort(cmp);
  const fold = (s: string | undefined) => s?.toLowerCase();
  const problems: string[] = [];
  for (const name of new Set(requested)) {
    const near = ids.filter((id) => fold(id) === fold(name) || fold(plugins[id].displayName) === fold(name));
    if (name.includes("@"))
      problems.push(`${name} names a Harness origin; give the Plugin's id: ${name.slice(0, name.indexOf("@"))}`);
    else if (ids.includes(name)) continue;
    else if (near.length)
      problems.push(`${name} is ambiguous: identities are exact, and the Library has ${near.join(", ")}`);
    else problems.push(`${name} is not a Plugin of this Library (${ids.join(", ") || "none"})`);
  }
  return problems;
}

/**
 * Take away what setup made, after checking each piece is still as setup left it: the Source alias, the exclude block
 * and the record, then each folder setup made once it is empty. A piece a person changed since is kept and named, so
 * no later edit is lost; the source is never touched. Without a record, nothing to do.
 */
export function removeProject(project: string, options: ProjectOptions): Report {
  const report = new Report();
  project = path.resolve(project);
  const recordPath = at(project, RECORD_PATH);
  const { record, error } = readRecord(project);
  if (error) {
    report.add({ kind: "conflict", path: recordPath, note: `${error}; nothing removed` });
    return report;
  }
  if (!record) {
    report.add({ kind: "note", path: project, note: "Not a Development project; nothing to remove" });
    return report;
  }
  const kept = (file: string, why: string) => report.add({ kind: "note", path: file, note: why, loud: true });
  const lib = new Library(record.library);
  for (const [harness, owned] of Object.entries(record.harnesses)) {
    const adapter = (options.adapters ?? ADAPTERS).find((x) => x.harness === harness && x.verified);
    if (!adapter) {
      report.add({
        kind: "conflict",
        path: recordPath,
        note: `${harness} owns state here, and no verified adapter for it is in this version; nothing removed`,
      });
      continue;
    }
    report.merge(adapter.remove({ project, library: lib, plugins: record.plugins, owned, plan: options.plan }));
  }
  if (report.conflicts().length) return report;
  if (hasLinkedParent(path.dirname(recordPath))) {
    report.add({ kind: "conflict", path: recordPath, note: "A parent folder is a link; nothing removed" });
    return report;
  }
  const aliasPath = at(project, record.alias);
  if (isLink(aliasPath) && samePath(linkTarget(aliasPath) ?? "", record.library))
    report.add({ kind: "remove", path: aliasPath });
  else if (lexists(aliasPath)) kept(aliasPath, "changed since setup; kept");

  const file = record.exclude?.file;
  if (file && lexists(file)) {
    const before = fs.readFileSync(file);
    const block = blockOf(before.toString("utf8"));
    const ours = blockOf(excludeText("", true));
    const others = connectedWorktrees(project, file);
    if (block === null) {
      // gone already
    } else if (block !== ours) kept(file, "its development block changed since setup; kept");
    else if (others.length)
      kept(file, `its development block stays for ${others.join(", ")}, another worktree of this repository`);
    else {
      const next = excludeText(before.toString("utf8"), false);
      if (!next && record.exclude!.created) report.add({ kind: "delete", path: file });
      else write(report, file, next, before);
    }
  }
  if (isDir(lib.root) && !hasLinkedParent(path.dirname(projectsFile(lib)))) planProjects(report, lib, project, null);
  report.add({ kind: "delete", path: recordPath });
  apply(report, options.plan);
  if (report.actions.some((a) => a.failed)) return report;
  const leaving = new Set(report.changes().map((a) => path.resolve(a.path)));
  for (const dir of [...record.created].sort((x, y) => y.length - x.length).map((d) => at(project, d))) {
    if (!isDir(dir) || isLink(dir)) continue;
    // on plan the alias and the record are still there: count what would be left once they go
    const left = fs.readdirSync(dir).filter((n) => !(options.plan && leaving.has(path.join(dir, n))));
    if (left.length) continue;
    if (!options.plan) fs.rmdirSync(dir);
    report.add({ kind: "delete", path: dir });
  }
  return report;
}

/** The other worktrees of the repository sharing this exclude file that are Development projects too. */
function connectedWorktrees(project: string, excludeFile: string): string[] {
  const common = path.dirname(path.dirname(excludeFile));
  const trees = path.basename(common) === ".git" ? [path.dirname(common)] : [];
  const linked = path.join(common, "worktrees");
  if (isDir(linked))
    for (const name of fs.readdirSync(linked)) {
      try {
        trees.push(path.dirname(fs.readFileSync(path.join(linked, name, "gitdir"), "utf8").trim()));
      } catch {
        // a worktree git is pruning
      }
    }
  return trees.filter((t) => !samePath(real(t), real(project)) && lexists(at(t, RECORD_PATH)));
}

/** The Library's list of connected projects, beside its Development builds. */
export const PROJECTS_FILE = "projects.json";

/** projects.json: every project setup connected to this Library and its selection, by the project's real path. */
export interface ProjectsIndex {
  version: 1;
  projects: Record<string, { plugins: string[] }>;
}

export const projectsFile = (lib: Library) => path.join(developmentDirs(lib).output, PROJECTS_FILE);

/** The Library's projects.json; empty when there is none or it does not parse (setup writes it again). */
export function readProjects(lib: Library): ProjectsIndex {
  try {
    const i = JSON.parse(fs.readFileSync(projectsFile(lib), "utf8")) as ProjectsIndex;
    if (i.version === 1 && i.projects && typeof i.projects === "object") return i;
  } catch {
    // none yet
  }
  return { version: 1, projects: {} };
}

/** Plan projects.json with this project's entry set (a selection) or taken out (null). */
function planProjects(report: Report, lib: Library, project: string, plugins: string[] | null): void {
  const file = projectsFile(lib);
  const before = lexists(file) ? fs.readFileSync(file) : null;
  const index = readProjects(lib);
  const key = real(project);
  if (plugins) index.projects[key] = { plugins };
  else if (!index.projects[key]) return;
  else delete index.projects[key];
  index.projects = Object.fromEntries(Object.entries(index.projects).sort(([x], [y]) => cmp(x, y)));
  write(report, file, JSON.stringify(index, null, 2) + "\n", before);
}

/** The Harnesses a Development project is meant for first; each needs a verified adapter before it is touched. */
export const HARNESSES = ["claude-code", "codex"] as const;

export interface ProjectStatus {
  project: string;
  /** the project has a record this tool wrote */
  registered: boolean;
  library: string | null;
  alias: { path: string; state: "ok" | "missing" | "changed" } | null;
  /** each selected Plugin's last Development build: ok, stale or failed as status.json has it, or not built */
  plugins: { id: string; build: string; output: string | null; builtAt: string | null }[];
  harnesses: { harness: string; state: string; note: string }[];
  /** every project the Library's projects.json names: connected while its record names this Library, else gone */
  projects: { path: string; plugins: string[]; state: "connected" | "gone" }[];
  problems: string[];
}

/** What a project's development setup is, read only: its record, its alias, its Plugins' builds and its Library's projects. */
export function projectStatus(project: string, lib: Library | null, adapters = ADAPTERS): ProjectStatus {
  project = path.resolve(project);
  const { record, error } = readRecord(project);
  const problems: string[] = error ? [error] : [];
  const library = record ? new Library(record.library) : lib;
  const s: ProjectStatus = {
    project,
    registered: !!record,
    library: library?.root ?? null,
    alias: null,
    plugins: [],
    harnesses: HARNESSES.map((harness) => ({
      harness,
      state: "not activated",
      note: "no verified Harness adapter yet",
    })),
    projects: [],
    problems,
  };
  if (library)
    s.projects = Object.entries(readProjects(library).projects).map(([p, { plugins }]) => ({
      path: p,
      plugins,
      state: samePath(readRecord(p).record?.library ?? "", library.root) ? "connected" : "gone",
    }));
  if (!record || !library) return s;
  if (!isDir(library.root))
    problems.push(`The Library ${library.root} is gone; develop remove disconnects this project`);
  const aliasPath = at(project, record.alias);
  const state = !lexists(aliasPath)
    ? "missing"
    : isLink(aliasPath) && samePath(real(aliasPath), real(library.root))
      ? "ok"
      : "changed";
  s.alias = { path: aliasPath, state };
  if (state === "missing") problems.push(`${record.alias} is missing; develop setup puts it back`);
  if (state === "changed") problems.push(`${record.alias} is no longer the link setup made; left as it is`);
  for (const h of s.harnesses) {
    const adapter = adapters.find((x) => x.harness === h.harness && x.verified);
    const owned = record.harnesses[h.harness] ?? null;
    if (adapter?.status)
      Object.assign(h, adapter.status({ project, library, plugins: record.plugins, owned, plan: true }));
  }
  const builds = readDevelopmentStatus(library)?.plugins ?? {};
  const dirs = developmentDirs(library);
  for (const id of record.plugins) {
    const output = path.join(dirs.plugins, id);
    const b = builds[id];
    s.plugins.push({
      id,
      build: b?.state ?? "not built",
      output: b && isDir(output) ? output : null,
      builtAt: b?.builtAt ?? null,
    });
  }
  return s;
}

/** A write action when the file's text differs, planned against its current bytes. */
function write(report: Report, file: string, content: string, before: Buffer | null): Action | null {
  if (before?.toString("utf8") === content) {
    report.add({ kind: "skip", path: file });
    return null;
  }
  return report.add({ kind: "write", path: file, payload: content, expectedHash: before ? toHash(before) : null });
}
