// check: what is committed is consistent. Every own skill's frontmatter, every flow.yaml beside an own SKILL.md, and
// generated-file drift. It reads the library and nothing else: no network, no write, no harness folder. One problem per
// line, each with the file it is in and the rule it breaks.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { asBuilt, build } from "./build.js";
import { firstLine, flowProblems } from "./flow.js";
import { Library } from "./library.js";
import { hasOldLock, LOCK_NAME, lockedSource, lockText, readLockFile, type LockedSource } from "./lock.js";
import { snapshotLock } from "./refresh.js";
import { shippedSchema, validate } from "./schema.js";
import { cmp, readConfig } from "./sources.js";

/** One thing that is wrong: the file (relative to the library, / separators) and why. */
export interface Problem {
  path: string;
  reason: string;
}

export interface CheckResult {
  problems: Problem[];
  /** what was passed over and why, never a failure: a declared group with no skill yet */
  notes: Problem[];
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
/** The playground group: every skill in skills/play/ is named play-<name>, so it never clashes with a source's skill. */
const PLAY = "play";

export function check(lib: Library): CheckResult {
  const result: CheckResult = { problems: [], notes: [], skills: 0, flows: 0, generated: 0, fixes: [] };
  const problem = (file: string, reason: string) => result.problems.push({ path: rel(lib, file), reason });
  for (const s of lib.scanOwn().skills) {
    const md = path.join(s.dir, "SKILL.md");
    result.skills++;
    if (s.plugin === PLAY && !s.name.startsWith(`${PLAY}-`)) problem(s.dir, `a skill in the ${PLAY} group is named ${PLAY}-<name>; rename the folder (and its frontmatter name) to ${PLAY}-${s.name}`);
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
  heldVersions(lib, result, problem);
  return result;
}

type AddProblem = (file: string, reason: string) => void;

/** A path as problems give it: relative to the library, / separators. */
function rel(lib: Library, p: string): string {
  return path.relative(lib.root, p).split("\\").join("/");
}

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
  const skipped = new Set(r.skipped.map((id) => path.join(lib.plugins, id)));
  for (const a of r.report.actions) {
    if (a.kind === "note" && skipped.has(a.path)) result.notes.push({ path: rel(lib, a.path), reason: a.note! });
    else if (a.kind === "write") problem(a.path, a.note === "missing" ? "missing; build would write it" : "differs from what build would write");
    else if (a.kind === "delete") problem(a.path, `${a.note}; build would remove it`);
    else if (a.kind === "conflict") problem(a.path, a.note ?? "cannot be built");
  }
  result.generated += r.report.skips();
  if (result.problems.length > before) result.fixes.push("build --plugins --catalogs writes the plugin form");
}

/**
 * The lock against the one a refresh would write from the snapshots as they are: an entry edited by hand, one no
 * source selects, a snapshot changed after the refresh. Without a snapshot there is nothing to compare with, so a
 * clone before its first refresh passes. A version 1 lock is one problem, and alone it is the only one: refresh
 * migrates it.
 */
function lockDrift(lib: Library, result: CheckResult, problem: AddProblem): void {
  const old = hasOldLock(lib.root);
  if (old) {
    problem(lib.npxLockFile, `old lock format; refresh migrates it to ${LOCK_NAME}`);
    result.fixes.push(`refresh migrates ${path.basename(lib.npxLockFile)}`);
    if (!fs.existsSync(lib.lockFile)) return;
  }
  const expected = snapshotLock(lib);
  if (!expected) return;
  const have = fs.existsSync(lib.lockFile) ? fs.readFileSync(lib.lockFile) : null;
  if (have && asBuilt(have, Buffer.from(lockText(expected), "utf8"))) {
    result.generated++;
    return;
  }
  const names = lockDiff(expected, readLockFile(lib.root)?.sources ?? {});
  const which = names.length ? ` (${names.join(", ")})` : "";
  problem(lib.lockFile, have ? `differs from what refresh would write from the snapshots under upstream/${which}` : `missing; refresh would write it from the snapshots under upstream/${which}`);
  result.fixes.push(`refresh writes ${path.basename(lib.lockFile)}`);
}

/**
 * Every source the config holds at a version the lock does not have it at: the hold was landed and the update that
 * takes the source there was not run. A source the lock does not record (or records for another repo) is not compared.
 */
function heldVersions(lib: Library, result: CheckResult, problem: AddProblem): void {
  const sources = readConfig(lib.configFile).sources;
  const lock = readLockFile(lib.root);
  const off: string[] = [];
  for (const id of Object.keys(sources).sort(cmp)) {
    const held = sources[id].version;
    const locked = lockedSource(lock, id, sources[id]);
    if (!held || !locked || locked.version === held) continue;
    problem(lib.configFile, `sources.${id}.version holds ${held} but the lock has ${locked.version ?? "no version"}; run update ${id}`);
    off.push(id);
  }
  if (off.length) result.fixes.push(`update ${off.join(" ")} takes ${off.length === 1 ? "it" : "them"} to the held version`);
}

/** What differs between two locks: a source id where the source itself does (its version, commit, or the whole of it), source:name per skill. */
function lockDiff(a: Record<string, LockedSource>, b: Record<string, LockedSource>): string[] {
  const out: string[] = [];
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(cmp)) {
    const [x, y] = [a[id], b[id]];
    const scalars = (s?: LockedSource) => (s ? JSON.stringify([s.repo, s.ref, s.version, s.commit, s.date]) : null);
    if (!x || !y || scalars(x) !== scalars(y)) out.push(id);
    if (!x || !y) continue;
    const skill = (s: LockedSource, n: string) => (s.skills?.[n] ? JSON.stringify([s.skills[n].path, s.skills[n].hash, s.skills[n].commit === s.commit ? undefined : s.skills[n].commit]) : null);
    for (const n of [...new Set([...Object.keys(x.skills ?? {}), ...Object.keys(y.skills ?? {})])].sort(cmp)) if (skill(x, n) !== skill(y, n)) out.push(`${id}:${n}`);
  }
  return out;
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
