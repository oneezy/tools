// This machine's answers (harnesses, projects, WSL distros, unavailable skills, link mode) live in
// skills-sync.local.json, gitignored, so the committed config skills-sync.json is the same on every machine.
// Before 0.3.0 the answers were kept in skills-sync.json itself; such a file is moved to the local file once.
import fs from "node:fs";
import path from "node:path";
import type { LinkMode } from "./fs.js";
import type { Report } from "./plan.js";
import { shippedSchema, validate } from "./schema.js";

export type { LinkMode } from "./fs.js";

export interface Local {
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
  /** selected skills the last refresh or restore could not find upstream; retried with --retry */
  unavailable?: string[];
  /** how links are made: a symlink with a junction fallback (auto), or one kind only */
  links?: LinkMode;
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

/** The local file, validated; the legacy answers when it has not been moved yet (a --plan run); else nothing. */
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

/** A legacy answers file becomes the local file: one move, reported once; never when the local file already exists. */
export function migrateAnswers(libraryRoot: string, report: Report): void {
  if (configKind(libraryRoot) !== "answers") return;
  const from = path.join(libraryRoot, CONFIG_NAME);
  const to = path.join(libraryRoot, LOCAL_NAME);
  if (fs.existsSync(to)) {
    report.add({
      kind: "conflict",
      path: from,
      note: `holds this machine's answers from an older version, but ${LOCAL_NAME} already exists; delete it, or make it the committed config`,
    });
    return;
  }
  report.add({ kind: "move", path: from, target: to, note: "per-machine answers now live in the local file" });
}
