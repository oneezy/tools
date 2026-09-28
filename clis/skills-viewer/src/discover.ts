import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "worktrees"]);

/** Default places a harness looks for skills, relative to cwd and home. */
export function defaultRoots(cwd = process.cwd()): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
    ...pluginSkillDirs(cwd),
  ];
  return candidates.filter((p) => isDir(p));
}

/** A folder holding .claude-plugin/plugin.json keeps its skills in ./skills unless the manifest says otherwise. */
function pluginSkillDirs(cwd: string): string[] {
  const manifest = path.join(cwd, ".claude-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(manifest, "utf8")) as { skills?: string | string[] };
    const declared = json.skills ? (Array.isArray(json.skills) ? json.skills : [json.skills]) : ["./skills"];
    return declared.map((d) => path.resolve(cwd, d));
  } catch {
    return [path.join(cwd, "skills")];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Find every SKILL.md under the given roots, following symlinks, de-duplicated by real path. */
export function findSkillFiles(roots: string[], maxDepth = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (file: string) => {
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      /* keep the symlink path */
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(file);
  };

  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name === "SKILL.md" && (e.isFile() || e.isSymbolicLink())) {
        push(full);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full); // follows symlinks
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full, depth + 1);
    }
  };

  for (const root of roots) {
    const abs = path.resolve(root);
    if (!isDir(abs)) continue;
    const direct = path.join(abs, "SKILL.md");
    if (fs.existsSync(direct)) {
      push(direct);
      continue;
    }
    walk(abs, 0);
  }
  return out;
}
