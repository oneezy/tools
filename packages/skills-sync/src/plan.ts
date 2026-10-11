// Every step builds a list of actions first; apply() executes them unless planning.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  copyDir,
  isLink,
  lexists,
  makeLink,
  removeLink,
  samePath,
  under,
  hasLinkedParent,
  toHash,
  real,
  type LinkKind,
} from "./fs.js";

/**
 * remove drops a link; delete drops a real folder or file (only ever a generated one: a snapshot, a working-set copy or
 * a built package); move renames a file this tool wrote (path -> target). note says something about a path without
 * touching it (a package built without a LICENSE): printed, and neither a change nor a conflict. install and uninstall
 * record a host plugin command the plugin step already ran (or would run, on plan); apply() never runs them.
 */
export type Kind =
  | "link"
  | "relink"
  | "remove"
  | "delete"
  | "replace-copy"
  | "copy"
  | "write"
  | "move"
  | "exclude"
  | "install"
  | "uninstall"
  | "skip"
  | "conflict"
  | "note";

export interface Action {
  kind: Kind;
  path: string;
  target?: string;
  note?: string;
  /** for write: the file body; for exclude: the entries */
  payload?: string | Buffer | string[];
  expectedHash?: string | null;
  dependencies?: Array<{ path: string; target: string | null; files: Array<{ name: string; hash: string }> }>;
  failed?: boolean;
  /**
   * for write: where the file as it was is copied first, beside it, never over an existing file (a name taken already
   * gets -2, -3 ...: the path the copy really went to replaces this one, and the note with it)
   */
  backup?: string;
  /** for note: printed under --quiet too, when nothing changed (the one line about a block that could not be updated) */
  loud?: boolean;
  diagnostic?: { command: string[]; exitCode: number | null; stderr: string; stdout: string };
}

export class Report {
  actions: Action[] = [];
  /** how many links apply() made of each kind, so the run can say which it used */
  links: Record<LinkKind, number> = { symlink: 0, junction: 0 };
  add(a: Action): Action {
    this.actions.push(a);
    return a;
  }
  changes(): Action[] {
    return this.actions.filter((a) => a.kind !== "skip" && a.kind !== "conflict" && a.kind !== "note");
  }
  conflicts(): Action[] {
    return this.actions.filter((a) => a.kind === "conflict");
  }
  skips(): number {
    return this.actions.filter((a) => a.kind === "skip").length;
  }
  merge(other: Report): void {
    this.actions.push(...other.actions);
    this.links.symlink += other.links.symlink;
    this.links.junction += other.links.junction;
  }
}

const MARK: Record<Kind, string> = {
  link: "+",
  relink: "~",
  remove: "-",
  delete: "-",
  "replace-copy": "~",
  copy: "+",
  write: "+",
  move: "~",
  exclude: "+",
  install: "+",
  uninstall: "-",
  skip: "=",
  conflict: "!",
  note: ".",
};

export function line(a: Action): string {
  const tail = a.target ? ` -> ${a.target}` : "";
  const note = a.note ? `  (${a.note})` : "";
  return `${MARK[a.kind]} ${a.kind.padEnd(12)} ${a.path}${tail}${note}`;
}

export function apply(report: Report, plan: boolean, exclude?: (repo: string, entries: string[]) => boolean): void {
  if (plan) return;
  const link = (a: Action) => {
    report.links[makeLink(a.target!, a.path)]++;
  };
  const failedPaths: string[] = [];
  for (const a of report.actions) {
    if (
      a.kind === "skip" ||
      a.kind === "conflict" ||
      a.kind === "note" ||
      a.kind === "install" ||
      a.kind === "uninstall"
    )
      continue;
    const dependency = failedPaths.find((file) => under(a.path, file) || (a.target && under(a.target, file)));
    if (dependency) {
      a.kind = "conflict";
      a.failed = true;
      a.note = `dependent action blocked by failed destination ${dependency}`;
      failedPaths.push(a.path);
      continue;
    }
    const kind = a.kind;
    try {
      switch (a.kind) {
        case "link":
          link(a);
          break;
        case "relink":
          removeLink(a.path);
          link(a);
          break;
        case "remove":
          removeLink(a.path);
          break;
        case "delete":
          fs.rmSync(a.path, { recursive: true, force: true, maxRetries: 3 });
          break;
        case "replace-copy":
          fs.rmSync(a.path, { recursive: true, force: true });
          link(a);
          break;
        case "copy":
          copyDir(a.target!, a.path);
          break;
        case "write":
          for (const dependency of a.dependencies ?? []) {
            const owned =
              dependency.target === null
                ? !isLink(dependency.path)
                : isLink(dependency.path) && samePath(real(dependency.path), dependency.target);
            if (
              !owned ||
              dependency.files.some((file) => {
                const installed = path.join(dependency.path, file.name);
                return (
                  isLink(installed) ||
                  !under(real(installed), real(dependency.path)) ||
                  toHash(fs.readFileSync(installed)) !== file.hash
                );
              })
            )
              throw new Error(`${dependency.path}: instruction dependency changed since planning; left alone`);
          }
          write(a);
          break;
        case "move":
          fs.mkdirSync(path.dirname(a.target!), { recursive: true });
          fs.renameSync(a.path, a.target!);
          break;
        case "exclude":
          exclude?.(a.path, a.payload as string[]);
          break;
      }
    } catch (error) {
      a.kind = "conflict";
      a.failed = true;
      const code = (error as NodeJS.ErrnoException).code;
      a.note = `${kind} failed${code ? ` (${code})` : ""}: ${error instanceof Error ? error.message : String(error)}; independent destinations continue`;
      failedPaths.push(a.path);
    }
  }
}

