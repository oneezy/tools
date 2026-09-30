// Remembered answers, kept beside the lock file so the second run needs no prompts.
import fs from "node:fs";
import path from "node:path";

export interface Config {
  /** harness ids to sync */
  agents?: string[];
  /** link into the harnesses' user skills folders */
  global?: boolean;
  /** folder whose git repos are offered as projects */
  dev?: string;
  /** project folder names (relative to dev) to keep in sync */
  projects?: string[];
  /** how projects get their skills */
  mode?: "link" | "copy";
  /** WSL distro names to fan out to (Windows only) */
  wsl?: string[];
  /** lock entries the last restore could not find upstream; retried with --retry */
  unavailable?: string[];
}

export const CONFIG_NAME = "skills-sync.json";

export function readConfig(libraryRoot: string): Config {
  try {
    return JSON.parse(fs.readFileSync(path.join(libraryRoot, CONFIG_NAME), "utf8")) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(libraryRoot: string, cfg: Config): void {
  fs.writeFileSync(path.join(libraryRoot, CONFIG_NAME), JSON.stringify(cfg, null, 2) + "\n");
}
