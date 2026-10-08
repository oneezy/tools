// Every step builds a list of actions first; apply() executes them unless planning.
import fs from "node:fs";
import path from "node:path";
import {
  copyDir,
  isLink,
  lexists,
  linkTarget,
  makeLink,
  removeLink,
  samePath,
  under,
  hasLinkedParent,
  toHash,
  type LinkKind,
} from "./fs.js";

/**
 * remove drops a link; delete drops a real folder or file (only ever a generated one: a snapshot, a working-set copy or
 * a built package); move renames a file this tool wrote (path -> target). note says something about a path without
 * touching it (a package built without a LICENSE): printed, and neither a change nor a conflict.
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
  failed?: boolean;
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
    if (a.kind === "skip" || a.kind === "conflict" || a.kind === "note") continue;
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
          if (a.expectedHash !== undefined) {
            const current = !hasLinkedParent(a.path) && lexists(a.path) ? fs.readFileSync(a.path) : null;
            if (hasLinkedParent(a.path) || (current ? toHash(current) : null) !== a.expectedHash) {
              a.kind = "conflict";
              a.note = "instruction file changed since planning; left alone";
              break;
            }
          }
          fs.mkdirSync(path.dirname(a.path), { recursive: true });
          fs.writeFileSync(a.path, a.payload as string | Buffer, a.expectedHash === null ? { flag: "wx" } : undefined);
          if (a.expectedHash !== undefined && !fs.readFileSync(a.path).equals(Buffer.from(a.payload as string)))
            throw new Error(`${a.path}: instruction readback differs from the planned write`);
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

/** Make `link` point at `target`. Never destroys a real folder; only manages links into `managedRoot`. */
export function ensureLink(report: Report, link: string, target: string, managedRoot: string, what: string): void {
  if (!lexists(link)) {
    report.add({ kind: "link", path: link, target });
    return;
  }
  if (isLink(link)) {
    const current = linkTarget(link);
    if (current && samePath(current, target)) report.add({ kind: "skip", path: link, note: "ok" });
    else if (current && under(current, managedRoot))
      report.add({ kind: "relink", path: link, target, note: `was ${current}` });
    else
      report.add({
        kind: "conflict",
        path: link,
        note: `${what}: link points outside the skills library (${current}); left alone`,
      });
    return;
  }
  report.add({ kind: "conflict", path: link, note: `${what}: a real folder is in the way; left alone` });
}
