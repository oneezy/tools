// A read-only file set the analyzer works on. Local folders, GitHub trees and GitHub tarballs all
// produce one, so the parser never touches node:fs and runs in a browser too.

export interface FileSet {
  /** every file path in the set, posix separators, no trailing slash */
  paths: string[];
  /** file contents as UTF-8 text, or undefined when the source did not load it */
  read(path: string): string | undefined;
}

export function memoryFileSet(files: Map<string, string> | Record<string, string>, extraPaths: string[] = []): FileSet {
  const map = files instanceof Map ? files : new Map(Object.entries(files));
  const paths = [...new Set([...map.keys(), ...extraPaths])].sort();
  return { paths, read: (p) => map.get(p) };
}

/** Only the files under `prefix` (a directory path; "" keeps everything). */
export function scopeFileSet(fs: FileSet, prefix: string): FileSet {
  const p = trimSlashes(prefix);
  if (!p) return fs;
  return { paths: fs.paths.filter((x) => x === p || x.startsWith(p + "/")), read: fs.read };
}

/* posix path helpers, enough for repo-relative and absolute paths */

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((x) => x !== "").join("/"));
}

/** Collapse "." and ".." segments and duplicate slashes; keeps a leading "/" or drive letter. */
export function normalize(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** `child` relative to `parent`, or null when it is not inside it. */
export function relativeTo(parent: string, child: string): string | null {
  if (parent === "" || parent === ".") return child;
  if (child === parent) return "";
  return child.startsWith(parent + "/") ? child.slice(parent.length + 1) : null;
}

export function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}
