import fs from "node:fs";
import path from "node:path";
import type { FileSet } from "./vfs.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "worktrees"]);

/** Posix form of a local path ("C:\\x" -> "C:/x"), the shape FileSet paths take. */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Every file under the given folders as a FileSet with absolute posix paths, read lazily from disk.
 * Symlinks are followed; a file reached twice (through a symlink, or two overlapping roots) is kept once.
 */
export function readLocal(roots: string[], maxDepth = 8): FileSet {
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  const paths: string[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full); // follows symlinks
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
      else if (stat.isFile()) {
        let realFile = full;
        try {
          realFile = fs.realpathSync(full);
        } catch {
          /* keep the link path */
        }
        if (seenFiles.has(realFile)) continue;
        seenFiles.add(realFile);
        paths.push(toPosix(full));
      }
    }
  };
  for (const root of roots) walk(path.resolve(root), 0);

  const cache = new Map<string, string | undefined>();
  return {
    paths,
    read(p) {
      if (!cache.has(p)) {
        let text: string | undefined;
        try {
          text = fs.readFileSync(p, "utf8");
        } catch {
          text = undefined;
        }
        cache.set(p, text);
      }
      return cache.get(p);
    },
  };
}
