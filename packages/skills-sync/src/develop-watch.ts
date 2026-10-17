import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ignored = new Set([".git", "node_modules", "dist", "__pycache__"]);

export function developmentSnapshot(root: string) {
  const content = createHash("sha256");
  const structure: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
    const name = filename?.toString().replaceAll("\\", "/");
    if (name && !/^(skills(?:\/|$)|\.agents\/skills(?:\/|$)|skills-sync(?:\.lock)?\.json$)/.test(name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
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
    }, delay);
  });
  watcher.on("error", callbacks.error);
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}