/** How old another run's lock may be before it counts as left behind by a run that died. */
const LOCK_STALE_MS = 60_000;

/**
 * One write. An instruction write (planned against the file's hash) holds the file's lock, `<file>.skills-sync.lock`,
 * around the hash check, the backup and the rename, so two runs at once (a session hook and a sync, two sessions
 * starting) never interleave: the one that finds the lock taken skips the file silently, the other is writing it.
 */
function write(a: Action): void {
  const instruction = a.expectedHash !== undefined;
  const changed = () => {
    a.kind = "conflict";
    a.note = "instruction file changed since planning; left alone";
  };
  if (instruction && hasLinkedParent(a.path)) return changed();
  fs.mkdirSync(path.dirname(a.path), { recursive: true });
  const lock = instruction ? takeLock(a.path) : null;
  if (lock === false) {
    a.kind = "skip";
    a.note = "another skills-sync run is writing it";
    return;
  }
  try {
    if (instruction) {
      const current = lexists(a.path) ? fs.readFileSync(a.path) : null;
      if ((current ? toHash(current) : null) !== a.expectedHash) return changed();
    }
    // planned as a new file: never over one that appeared since
    if (a.expectedHash === null && lexists(a.path)) throw new Error(`${a.path}: exists since planning; left alone`);
    const made = writeInstruction(a.path, a.payload as string | Buffer, a.backup ?? null, a.expectedHash);
    if (made && a.backup && made !== a.backup) {
      a.note = a.note?.replace(a.backup, made);
      a.backup = made;
    }
    if (instruction && !fs.readFileSync(a.path).equals(Buffer.from(a.payload as string)))
      throw new Error(`${a.path}: instruction readback differs from the planned write`);
  } finally {
    if (lock) fs.rmSync(lock, { force: true });
  }
}

/**
 * The file's lock for this run: created exclusively, so only one run holds it. Taken by another run: false, unless
 * that lock is older than a minute (its run died), which is removed and taken.
 */
function takeLock(file: string): string | false {
  const lock = `${file}.skills-sync.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let age: number;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      continue; // released meanwhile: try again
    }
    if (age < LOCK_STALE_MS) return false;
    fs.rmSync(lock, { force: true });
  }
  return false;
}

/**
 * Write `file` whole: the new body to a temp file of this process's own beside it first, then the backup of the file
 * as it is (when one is asked for and the file exists), checked against `expectedHash`, then the rename into place (a
 * rename replaces on Windows too), so a crash never leaves the file empty or half written. When any step fails the
 * temp file goes, and so does the backup this call made: a failed write leaves no copies behind. Returns the backup's
 * path (its name may have moved on to -2 ...), or null when none was made.
 */
export function writeInstruction(
  file: string,
  body: string | Buffer,
  backup: string | null,
  expectedHash: string | null | undefined,
): string | null {
  const tmp = `${file}.skills-sync.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, body);
  let made: string | null = null;
  try {
    if (backup && lexists(file)) {
      made = backupCopy(file, backup);
      if (expectedHash && toHash(fs.readFileSync(made)) !== expectedHash)
        throw new Error(`${file}: backup does not match the file as planned; left alone`);
    }
    fs.renameSync(tmp, file);
    return made;
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    if (made) fs.rmSync(made, { force: true });
    throw error;
  }
}

/**
 * Copy `file` to `backup`, or, when that name is taken (an earlier backup made in the same second), to the first free
 * `<name>-2<ext>`, `<name>-3<ext>` ...: a backup is never overwritten. Returns the path the copy went to. Throws when
 * it cannot be made, so the write that needed it does not happen.
 */
function backupCopy(file: string, backup: string): string {
  const ext = path.extname(backup);
  const stem = backup.slice(0, backup.length - ext.length);
  for (let n = 1; ; n++) {
    const to = n === 1 ? backup : `${stem}-${n}${ext}`;
    try {
      fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
      return to;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
