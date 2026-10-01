// check: what is committed is consistent. Every own skill's frontmatter, every flow.yaml beside an own SKILL.md, and
// generated-file drift. It reads the library and nothing else: no network, no write, no harness folder. One problem per
// line, each with the file it is in and the rule it breaks.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { asBuilt, build } from "./build.js";
import { firstLine, flowProblems } from "./flow.js";
import { Library } from "./library.js";
import { snapshotLock } from "./refresh.js";
import { shippedSchema, validate } from "./schema.js";
import { lockText } from "./sources.js";

/** One thing that is wrong: the file (relative to the library, / separators) and why. */
export interface Problem {
  path: string;
  reason: string;
}

export interface CheckResult {
  problems: Problem[];
  /** own skills whose frontmatter was read */
  skills: number;
  /** flow.yaml files validated */
  flows: number;
  /** generated files found as built: the plugin form's, and the lock when a snapshot says what it should be */
  generated: number;
  /** per kind of generated file found drifted, the command that writes it; for the summary line */
  fixes: string[];
}

/** A skill id by the Agent Skills rule: lowercase letters, digits and single hyphens. */
const SKILL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL_ID_MAX = 64;

export function check(lib: Library): CheckResult {
  const result: CheckResult = { problems: [], skills: 0, flows: 0, generated: 0, fixes: [] };
  const rel = (p: string) => path.relative(lib.root, p).split("\\").join("/");
  const problem = (file: string, reason: string) => result.problems.push({ path: rel(file), reason });
  for (const s of lib.scanOwn().skills) {
    const md = path.join(s.dir, "SKILL.md");
    result.skills++;
    for (const reason of frontmatterProblems(fs.readFileSync(md, "utf8"), s.name)) problem(md, reason);
    const flow = path.join(s.dir, "flow.yaml");
    if (!fs.existsSync(flow)) continue;
    result.flows++;
    for (const reason of flowProblems(fs.readFileSync(flow, "utf8"), s.name)) problem(flow, reason);
  }
  // generated files come from the config: a library without one (a lock alone) has none to check
  if (!lib.hasConfig() || !validConfig(lib, problem)) return result;
  pluginDrift(lib, result, problem);
  lockDrift(lib, result, problem);
  return result;
}

type AddProblem = (file: string, reason: string) => void;

/** The config against its schema, one problem per rule broken; false when it is not valid, so nothing is computed from it. */
function validConfig(lib: Library, problem: AddProblem): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(lib.configFile, "utf8"));
  } catch (e) {
    problem(lib.configFile, `not JSON (${firstLine(e)})`);
    return false;
  }
  const errors = validate(shippedSchema("skills-sync"), parsed);
  for (const reason of errors) problem(lib.configFile, reason);
  return !errors.length;
}

/**
 * The plugin form, by the computation of build --check: every file build would write or remove is a problem, and so
 * is a package it cannot build. Nothing is looked at when generate.plugins is off, and artifacts/ never is.
 */
function pluginDrift(lib: Library, result: CheckResult, problem: AddProblem): void {
  const r = build(lib, { plugins: true, catalogs: true, artifacts: false, check: true, plan: false, log: () => undefined });
  const before = result.problems.length;
  for (const a of r.report.actions) {
    if (a.kind === "write") problem(a.path, a.note === "missing" ? "missing; build would write it" : "differs from what build would write");
    else if (a.kind === "delete") problem(a.path, `${a.note}; build would remove it`);
    else if (a.kind === "conflict") problem(a.path, a.note ?? "cannot be built");
  }
  result.generated += r.report.skips();
  if (result.problems.length > before) result.fixes.push("build --plugins --catalogs writes the plugin form");
}

/**
 * The lock against the one a refresh would write from the snapshots as they are: an entry edited by hand, one no
 * source selects, a snapshot changed after the refresh. Without a snapshot there is nothing to compare with, so a
 * clone before its first refresh passes.
 */
function lockDrift(lib: Library, result: CheckResult, problem: AddProblem): void {
  const expected = snapshotLock(lib);
  if (!expected) return;
  const have = fs.existsSync(lib.lockFile) ? fs.readFileSync(lib.lockFile) : null;
  if (have && asBuilt(have, Buffer.from(lockText(expected), "utf8"))) {
    result.generated++;
    return;
  }
  const disk = lib.lockEntries();
  const names = [...new Set([...Object.keys(expected), ...Object.keys(disk)])].filter((n) => JSON.stringify(expected[n]) !== JSON.stringify(disk[n])).sort();
  const which = names.length ? ` (${names.join(", ")})` : "";
  problem(lib.lockFile, have ? `differs from what refresh would write from the snapshots under upstream/${which}` : `missing; refresh would write it from the snapshots under upstream/${which}`);
  result.fixes.push(`refresh writes ${path.basename(lib.lockFile)}`);
}

/**
 * What is wrong with a SKILL.md's frontmatter, for a skill in the folder `folder`: `name` must be the folder's name
 * (a skill is known everywhere by its folder) and a valid skill id; `description` must say something.
 */
export function frontmatterProblems(md: string, folder: string): string[] {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return ["no frontmatter: name and description are required"];
  let fm: unknown;
  try {
    fm = YAML.parse(m[1]);
  } catch (e) {
    // the position YAML gives counts from the frontmatter's first line, not the file's, so it is left out
    return [`frontmatter is not YAML (${firstLine(e).replace(/ at line \d+, column \d+$/, "")})`];
  }
  if (typeof fm !== "object" || fm === null || Array.isArray(fm)) return ["frontmatter is not a map: name and description are required"];
  const { name, description } = fm as Record<string, unknown>;
  const out: string[] = [];
  if (name === undefined || name === null) out.push("name: missing");
  else if (typeof name !== "string") out.push("name: must be a string");
  else {
    if (name !== folder) out.push(`name: ${name} is not the folder's name, ${folder}`);
    if (!SKILL_ID.test(name) || name.length > SKILL_ID_MAX) out.push(`name: ${name} is not a valid skill id (lowercase letters, digits and single hyphens, at most ${SKILL_ID_MAX} characters)`);
  }
  if (description === undefined || description === null || description === "") out.push("description: missing");
  else if (typeof description !== "string") out.push("description: must be a string");
  return out;
}
