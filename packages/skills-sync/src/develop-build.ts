// develop build: Development builds of selected Library Plugins under <library>/dist/development/, apart from the
// release packages (plugins/, the Hermes rendering, artifacts/) and from the source. Each Plugin is rendered in memory
// the way the release build renders it (normal identity, same manifests and skill copies), validated, compared with its
// output on disk, and only when it differs staged whole and swapped into place: a reader never sees a half-written
// Plugin, a failed first build leaves no output, and a later failure keeps the last successful one (stale). Unchanged
// Plugins, and Plugins not selected, are not touched. status.json records the last outcome per Plugin and is rewritten
// only when it changes. Nothing here reads or writes a Harness folder or a project's configuration.
import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { developmentPackage, folderFiles as packageFiles } from "./build.js";
import { frontmatterProblems } from "./check.js";
import { isDir, isLink, lexists, under } from "./fs.js";
import { Library } from "./library.js";
import { cmp, readConfig, type Config } from "./sources.js";

/** Where Development builds go inside the Library, / separators: under dist/, which git ignores and the skills CLI never scans. */
export const DEVELOPMENT_PATH = "dist/development";

/**
 * One Plugin's outcome in this run. built: new output is in place; unchanged: the output already matched the source;
 * stale: this build failed and the last successful output is kept; failed: this build failed and there is no output.
 */
export type PluginState = "built" | "unchanged" | "stale" | "failed";

export interface PluginStatus {
  id: string;
  state: PluginState;
  /** the Plugin folder a Harness can load: present for built, unchanged and stale; null for failed */
  output: string | null;
  /** sha256 over the output's files (path and bytes, sorted); null without output */
  sha256: string | null;
  /** when the output in place was built (ISO 8601); null without output or record */
  builtAt: string | null;
  /** why this build failed: one line each, with the source file when there is one */
  errors: string[];
  /** what the render passed over without failing (a link inside a skill, no LICENSE) */
  notes: string[];
}

export interface DevelopmentBuild {
  library: string;
  /** <library>/dist/development */
  output: string;
  plan: boolean;
  /** the whole run was refused before any Plugin was looked at (a link in the way, another build running); null otherwise */
  refused: string | null;
  plugins: PluginStatus[];
  /** no refusal and no stale or failed Plugin */
  ok: boolean;
}

/** status.json: the last outcome of every Plugin a Development build looked at. */
export interface StatusFile {
  version: 1;
  plugins: Record<string, StatusRecord>;
}

export interface StatusRecord {
  /** ok: the output matched the source when last built or checked */
  state: "ok" | "stale" | "failed";
  sha256: string | null;
  builtAt: string | null;
  errors: string[];
}

export interface DevelopmentOptions {
  /** the Plugin ids to build; every Plugin in skills-sync.json when empty or absent */
  plugins?: string[];
  /** compute and report, write nothing */
  plan?: boolean;
}

/** <library>/dist/development and the folders inside it. */
export function developmentDirs(lib: Library) {
  const output = path.join(lib.root, ...DEVELOPMENT_PATH.split("/"));
  return {
    output,
    plugins: path.join(output, "plugins"),
    work: path.join(output, ".work"),
    status: path.join(output, "status.json"),
  };
}

/** status.json as last written; null when there is none or it does not parse. */
export function readDevelopmentStatus(lib: Library): StatusFile | null {
  try {
    const s = JSON.parse(fs.readFileSync(developmentDirs(lib).status, "utf8")) as StatusFile;
    return s.version === 1 && s.plugins && typeof s.plugins === "object" ? s : null;
  } catch {
    return null;
  }
}

/**
 * Build the selected Plugins into the development output, incrementally: the one call a watcher makes after a change.
 * Synchronous; holds <output>/.work/lock while it writes, so two builds never interleave.
 */
