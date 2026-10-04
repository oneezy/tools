import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
