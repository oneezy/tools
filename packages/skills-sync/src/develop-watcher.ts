// develop watch: the one Development watcher of a Library. The first terminal that runs it owns it: the watcher runs in
// that terminal's foreground, prints there, and stops when that terminal closes (a hang-up, Ctrl+C or Ctrl+Break, or
// its parent process gone). A later launch from any project finds the owner recorded beside projects.json, names it and
// starts nothing. There is no detached process, no service and no takeover of a running watcher: a record whose owner
// is gone, or has stopped beating, is simply stopped, and the next launch owns the watcher afresh.
//
// The watcher watches the Library's real root once, so an edit through any project's Source alias is one event at the
// canonical path. After a quiet period it digests the build inputs; when they and the served selection are unchanged,
// it does nothing. Otherwise it builds the Plugins the connected projects select (buildDevelopment writes only the
// ones whose output differs, and keeps the last successful output when a build fails). Every start builds once, which
// catches up on edits made while no watcher ran. Stopping leaves the builds and every project as they are.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { alive, buildDevelopment, developmentDirs, type DevelopmentBuild } from "./develop-build.js";
import { readProjects, readRecord } from "./develop-project.js";
import { BuildInputs, isBuildInput, watchSource } from "./develop-watch.js";
import { real, samePath } from "./fs.js";
import { Library } from "./library.js";
import { cmp } from "./sources.js";

/** The owner record, beside projects.json in the Development output. */
export const WATCHER_FILE = "watcher.json";
/** The folder a launch holds (made exclusively) while it reads the owner record and writes its own. */
const CLAIM = "watcher.claim";
/** How often a running watcher touches its record and checks its terminal: SKILLS_SYNC_WATCH_HEARTBEAT_MS, else 2 s. */
const HEARTBEAT_MS = 2000;
/** A record not touched for this many heartbeats has no live owner (a reused pid, a suspended process). */
const MISSED_BEATS = 5;

export interface WatcherRecord {
  version: 1;
  state: "running" | "stopped";
  /** this run's own mark: a watcher that finds another token in the record has lost it, and stops */
  token: string;
  pid: number;
  /** the process that started the watcher: its terminal, or the shell or script in it */
  ppid: number;
  library: string;
  /** the Development project it was started from; null when started with --repo outside one */
  project: string | null;
  /** what the environment says the terminal is (Windows Terminal, TERM_PROGRAM); null when it says nothing */
  terminal: string | null;
  startedAt: string;
  heartbeatMs: number;
  stoppedAt: string | null;
  stopReason: string | null;
}

/** The watcher as develop status reports it. */
export interface WatcherStatus {
  /** running: a live owner beats; stopped: none does, so edits are not being built */
  state: "running" | "stopped";
  owner: { pid: number; project: string | null; terminal: string | null; startedAt: string } | null;
  stoppedAt: string | null;
  note: string;
  /** the Plugins connected projects select: what a watcher builds */
  plugins: string[];
  /** while stopped: the served Plugins whose build does not match their source now (edits not built, or a source that fails) */
  behind: string[];
}

export const watcherFile = (lib: Library) => path.join(developmentDirs(lib).output, WATCHER_FILE);

/** The owner record as last written; null when there is none or it does not parse. */
export function readWatcher(lib: Library): WatcherRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(watcherFile(lib), "utf8")) as WatcherRecord;
    return r.version === 1 && typeof r.pid === "number" && typeof r.token === "string" ? r : null;
  } catch {
    return null;
  }
}

/** The record names a running owner whose process exists and who touched the record within its missed-beat window. */
function live(lib: Library, r: WatcherRecord | null): boolean {
  if (!r || r.state !== "running" || !alive(r.pid)) return false;
  try {
    return Date.now() - fs.statSync(watcherFile(lib)).mtimeMs < r.heartbeatMs * MISSED_BEATS;
  } catch {
    return false;
  }
}

/** The Plugins the Library's connected projects select (a project whose record no longer names this Library is gone). */
export function servedPlugins(lib: Library): { plugins: string[]; projects: string[] } {
  const plugins = new Set<string>();
  const projects: string[] = [];
  for (const [project, entry] of Object.entries(readProjects(lib).projects)) {
    if (!samePath(readRecord(project).record?.library ?? "", lib.root)) continue;
    projects.push(project);
    for (const id of entry.plugins) plugins.add(id);
  }
  return { plugins: [...plugins].sort(cmp), projects };
}

