// Watching the Library's source: one recursive watch on the Library root, events outside the source folders dropped by
// path, a quiet period (debounce) before anything runs, and digests of the source that tell an edit apart from a save
// that changed nothing. Two watchers use it: `develop --watch`, which keeps the loose-skill links in step, and the
// Development watcher (develop-watcher.ts), which rebuilds the Development builds.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cmp } from "./sources.js";

/**
 * Folders at the Library root that are never source: git, tooling, and generated output (dist/ holds the Development
 * builds). Only the root's: inside a skill, a dist/ or node_modules/ is packaged like any other file, so it is source.
 */
const ignored = new Set([".git", "node_modules", "dist", "__pycache__"]);
const skipped = (root: string, dir: string, name: string) =>
  ignored.has(name) && path.resolve(dir) === path.resolve(root);

export function developmentSnapshot(root: string) {
  const content = createHash("sha256");
  const structure: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipped(root, dir, entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file).replaceAll("\\", "/");
        content.update(relative).update("\0").update(fs.readFileSync(file)).update("\0");
        if (entry.name === "SKILL.md") structure.push(relative);
      }
    }
  };
  walk(path.join(root, "skills"));
  walk(path.join(root, ".agents", "skills"));
  const config = createHash("sha256");
  for (const name of ["skills-sync.json", "skills-sync.lock.json"]) {
    const file = path.join(root, name);
    config.update(name).update(fs.existsSync(file) ? fs.readFileSync(file) : "missing");
  }
  return { content: content.digest("hex"), structure: JSON.stringify(structure), config: config.digest("hex") };
}

/**
 * Watch `root` recursively and call `settled` once events stop for `delay` ms. An event whose path (relative, /
 * separators) `accept` turns down never starts the wait; one without a path (the platform did not say) always does.
 * Returns the function that stops watching.
 */
export function watchSource(
  root: string,
  accept: (name: string) => boolean,
  settled: () => void,
  error: (error: unknown) => void,
  delay = 200,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    const name = filename?.toString().replaceAll("\\", "/");
    if (name && !accept(name)) return;
    clearTimeout(timer);
    timer = setTimeout(settled, delay);
  });
  watcher.on("error", error);
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

export function watchDevelopment(
  root: string,
  callbacks: {
    restore: () => void;
    reconcile: () => void;
    log: (message: string) => void;
    error: (error: unknown) => void;
  },
  delay = 200,
): () => void {
  let previous = developmentSnapshot(root);
  return watchSource(
    root,
    (name) => /^(skills(?:\/|$)|\.agents\/skills(?:\/|$)|skills-sync(?:\.lock)?\.json$)/.test(name),
    () => {
      try {
        const next = developmentSnapshot(root);
        if (next.config !== previous.config) {
          callbacks.restore();
          callbacks.reconcile();
          callbacks.log("Configuration changed; dependencies restored and local links checked.");
        } else if (next.structure !== previous.structure) {
          callbacks.reconcile();
          callbacks.log("Skill folders changed; local links updated.");
        } else if (next.content !== previous.content) {
          callbacks.log("Skill content changed; live links already reflect the save. No build needed.");
        }
        previous = developmentSnapshot(root);
      } catch (error) {
        callbacks.error(error);
      }
    },
    callbacks.error,
    delay,
  );
}

/**
 * What a Development build reads, relative to the Library root: own skills, the third-party working set, the upstream
 * snapshots, the config and its lock, and the LICENSE. Everything else (plugins/, artifacts/, the catalogs, dist/) is
 * generated or never packaged, and an event there is not an edit.
 */
export function isBuildInput(name: string): boolean {
  return (
    /^(?:skills|\.agents\/skills|upstream)(?:\/|$)/.test(name) ||
    /^(?:skills-sync(?:\.lock)?\.json|LICENSE(?:\.md|\.txt)?)$/.test(name)
  );
}

/**
 * The digest of everything a Development build reads, so a save that left every byte as it was does no work. A file is
 * read again only when its size, times or inode changed since the last digest.
 */
export class BuildInputs {
  private seen = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; hash: string }>();

  constructor(private root: string) {}

  digest(): string {
    const total = createHash("sha256");
    const next = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; hash: string }>();
    const add = (file: string) => {
      const rel = path.relative(this.root, file).replaceAll("\\", "/");
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return; // removed while being read: the next event says so
      }
      const was = this.seen.get(rel);
      const hash =
        was && was.size === st.size && was.mtimeMs === st.mtimeMs && was.ctimeMs === st.ctimeMs && was.ino === st.ino
          ? was.hash
          : createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      next.set(rel, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, hash });
      total.update(rel).update("\0").update(hash).update("\0");
    };
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => cmp(a.name, b.name))) {
        if (skipped(this.root, dir, entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) add(file);
      }
    };
    for (const dir of ["skills", ".agents/skills", "upstream"]) walk(path.join(this.root, ...dir.split("/")));
    for (const name of ["skills-sync.json", "skills-sync.lock.json", "LICENSE", "LICENSE.md", "LICENSE.txt"])
      add(path.join(this.root, name));
    this.seen = next;
    return total.digest("hex");
  }
}
