// Link primitives: directory symlinks everywhere, with a junction on Windows when a symlink is refused or asked for.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** auto: a directory symlink, a junction when Windows refuses it; symlink or junction: that kind only. */
export type LinkMode = "auto" | "symlink" | "junction";
export type LinkKind = "symlink" | "junction";

let mode: LinkMode = "auto";

/** The remembered or forced link mode for this run; read by every makeLink. */
export function setLinkMode(m: LinkMode): void {
  mode = m;
}

export function linkMode(): LinkMode {
  return mode;
}

/** The call that makes a link. Tests replace it to make Windows refuse a symlink. */
export const linkDeps = {
  symlink: (target: string, link: string, type: "dir" | "junction"): void => fs.symlinkSync(target, link, type),
};

export function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A directory symlink, or a junction on Windows. */
export function isLink(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return true;
    // junctions report as directories with a reparse point; readlink resolves them
    if (process.platform === "win32" && st.isDirectory()) {
      try {
        fs.readlinkSync(p);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function linkTarget(p: string): string | null {
  try {
    let raw = fs.readlinkSync(p);
    if (raw.startsWith("\\\\?\\")) raw = raw.slice(4);
    return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(p), raw);
  } catch {
    return null;
  }
}

export function norm(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b);
}

export function under(p: string, root: string): boolean {
  const a = norm(p);
  const r = norm(root);
  return a === r || a.startsWith(r + path.sep);
}

export function real(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Make `link` point at the folder `target`: a directory symlink first; on Windows, a junction when the symlink is
 * refused with EPERM (no Developer Mode, not elevated) or when the mode asks for one. POSIX has only symlinks.
 * Returns the kind made, so the run can say which.
 */
export function makeLink(target: string, link: string): LinkKind {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (process.platform !== "win32") {
    linkDeps.symlink(target, link, "dir");
    return "symlink";
  }
  if (mode !== "junction") {
    try {
      linkDeps.symlink(target, link, "dir");
      return "symlink";
    } catch (e) {
      if (mode === "symlink" || (e as NodeJS.ErrnoException).code !== "EPERM") throw e;
    }
  }
  linkDeps.symlink(target, link, "junction");
  return "junction";
}

export function removeLink(link: string): void {
  try {
    fs.rmdirSync(link); // junctions and directory symlinks on Windows
  } catch {
    fs.unlinkSync(link);
  }
}

export function isSkillDir(p: string): boolean {
  try {
    return fs.statSync(path.join(p, "SKILL.md")).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The skill folder names under <dir>/skills (a folder with a SKILL.md), sorted; none when there is no skills folder. */
export function skillsIn(dir: string): string[] {
  const skills = path.join(dir, "skills");
  if (!isDir(skills)) return [];
  return fs
    .readdirSync(skills)
    .filter((n) => isSkillDir(path.join(skills, n)))
    .sort();
}

export function copyDir(src: string, dst: string): void {
  if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, dereference: true });
}

export function toHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hasLinkedParent(file: string): boolean {
  const dir = path.resolve(file);
  return isLink(dir) || (path.dirname(dir) !== dir && hasLinkedParent(path.dirname(dir)));
}
