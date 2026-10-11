// skills-sync.local.json beside a library checkout's committed config skills-sync.json, gitignored. The library commands
// (update, refresh, add) keep one list in it: the selected skills an earlier run found gone upstream. The machine
// commands never read or write it (ADR-0012): the file an older version left beside the old clone is reported as a
// leftover and nothing more. Every field an older version wrote stays in the type and the shipped schema, so an old
// checkout's file still validates. Before 0.3.0 the answers were kept in skills-sync.json itself; such a file is read as
// the local file when there is no other.
import fs from "node:fs";
import path from "node:path";
import type { LinkMode } from "./fs.js";
import { shippedSchema, validate } from "./schema.js";

export type { LinkMode } from "./fs.js";

/** How a harness got the library's skills before ADR-0007: its plugins, or one loose link per skill. */
export type Form = "plugin" | "links";

/** What an older version installed on one harness (keyed by the harness's config folder): plugin ids, its marketplace. */
export interface Owned {
  harness: string;
  marketplace?: string;
  plugins: string[];
  /** built bytes last verified on that harness; cache identity, apart from the displayed semantic version */
  revisions?: Record<string, string>;
}

export interface Local {
  /** harness ids to sync (older versions) */
  agents?: string[];
  /** link into the harnesses' user skills folders (older versions) */
  global?: boolean;
  /** folder whose git repos were offered as projects (older versions) */
  dev?: string;
  /** project folder names (relative to dev) that got the skills (older versions) */
  projects?: string[];
  /** how projects got their skills (older versions) */
  mode?: "link" | "copy";
  /** WSL distro names fanned out to (older versions; the distros are detected on every run now) */
  wsl?: string[];
  /** selected skills the last refresh or restore could not find upstream; retried with --retry */
  unavailable?: string[];
  /** how links are made: a symlink with a junction fallback (auto), or one kind only */
  links?: LinkMode;
  /** the user folders' form on harnesses with plugins, when --plugins or --links chose one (older versions) */
  form?: Form;
  /** what an older version installed through each harness's plugin commands, keyed by the harness's config folder */
  plugins?: Record<string, Owned>;
}

export const CONFIG_NAME = "skills-sync.json";
export const LOCAL_NAME = "skills-sync.local.json";

/** Every key a 0.2.0 answers file could hold, plus links. A skills-sync.json made only of these is a legacy answers file. */
const ANSWER_KEYS = new Set(["agents", "global", "dev", "projects", "mode", "wsl", "unavailable", "links"]);

/**
 * What skills-sync.json is: the committed config (it has version, sources or plugins, or anything that is not an
 * answer), a legacy answers file written by 0.2.0 (answer keys only), or nothing when the file is absent.
 */
export function configKind(libraryRoot: string): "config" | "answers" | "none" {
  const file = path.join(libraryRoot, CONFIG_NAME);
  if (!fs.existsSync(file)) return "none";
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return "config"; // its reader says what is wrong with it
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "config";
  const keys = Object.keys(parsed);
  if (keys.some((k) => k === "version" || k === "sources" || k === "plugins")) return "config";
  return keys.length && keys.every((k) => ANSWER_KEYS.has(k)) ? "answers" : "config";
}

/** The local file, validated; the legacy answers when there is no local file; else nothing. */
export function readLocal(libraryRoot: string): Local {
  const file = path.join(libraryRoot, LOCAL_NAME);
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`${file}: not JSON (${String(e)})`);
    }
    const errors = validate(shippedSchema("skills-sync.local"), parsed);
    if (errors.length) throw new Error(`${file} is not a valid answers file:\n  ${errors.join("\n  ")}`);
    return parsed as Local;
  }
  if (configKind(libraryRoot) === "answers")
    return JSON.parse(fs.readFileSync(path.join(libraryRoot, CONFIG_NAME), "utf8")) as Local;
  return {};
}

export function writeLocal(libraryRoot: string, local: Local): void {
  fs.writeFileSync(path.join(libraryRoot, LOCAL_NAME), JSON.stringify(local, null, 2) + "\n");
}