/** Whether a watcher runs for the Library, who owns it, and, while none runs, which builds are behind their source. Writes nothing. */
export function watcherStatus(lib: Library): WatcherStatus {
  const r = readWatcher(lib);
  const { plugins } = servedPlugins(lib);
  if (r && live(lib, r))
    return {
      state: "running",
      owner: { pid: r.pid, project: r.project, terminal: r.terminal, startedAt: r.startedAt },
      stoppedAt: null,
      note: `pid ${r.pid}, started ${r.startedAt}${r.project ? ` from ${r.project}` : ""}; it builds each edit`,
      plugins,
      behind: [],
    };
  const behind = plugins.length
    ? buildDevelopment(lib, { plugins, plan: true })
        .plugins.filter((p) => p.state !== "unchanged")
        .map((p) => p.id)
    : [];
  const why = !r
    ? "never started"
    : r.state === "stopped"
      ? `stopped ${r.stoppedAt}${r.stopReason ? ` (${r.stopReason})` : ""}`
      : `its owner (pid ${r.pid}) ended without stopping`;
  return {
    state: "stopped",
    owner: null,
    stoppedAt: r?.stoppedAt ?? null,
    note: `${why}; edits are not built until develop watch runs again`,
    plugins,
    behind,
  };
}

export interface WatchOptions {
  /** the Development project the launch ran in, or null */
  project: string | null;
  /** one line of the watcher's output */
  print: (line: string) => void;
  /** quiet period after the last event, in ms */
  delay?: number;
}

/**
 * develop watch: own the Library's watcher, or name the owner. Resolves with the exit code once the watcher stops, or
 * at once when another launch owns it.
 */
