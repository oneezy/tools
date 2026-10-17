// develop setup, status and remove: a Development project, connected to the one editable Library. Setup links the
// project's Source alias (.agents/skills-library) to the Library root, keeps both out of git through a marked block in
// the repository's info/exclude, and writes the project record (.agents/skills-sync-project.json): the Library, the
// selected Plugins, and what setup made, so that remove takes away exactly that and nothing a person changed since.
// Activating a Plugin in a Harness is a Harness adapter's job: setup builds the selection first when a verified adapter
// will run, hands it the build, applies the actions it planned with its own, runs its Harness CLI commands, and only then
// writes the record. The Claude Code and Codex adapters (develop-claude-code.ts, develop-codex.ts) are here but not
// verified: until the Windows runtime proof exists, setup names them and never runs them.
import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, isDir, isLink, lexists, linkTarget, real, samePath, toHash, under } from "./fs.js";
import { claudeCodeAdapter } from "./develop-claude-code.js";
import { buildDevelopment, developmentDirs, readDevelopmentStatus, type DevelopmentBuild } from "./develop-build.js";
import { codexAdapter } from "./develop-codex.js";
import {
  ALIAS_PATH,
  projectsFile,
  readProjects,
  readRecord,
  RECORD_PATH,
  TEST_SWITCH,
  testSwitch,
  type HarnessAdapter,
  type ProjectRecord,
} from "./develop-record.js";
import { watcherStatus, type WatcherStatus } from "./develop-watcher.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cmp, readConfig } from "./sources.js";

export {
  ALIAS_PATH,
  PROJECTS_FILE,
  projectsFile,
  readProjects,
  readRecord,
  RECORD_PATH,
  testSwitch,
  type AdapterContext,
  type AdapterResult,
  type HarnessAdapter,
  type ProjectRecord,
  type ProjectsIndex,
} from "./develop-record.js";

const START = "# skills-sync:development-project:start";
const END = "# skills-sync:development-project:end";

/**
 * The adapters this version has. None is verified yet: Claude Code waits on its Windows proof (#213), Codex on its proof
 * in the ChatGPT desktop app on Windows (#214, #217).
 */
export const ADAPTERS: HarnessAdapter[] = [
  claudeCodeAdapter({ verified: testSwitch("claude-code") }),
  codexAdapter({ verified: testSwitch("codex") }),
];

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

/**
 * The block's entries: setup's own, then the excludes of each adapter that is verified or owns state in the record,
 * once each in that order. While the record holds any Harness state the block never shrinks: the previous entries stay,
 * so a shell where an adapter is unverified never lets git see that adapter's files.
 */
function excludeEntries(adapters: HarnessAdapter[], previous: ProjectRecord | null): string[] {
  const owning = (a: HarnessAdapter) => a.verified || previous?.harnesses[a.harness] !== undefined;
  const kept = Object.keys(previous?.harnesses ?? {}).length ? (previous?.exclude?.entries ?? []) : [];
  return [...new Set([...EXCLUDED, ...adapters.filter(owning).flatMap((a) => a.excludes ?? []), ...kept])];
}

/** What a Harness is when the record holds its state but this shell has no verified adapter to manage it. */
export const UNVERIFIED_STATE = "activated, adapter unverified";
const unverifiedNote = (harness: string) =>
  `the record holds its state, and this shell has no verified adapter for it: run with ${TEST_SWITCH}=${harness} to manage it`;

