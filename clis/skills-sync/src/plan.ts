// Every step builds a list of actions first; apply() executes them unless planning.
import fs from "node:fs";
import path from "node:path";
import { copyDir, isLink, lexists, linkTarget, makeLink, removeLink, samePath, under } from "./fs.js";

export type Kind = "link" | "relink" | "remove" | "replace-copy" | "copy" | "write" | "exclude" | "skip" | "conflict";

export interface Action {
  kind: Kind;
  path: string;
  target?: string;
  note?: string;
  /** for write: the file body; for exclude: the entries */
  payload?: string | string[];
}

export class Report {
  actions: Action[] = [];
  add(a: Action): Action {
    this.actions.push(a);
    return a;
  }
  changes(): Action[] {
    return this.actions.filter((a) => a.kind !== "skip" && a.kind !== "conflict");
  }
  conflicts(): Action[] {
    return this.actions.filter((a) => a.kind === "conflict");
  }
  skips(): number {
    return this.actions.filter((a) => a.kind === "skip").length;
  }
  merge(other: Report): void {
    this.actions.push(...other.actions);
  }
}

const MARK: Record<Kind, string> = { link: "+", relink: "~", remove: "-", "replace-copy": "~", copy: "+", write: "+", exclude: "+", skip: "=", conflict: "!" };

export function line(a: Action): string {
  const tail = a.target ? ` -> ${a.target}` : "";
  const note = a.note ? `  (${a.note})` : "";
  return `${MARK[a.kind]} ${a.kind.padEnd(12)} ${a.path}${tail}${note}`;
}

export function apply(report: Report, plan: boolean, exclude?: (repo: string, entries: string[]) => boolean): void {
  if (plan) return;
  for (const a of report.actions) {
    switch (a.kind) {
      case "link":
        makeLink(a.target!, a.path);
        break;
      case "relink":
        removeLink(a.path);
        makeLink(a.target!, a.path);
        break;
      case "remove":
        removeLink(a.path);
        break;
      case "replace-copy":
        fs.rmSync(a.path, { recursive: true, force: true });
        makeLink(a.target!, a.path);
        break;
      case "copy":
        copyDir(a.target!, a.path);
        break;
      case "write":
        fs.mkdirSync(path.dirname(a.path), { recursive: true });
        fs.writeFileSync(a.path, a.payload as string);
        break;
      case "exclude":
        exclude?.(a.path, a.payload as string[]);
        break;
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
    else if (current && under(current, managedRoot)) report.add({ kind: "relink", path: link, target, note: `was ${current}` });
    else report.add({ kind: "conflict", path: link, note: `${what}: link points outside the skills library (${current}); left alone` });
    return;
  }
  report.add({ kind: "conflict", path: link, note: `${what}: a real folder is in the way; left alone` });
}