export function runWatcher(lib: Library, options: WatchOptions): Promise<number> {
  const heartbeatMs = Math.max(50, Number(process.env.SKILLS_SYNC_WATCH_HEARTBEAT_MS) || HEARTBEAT_MS);
  const record: WatcherRecord = {
    version: 1,
    state: "running",
    token: randomBytes(8).toString("hex"),
    pid: process.pid,
    ppid: process.ppid,
    library: lib.root,
    project: options.project ? real(options.project) : null,
    terminal: terminalName(),
    startedAt: new Date().toISOString(),
    heartbeatMs,
    stoppedAt: null,
    stopReason: null,
  };
  const claimed = claim(lib, record);
  if (claimed !== true) {
    options.print(
      `The watcher for ${lib.root} already runs: pid ${claimed.pid}, started ${claimed.startedAt}${claimed.project ? ` from ${claimed.project}` : ""}${claimed.terminal ? ` (${claimed.terminal})` : ""}. Edits are built there; Ctrl+C in that terminal, or closing it, stops it.`,
    );
    return Promise.resolve(0);
  }
  return new Promise<number>((resolve) => {
    const file = watcherFile(lib);
    const inputs = new BuildInputs(lib.root);
    let builds = 0;
    let last: { digest: string; served: string } | null = null;
    let retry = false;
    let waiting = false;
    let stopped = false;
    let quiet = false;

    const print = (line: string) => {
      if (quiet) return;
      try {
        options.print(line);
      } catch {
        quiet = true;
      }
    };
    const cycle = () => {
      if (stopped) return;
      const { plugins } = servedPlugins(lib);
      const digest = inputs.digest();
      const served = plugins.join(",");
      if (!retry && last && last.digest === digest && last.served === served) return;
      retry = false;
      if (!plugins.length) {
        if (last?.served !== "")
          print(`${clock()} no connected project selects a Plugin; develop setup <plugin> connects one`);
        last = { digest, served };
        return;
      }
      const r = buildDevelopment(lib, { plugins });
      if (r.refused) {
        // another build holds the lock: try again each beat until it ends; any other refusal waits for the next edit
        retry = r.refused.startsWith("another development build");
        if (!waiting) print(`${clock()} build refused: ${r.refused}`);
        waiting = retry;
        if (!retry) last = { digest, served };
        return;
      }
      waiting = false;
      builds++;
      print(`${clock()} build ${builds}: ${summary(r)}`);
      for (const p of r.plugins) for (const e of p.errors) print(`  ! ${p.id}: ${e}`);
      retry = r.plugins.some((p) => p.errors.some((e) => e.startsWith("writing the output failed")));
      last = { digest, served };
    };
    const guarded = () => {
      try {
        cycle();
      } catch (error) {
        print(`${clock()} build failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const beat = () => {
      if (stopped) return;
      const now = readWatcher(lib);
      if (now?.token !== record.token)
        return stop("another watcher started while this one was not beating (suspended?)", 1);
      if (process.ppid !== record.ppid || !alive(record.ppid)) return stop("its terminal closed", 0);
      try {
        const t = new Date();
        fs.utimesSync(file, t, t);
      } catch {
        // the next beat tries again
      }
      // a project set up or removed meanwhile changes what is served; setup writes its record last, so look each beat
      if (retry || servedPlugins(lib).plugins.join(",") !== last?.served) guarded();
    };
    // closing a console window is SIGHUP on Windows too; Ctrl+Break is SIGBREAK there
    const signals: NodeJS.Signals[] = [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      ...(process.platform === "win32" ? (["SIGBREAK"] as const) : []),
    ];
    const onSignal = (signal: NodeJS.Signals) =>
      stop(signal === "SIGHUP" ? "its terminal closed" : `${signal} (Ctrl+C or a stop request)`, 0);
    const onPipe = () => {
      quiet = true;
      stop("its terminal closed", 0);
    };
    const failed = (error: unknown) => {
      print(`${clock()} the source watch failed: ${error instanceof Error ? error.message : String(error)}`);
      stop("its source watch failed", 1);
    };
    let close = () => {};
    try {
      close = watchSource(lib.root, isBuildInput, guarded, failed, options.delay);
    } catch (error) {
      // no watch at all (the root gone, no watch handles left): stopped before anything started
      writeRecord(file, {
        ...record,
        state: "stopped",
        stoppedAt: new Date().toISOString(),
        stopReason: "no source watch",
      });
      print(`The source watch could not start: ${error instanceof Error ? error.message : String(error)}`);
      return resolve(1);
    }
    const timer = setInterval(beat, heartbeatMs);
    function stop(reason: string, code: number) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      close();
      for (const s of signals) process.off(s, onSignal);
      process.stdout.off("error", onPipe);
      const now = readWatcher(lib);
      if (now?.token === record.token)
        writeRecord(file, { ...record, state: "stopped", stoppedAt: new Date().toISOString(), stopReason: reason });
      print(
        `${clock()} Watcher stopped: ${reason}. The last successful builds stay in place; develop watch starts it again and catches up.`,
      );
      resolve(code);
    }
    for (const s of signals) process.on(s, onSignal);
    process.stdout.on("error", onPipe);

    const projects = servedPlugins(lib).projects;
    print(
      `Watching ${lib.root} for ${projects.length} connected project${projects.length === 1 ? "" : "s"}. This terminal owns the watcher (pid ${process.pid}); Ctrl+C or closing the terminal stops it.`,
    );
    guarded();
  });
}

/**
 * Write the record when no live owner holds it, or return the owner that does. The claim folder makes the read and
 * the write one step against another launch; a claim left by a launch that died in that step goes after 10 s.
 */
function claim(lib: Library, record: WatcherRecord): true | WatcherRecord {
  const dir = developmentDirs(lib).output;
  const lock = path.join(dir, CLAIM);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    if (age > 10_000 || attempt > 500) fs.rmSync(lock, { recursive: true, force: true });
    else sleep(20);
  }
  try {
    const owner = readWatcher(lib);
    if (owner && live(lib, owner)) return owner;
    writeRecord(watcherFile(lib), record);
    return true;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writeRecord(file: string, record: WatcherRecord): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open for a moment
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== "EPERM") {
        fs.rmSync(tmp, { force: true });
        throw error;
      }
      sleep(25);
    }
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What the environment says this terminal is; null when it says nothing. */
function terminalName(): string | null {
  if (process.env.WT_SESSION) return "Windows Terminal";
  if (process.env.TERM_PROGRAM) return process.env.TERM_PROGRAM;
  return null;
}

const clock = () => new Date().toTimeString().slice(0, 8);

/** One build's Plugins in a line: play built, oneezy unchanged, ... */
function summary(r: DevelopmentBuild): string {
  const words = {
    built: "built",
    unchanged: "unchanged",
    stale: "stale (the last successful build stays)",
    failed: "failed (no build)",
  };
  return r.plugins.map((p) => `${p.id} ${words[p.state]}`).join(", ");
}