export function buildDevelopment(lib: Library, options: DevelopmentOptions = {}): DevelopmentBuild {
  const dirs = developmentDirs(lib);
  const plan = options.plan ?? false;
  const result: DevelopmentBuild = {
    library: lib.root,
    output: dirs.output,
    plan,
    refused: null,
    plugins: [],
    ok: false,
  };
  const refuse = (why: string) => ((result.refused = why), result);
  let config: Config;
  try {
    config = readConfig(lib.configFile);
  } catch (error) {
    return refuse(`${path.basename(lib.configFile)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const blocked = blockedDestination(lib, config, dirs.output);
  if (blocked) return refuse(blocked);
  const ids = options.plugins?.length ? [...new Set(options.plugins)] : Object.keys(config.plugins);
  const lock = plan ? null : takeLock(dirs.work);
  if (lock === false)
    return refuse(
      `another development build is writing ${DEVELOPMENT_PATH}; try again when it ends, or remove ${DEVELOPMENT_PATH}/.work/lock when no build is running`,
    );
  try {
    if (!plan) recover(dirs.work, dirs.plugins);
    const before = readDevelopmentStatus(lib);
    const records: Record<string, StatusRecord> = { ...before?.plugins };
    for (const id of ids) {
      const status = buildOne({ lib, config, dirs, plan }, id, before?.plugins[id] ?? null);
      result.plugins.push(status);
      if (config.plugins[id])
        records[id] = {
          state: succeeded(status) ? "ok" : (status.state as "stale" | "failed"),
          sha256: status.sha256,
          builtAt: status.builtAt,
          errors: status.errors,
        };
    }
    if (!plan) writeStatus(dirs.status, before, records);
  } finally {
    if (lock) fs.rmSync(lock, { force: true });
  }
  result.ok = result.plugins.every(succeeded);
  return result;
}

/** A Plugin's output is in place and matches its source. */
const succeeded = (p: PluginStatus) => p.state === "built" || p.state === "unchanged";

/** What every Plugin of one run is built against. */
interface Run {
  lib: Library;
  config: Config;
  dirs: ReturnType<typeof developmentDirs>;
  plan: boolean;
}

function buildOne({ lib, config, dirs, plan }: Run, id: string, record: StatusRecord | null): PluginStatus {
  const dest = path.join(dirs.plugins, id);
  const disk = isDir(dest) && !isLink(dest) ? folderFiles(dest) : null;
  const kept = (): Pick<PluginStatus, "output" | "sha256" | "builtAt"> =>
    disk
      ? { output: dest, sha256: digest(disk), builtAt: record?.builtAt ?? null }
      : { output: null, sha256: null, builtAt: null };
  const failed = (errors: string[], notes: string[]): PluginStatus => ({
    id,
    state: disk ? "stale" : "failed",
    ...kept(),
    errors,
    notes,
  });
  if (id !== path.basename(id) || id.startsWith(".")) return failed([`${id} is not a plugin id`], []);
  if (isLink(dest))
    return failed([`${path.relative(lib.root, dest)} is a link; a development build never writes through one`], []);
  const pkg = developmentPackage(lib, config, id);
  if (!pkg.ok) return failed(pkg.errors, pkg.notes);
  const errors = validate(id, pkg.files, pkg.own ? config.plugins[id].group! : null);
  if (errors.length) return failed(errors, pkg.notes);
  const sha256 = digest(pkg.files);
  if (disk && digest(disk) === sha256)
    return {
      id,
      state: "unchanged",
      output: dest,
      sha256,
      builtAt: record?.builtAt ?? null,
      errors: [],
      notes: pkg.notes,
    };
  const builtAt = new Date().toISOString();
  if (!plan) {
    try {
      publish(dest, dirs.work, pkg.files, disk);
    } catch (error) {
      return failed(
        [`writing the output failed: ${error instanceof Error ? error.message : String(error)}`],
        pkg.notes,
      );
    }
  }
  return { id, state: "built", output: dest, sha256, builtAt, errors: [], notes: pkg.notes };
}

/**
 * What a Harness needs to load the Plugin: the three manifests naming it, at least one skill, and every SKILL.md with
 * the frontmatter check requires (an own skill's name is its folder; a Source's renamed folder keeps upstream's name).
 */
function validate(id: string, files: Map<string, Buffer>, group: string | null): string[] {
  const errors: string[] = [];
  for (const manifest of ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    try {
      if ((JSON.parse(files.get(manifest)?.toString("utf8") ?? "") as { name?: unknown }).name !== id)
        errors.push(`${manifest}: does not name ${id}`);
    } catch {
      errors.push(`${manifest}: missing or not JSON`);
    }
  }
  let skills = 0;
  for (const [rel, bytes] of [...files].sort(([a], [b]) => cmp(a, b))) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel);
    if (!m) continue;
    skills++;
    const where = group ? `skills/${group}/${m[1]}/SKILL.md` : rel;
    for (const reason of frontmatterProblems(bytes.toString("utf8"), m[1]))
      if (group || !reason.includes("is not the folder's name")) errors.push(`${where}: ${reason}`);
  }
  if (!skills) errors.push("no skill to package");
  return errors;
}

/**
 * The package written whole into a folder of its own under .work, read back, then renamed into place; the folder it
 * replaces is renamed aside first and removed last. A file whose bytes did not change is carried over as a hard link,
 * so it keeps its inode and timestamps.
 */
function publish(dest: string, work: string, files: Map<string, Buffer>, disk: Map<string, Buffer> | null): void {
  const tag = `${path.basename(dest)}.${process.pid}.${randomBytes(4).toString("hex")}`;
  const stage = path.join(work, `${tag}.new`);
  const old = path.join(work, `${tag}.old`);
  try {
    for (const [rel, bytes] of files) {
      const file = path.join(stage, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (disk?.get(rel)?.equals(bytes) && hardlink(path.join(dest, ...rel.split("/")), file)) continue;
      fs.writeFileSync(file, bytes);
    }
    if (digest(folderFiles(stage)) !== digest(files)) throw new Error("the staged output does not read back as built");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (lexists(dest)) fs.renameSync(dest, old);
    try {
      fs.renameSync(stage, dest);
    } catch (error) {
      if (lexists(old)) fs.renameSync(old, dest);
      throw error;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    // the previous output is removed only once a package is in place again; otherwise the next run's recover() puts it back
    if (lexists(dest)) fs.rmSync(old, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** The unchanged file itself in the staged package (same bytes, same timestamps); false where the file system refuses, and it is written instead. */
function hardlink(from: string, to: string): boolean {
  try {
    fs.linkSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** What a build that died left under .work: an output renamed aside goes back when nothing replaced it; the rest goes. */
function recover(work: string, pluginsDir: string): void {
  if (!isDir(work)) return;
  for (const name of fs.readdirSync(work).sort(cmp)) {
    const m = /^(.+)\.\d+\.[0-9a-f]{8}\.(new|old)$/.exec(name);
    if (!m) continue;
    const dest = path.join(pluginsDir, m[1]);
    if (m[2] === "old" && !lexists(dest)) fs.renameSync(path.join(work, name), dest);
    else fs.rmSync(path.join(work, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Why the output folder cannot be written: a link on the way to it, or the release's Hermes rendering sharing it. */
function blockedDestination(lib: Library, config: Config, output: string): string | null {
  for (let p = output; under(p, lib.root) && p !== lib.root; p = path.dirname(p))
    if (isLink(p)) return `${path.relative(lib.root, p)} is a link; a development build never writes through one`;
  const hermes = config.renderings?.hermes;
  if (hermes) {
    const rendering = path.join(lib.root, ...hermes.split("/"));
    if (under(rendering, output) || under(output, rendering))
      return `renderings.hermes (${hermes}) overlaps ${DEVELOPMENT_PATH}; release and development output must stay apart`;
  }
  return null;
}

function writeStatus(file: string, before: StatusFile | null, records: Record<string, StatusRecord>): void {
  const sorted = Object.fromEntries(Object.entries(records).sort(([a], [b]) => cmp(a, b)));
  const next: StatusFile = { version: 1, plugins: sorted };
  const text = JSON.stringify(next, null, 2) + "\n";
  if (lexists(file) && fs.readFileSync(file, "utf8") === text) return;
  if (before === null && !Object.keys(sorted).length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The build's lock: created exclusively; one left by a process that is gone is taken over. false when another build holds it. */
function takeLock(work: string): string | false {
  const lock = path.join(work, "lock");
  fs.mkdirSync(work, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const pid = Number.parseInt(fs.readFileSync(lock, "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) return false;
    fs.rmSync(lock, { force: true });
  }
  return false;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every file of an output folder, relative path (/ separators) -> bytes; a link inside is an entry that no build produces, so the output never matches and is rebuilt. */
function folderFiles(dir: string): Map<string, Buffer> {
  const { files, links } = packageFiles(dir);
  for (const l of links) files.set(`${l} (link)`, Buffer.alloc(0));
  return files;
}

/** sha256 over the files' paths and bytes, in path order. */
export function digest(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const rel of [...files.keys()].sort(cmp)) h.update(rel).update("\0").update(files.get(rel)!).update("\0");
  return h.digest("hex");
}