/** The exclude file's text with this setup's block in it (once, at the end), or without it. */
export function excludeText(before: string, present: boolean, entries: string[] = EXCLUDED): string {
  const start = before.indexOf(START);
  const end = before.indexOf(END);
  if (start < 0 !== end < 0 || (start >= 0 && end < start)) throw new Error("incomplete development exclude markers");
  const rest = start < 0 ? before : before.slice(0, start) + before.slice(end + END.length).replace(/^\r?\n/, "");
  if (!present) return rest;
  const head = rest && !rest.endsWith("\n") ? `${rest}\n` : rest;
  return `${head}${START}\n${entries.join("\n")}\n${END}\n`;
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

  // without a record, a .agents holding nothing but this Library's alias is what an interrupted setup left: its own
  const agents = path.join(project, ".agents");
  const leftover =
    isDir(agents) &&
    !isLink(agents) &&
    fs.readdirSync(agents).length > 0 &&
    fs.readdirSync(agents).every((n) => n === path.basename(ALIAS_PATH)) &&
    isLink(aliasPath) &&
    samePath(real(aliasPath), library);
  const created = previous?.created ?? (isDir(agents) && !leftover ? [] : [".agents"]);
  if (!lexists(aliasPath)) report.add({ kind: "link", path: aliasPath, target: library });
  else if (isLink(aliasPath) && samePath(real(aliasPath), library)) report.add({ kind: "skip", path: aliasPath });
  else conflict(aliasPath, "Something else is at the Source alias; left untouched");

  const adapters = options.adapters ?? ADAPTERS;
  const excludeFile = gitExcludeFile(project);
  let exclude: ProjectRecord["exclude"] = null;
  if (excludeFile) {
    const exists = lexists(excludeFile);
    const entries = excludeEntries(adapters, previous);
    exclude = { file: excludeFile, created: previous?.exclude?.created ?? !exists, entries };
    const before = exists ? fs.readFileSync(excludeFile) : null;
    try {
      write(report, excludeFile, excludeText(before?.toString("utf8") ?? "", true, entries), before);
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
  for (const adapter of adapters.filter((x) => !x.verified))
    report.add({
      kind: "note",
      path: project,
      loud: next.harnesses[adapter.harness] !== undefined,
      note:
        next.harnesses[adapter.harness] === undefined
          ? `${adapter.harness}: not activated: its adapter is not verified`
          : `${adapter.harness}: ${UNVERIFIED_STATE}: ${unverifiedNote(adapter.harness)}; left as it is`,
    });
  const activating = adapters.filter((x) => x.verified);
  // build and validate before the first activation: a failed build leaves the project's Harness configuration alone
  const build = activating.length ? buildDevelopment(lib, { plugins: next.plugins, plan: options.plan }) : null;
  if (build?.refused) conflict(build.output, `Development build refused: ${build.refused}; nothing activated`);
  for (const p of build?.plugins ?? []) {
    if (p.state === "failed")
      conflict(
        p.output ?? build!.output,
        `${p.id}: development build failed: ${p.errors.join("; ")}; nothing activated`,
      );
    if (p.state === "stale")
      report.add({
        kind: "note",
        path: p.output!,
        loud: true,
        note: `${p.id}: development build failed (${p.errors.join("; ")}); its last successful build is used`,
      });
  }
  if (report.conflicts().length) return report;
  const commands: { adapter: HarnessAdapter; run: () => Report }[] = [];
  for (const adapter of activating) {
    const ctx = { project, library: lib, plugins: next.plugins, owned: previous?.harnesses[adapter.harness] ?? null };
    const planned = adapter.setup({ ...ctx, plan: options.plan, build });
    report.merge(planned.report);
    if (planned.commands) commands.push({ adapter, run: planned.commands });
    if (planned.owned === null || planned.owned === undefined) delete next.harnesses[adapter.harness];
    else next.harnesses[adapter.harness] = planned.owned;
  }
  if (hasLinkedParent(path.dirname(projectsFile(lib))))
    conflict(projectsFile(lib), "A parent folder is a link; left untouched");
  else planProjects(report, lib, project, next.plugins);
  if (report.conflicts().length) return report;
  apply(report, options.plan);
  if (report.actions.some((a) => a.failed)) return report;
  if (!options.plan) {
    const failed = runCommands(
      report,
      commands.map((c) => c.run),
    );
    if (failed >= 0) {
      // nothing activated on a failure: the adapters whose commands finished are taken back, and a record is written
      // only for what could not be (so develop remove can), or for state the previous setup owned already
      const stays = undoActivations(report, project, lib, next, previous, commands.slice(0, failed));
      if (!stays) return report;
    }
  }
  const last = new Report();
  const before = lexists(recordPath) ? fs.readFileSync(recordPath) : null;
  write(last, recordPath, JSON.stringify(next, null, 2) + "\n", before);
  apply(last, options.plan);
  report.merge(last);
  const managed = (h: string) => adapters.some((a) => a.harness === h && a.verified);
  const active = Object.keys(next.harnesses).map((h) => (managed(h) ? h : `${h} (adapter unverified in this shell)`));
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
  const commands: (() => Report)[] = [];
  for (const [harness, owned] of Object.entries(record.harnesses)) {
    const adapter = (options.adapters ?? ADAPTERS).find((x) => x.harness === harness && x.verified);
    if (!adapter) {
      report.add({
        kind: "conflict",
        path: recordPath,
        note: `${harness} owns state here, and no verified adapter for it is in this version; nothing removed (run with ${TEST_SWITCH}=${harness} to remove it)`,
      });
      continue;
    }
    const planned = adapter.remove({
      project,
      library: lib,
      plugins: record.plugins,
      owned,
      plan: options.plan,
      build: null,
    });
    if (planned instanceof Report) report.merge(planned);
    else {
      report.merge(planned.report);
      if (planned.commands) commands.push(planned.commands);
    }
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
    const ours = blockOf(excludeText("", true, record.exclude?.entries ?? EXCLUDED));
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
  // the Harnesses first: when one refuses, nothing of the setup is taken away and the record stays for a retry
  const ran = new Report();
  if (!options.plan && !runCommands(ran, commands)) {
    report.actions = report.actions.filter((a) => a.kind === "conflict" || a.kind === "note");
    report.merge(ran);
    return report;
  }
  apply(report, options.plan);
  // what the commands did, after: apply() must not run their actions again
  report.merge(ran);
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

/**
 * Run each adapter's commands in turn, merging what they did; the index of the one whose action failed (the rest not
 * run), or -1 when all finished.
 */
function runCommands(report: Report, commands: (() => Report)[]): number {
  for (const [i, run] of commands.entries()) {
    const done = run();
    report.merge(done);
    if (done.actions.some((a) => a.failed)) return i;
  }
  return -1;
}

/**
 * After a later adapter's commands failed in setup, take back what the earlier adapters' commands did: each one this
 * setup activated for the first time runs its own remove against what it just returned as owned, newest first. One the
 * previous record owned already keeps its new state (remove cannot return it to the old selection), and so does one
 * whose remove refuses or fails. `next.harnesses` is left holding exactly the state that stays: those, plus the
 * previous record's state of every adapter that did not finish. True when the record must be written to describe it.
 */
function undoActivations(
  report: Report,
  project: string,
  lib: Library,
  next: ProjectRecord,
  previous: ProjectRecord | null,
  finished: { adapter: HarnessAdapter; run: () => Report }[],
): boolean {
  const done = new Set(finished.map((f) => f.adapter.harness));
  for (const harness of Object.keys(next.harnesses))
    if (!done.has(harness)) {
      if (previous?.harnesses[harness] === undefined) delete next.harnesses[harness];
      else next.harnesses[harness] = previous.harnesses[harness];
    }
  let stays = false;
  for (const { adapter } of [...finished].reverse()) {
    const h = adapter.harness;
    const owned = next.harnesses[h];
    if (owned === undefined) continue;
    const note = (text: string) => report.add({ kind: "note", path: project, loud: true, note: `${h}: ${text}` });
    if (previous?.harnesses[h] !== undefined) {
      note("its new state stays, since it was activated here before; develop setup tries the rest again");
      stays = true;
      continue;
    }
    const planned = adapter.remove({ project, library: lib, plugins: next.plugins, owned, plan: false, build: null });
    const plan = planned instanceof Report ? planned : planned.report;
    const ran = new Report();
    let ok = !plan.conflicts().length;
    // as in remove: the Harness's commands first, then the planned file actions
    if (ok && !(planned instanceof Report) && planned.commands) ran.merge(planned.commands());
    ok &&= !ran.actions.some((a) => a.failed);
    if (ok) apply(plan, false);
    report.merge(ran);
    if (ok && !plan.actions.some((a) => a.failed)) {
      delete next.harnesses[h];
      note("taken back, since a later Harness failed; nothing activated");
    } else {
      for (const a of plan.actions)
        if (a.kind === "conflict" || a.failed) report.add({ ...a, kind: "note", loud: true });
      note("still activated: taking it back failed; develop remove takes it back");
      stays = true;
    }
  }
  return stays;
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
  /** the Library's Development watcher: running (and its owner) or stopped (and which builds are behind); null without a Library */
  watcher: WatcherStatus | null;
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
    watcher: library && isDir(library.root) ? watcherStatus(library) : null,
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
    if (!adapter && owned !== null) Object.assign(h, { state: UNVERIFIED_STATE, note: unverifiedNote(h.harness) });
    else if (adapter?.status)
      Object.assign(h, adapter.status({ project, library, plugins: record.plugins, owned, plan: true, build: null }));
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

/** A write action when the file's text differs, planned against its current bytes; a skip when it is already right. */
function write(report: Report, file: string, content: string, before: Buffer | null): void {
  if (before?.toString("utf8") === content) report.add({ kind: "skip", path: file });
  else report.add({ kind: "write", path: file, payload: content, expectedHash: before ? toHash(before) : null });
}
