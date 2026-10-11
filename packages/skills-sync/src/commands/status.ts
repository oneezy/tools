// status: the one answer to "is this machine done" (spec stories 50 to 56). Per harness, lines a user reads and a
// --json object /oneezy-status reads with the same facts: its form, each library plugin against the latest release,
// every skill name listed twice, the session hook entry in its user hooks file, the managed block in its global
// instructions file, and any block an older skills-sync left in a repository. Then, once per machine, the checkouts of
// oneezy/skills and oneezy/tools in reach (the repository the current folder is in and the folders beside it, as the
// hook finds them): on dev and clean, or not. Last the manual steps only a person can take, step by step. A red line
// (`!`) is something the machine has wrong; the exit code is 1 when there is one. A manual step is the person's, not the
// machine's: it never hides a red line (red lines print first) and alone leaves the exit code 0. Nothing is written, no
// library is looked for, every git call is read-only. In a cloud session the account plugins arrive on their own and
// no hook or checkout exists, so status shows the block lines and the manual steps only, and reads no release: a
// session there must not go red over a GitHub it cannot reach.
import { spawnSync } from "node:child_process";
import { FORM_LABEL, formOf, type MachineForm } from "../desired.js";
import { github } from "../github.js";
import { harnessTable } from "../harnesses.js";
import {
  LIBRARY_MARKETPLACE,
  probe,
  type HarnessState,
  type LooseLink,
  type Machine,
  type SkillFolder,
} from "../machine.js";
import { latestRelease, type Release, type ReleasePlugin } from "../release.js";
import { findCheckouts } from "./hook.js";
import { manualSteps, type ManualStep } from "./status-steps.js";

export type { ManualStep } from "./status-steps.js";

export interface StatusLine {
  ok: boolean;
  /** "=" a green comparison, "!" a red line, "." a note */
  mark: "=" | "!" | ".";
  text: string;
}

export interface StatusPlugin {
  id: string;
  version: string | null;
  /** the release's version of this plugin; null when the release has no such plugin or was not read */
  latest: string | null;
  /** version and skill set both match the release; with the skills not read, the version alone */
  current: boolean;
  /** null when the harness could not say which skills the plugin loads */
  skills: string[] | null;
  path: string | null;
  /** switched off: listed, never judged, its skills no place for a duplicate */
  enabled: boolean;
}

export interface StatusInstalled extends StatusPlugin {
  marketplace: string;
}

/** A plugin that is not the library's: an account plugin from another marketplace, or a CLI install from elsewhere. */
export interface StatusOther {
  id: string;
  marketplace: string | null;
  scope: "synced" | "installed";
  version: string | null;
  skills: string[] | null;
}

/** The session hook entry in the harness's user hooks file (ADR-0010). */
export interface StatusHook {
  file: string;
  /** the tool's own entry is in the file */
  present: boolean;
  /** present, the old sync-dev.sh entry gone, the file readable */
  current: boolean;
  /** Codex: trusted in its TUI; null on Claude Code, and on Codex when the file cannot be read */
  trusted: boolean | null;
}

/** The managed block in the harness's global instructions file (ADR-0011). */
export interface StatusBlock {
  file: string;
  /** a managed block of any id is in the file */
  present: boolean;
  /** the block is byte for byte what sync would write */
  current: boolean;
  status: "current" | "missing" | "outdated" | "conflict";
  /** the ids of the managed blocks the file holds (the old tool wrote `brain`) */
  ids: string[];
}

export interface StatusHarness {
  name: string;
  form: MachineForm;
  cli: string | null;
  note?: string;
  plugins: { synced: StatusPlugin[]; installed: StatusInstalled[]; other: StatusOther[] };
  loose: LooseLink[];
  folders: SkillFolder[];
  duplicates: Array<{ skill: string; in: string[] }>;
  /** null for a harness whose table row names no hooks file (Hermes) */
  hook: StatusHook | null;
  /** null for a harness whose table row names no global instructions file (Hermes) */
  block: StatusBlock | null;
  /** blocks an older skills-sync left outside the global file: each a red line until removed by hand */
  repoBlocks: Array<{ file: string; ids: string[] }>;
  lines: StatusLine[];
}

/** A checkout of oneezy/skills or oneezy/tools in reach of the current folder (story 53). */
export interface StatusCheckout {
  path: string;
  /** owner/name, as the origin URL says */
  repo: string;
  branch: string;
  /** `git status --porcelain` lines, untracked files included */
  dirty: number;
  clean: boolean;
  /** on dev and clean */
  ok: boolean;
}

export interface StatusReport {
  /** the latest release read; `tool` is the skills-sync version it was built with, when the release says */
  release: { repo: string; tag: string; number: number; commit: string; tool: string | null } | null;
  /** why the release could not be read, when it could not */
  error?: string;
  cloud: boolean;
  harnesses: Record<string, StatusHarness>;
  /** lines about the machine as a whole: the release line */
  lines: StatusLine[];
  /** empty in the cloud, and when no checkout is in reach */
  checkouts: StatusCheckout[];
  manualSteps: ManualStep[];
  /** how many red lines, checkouts included */
  red: number;
  ok: boolean;
}

export interface StatusOptions {
  /** the release repo, owner/repo */
  repo: string;
  json: boolean;
  quiet: boolean;
  env?: NodeJS.ProcessEnv;
  /** where the run happens: its repository and the folders beside it are looked at for checkouts */
  cwd?: string;
  write?: (text: string) => void;
}

/** Read the release, probe the machine, print the report. Returns the exit code: 0 all green, 1 something red. */
export async function runStatus(options: StatusOptions): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const machine = probe(harnessTable(undefined, env), env, cwd);
  let release: Release | null = null;
  let error: string | null = null;
  // in the cloud nothing is judged against the release (no plugin line, no step about one): it is not read
  if (!machine.cloud)
    try {
      release = await latestRelease(github(env), options.repo);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  const checkouts = machine.cloud ? [] : readCheckouts(cwd, env);
  const report = statusReport(options.repo, release, error, machine, checkouts);
  write(options.json ? JSON.stringify(report, null, 2) + "\n" : statusText(report, options.quiet));
  return report.ok ? 0 : 1;
}

const green = (text: string): StatusLine => ({ ok: true, mark: "=", text });
const red = (text: string): StatusLine => ({ ok: false, mark: "!", text });
const note = (text: string): StatusLine => ({ ok: true, mark: ".", text });

/** The report from a release (or why there is none), the probe and the checkouts. Pure: what the tests compare, what --json prints. */
export function statusReport(
  repo: string,
  release: Release | null,
  error: string | null,
  machine: Machine,
  checkouts: StatusCheckout[] = [],
): StatusReport {
  const lines: StatusLine[] = [];
  // the cloud reads no release: the line would be red over a GitHub a session start cannot reach
  if (!machine.cloud)
    lines.push(
      release
        ? green(`latest: ${release.repo} ${release.tag} (${release.commit.slice(0, 7)})`)
        : red(`latest release of ${repo}: ${error ?? "not read"}`),
    );
  const harnesses: Record<string, StatusHarness> = {};
  for (const state of machine.harnesses) {
    const form = formOf(state.harness.id);
    if (form) harnesses[state.harness.id] = harnessReport(state, form, release, machine.cloud);
  }
  const all = [...lines, ...Object.values(harnesses).flatMap((h) => h.lines)];
  const redCount = all.filter((l) => !l.ok).length + checkouts.filter((c) => !c.ok).length;
  return {
    release: release
      ? { repo: release.repo, tag: release.tag, number: release.number, commit: release.commit, tool: release.tool }
      : null,
    ...(error ? { error } : {}),
    cloud: machine.cloud,
    harnesses,
    lines,
    checkouts,
    manualSteps: manualSteps(machine, release),
    red: redCount,
    ok: redCount === 0,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

function compare(
  p: { id: string; version: string | null; skills: string[] | null; path: string | null; enabled: boolean },
  latest: ReleasePlugin | undefined,
): StatusPlugin {
  return {
    id: p.id,
    version: p.version,
    latest: latest?.version ?? null,
    // skills not read: the version alone decides
    current: !!latest && p.version === latest.version && (p.skills === null || sameSet(p.skills, latest.skills)),
    skills: p.skills,
    path: p.path,
    enabled: p.enabled,
  };
}

/** "(latest 1.3.1)" with, when the skill sets differ, which skills are missing from or extra in the installed copy. */
function against(p: StatusPlugin, latest: ReleasePlugin | undefined, release: Release | null): string {
  if (!release) return "(latest unknown)";
  if (!latest) return "(not in the release)";
  const parts = [`latest ${latest.version ?? "no version"}`];
  const skills = p.skills;
  if (skills === null) parts.push("skills not read");
  else if (!sameSet(skills, latest.skills)) {
    const missing = latest.skills.filter((s) => !skills.includes(s));
    const extra = skills.filter((s) => !latest.skills.includes(s));
    parts.push(
      `skills differ: ${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}`,
    );
  }
  return `(${parts.join("; ")})`;
}

function harnessReport(state: HarnessState, form: MachineForm, release: Release | null, cloud: boolean): StatusHarness {
  const lines: StatusLine[] = [];
  const synced: StatusPlugin[] = [];
  const installed: StatusInstalled[] = [];
  const other: StatusOther[] = [];
  /** skill name -> where it is listed, for the duplicate lines */
  const places = new Map<string, string[]>();
  const place = (skill: string, where: string) => places.set(skill, [...(places.get(skill) ?? []), where]);
  const v = (x: string | null) => x ?? "no version";
  /** the plugin, duplicate and folder lines: everything but the block, which the cloud also shows */
  const machineLine = (l: StatusLine) => {
    if (!cloud) lines.push(l);
  };

  const byId = <T extends { id: string }>(list: T[]): T[] => [...list].sort((a, b) => a.id.localeCompare(b.id));

  if (state.note) machineLine(note(state.note));
  for (const p of byId(state.synced)) {
    // a plugin switched off loads nothing: its skills are no place for a duplicate
    if (p.enabled) for (const s of p.skills) place(s, `${p.id}@synced`);
    const latest = release?.plugins[p.id];
    // without the release, every account plugin may be the library's: all are listed, none judged
    if (release && !latest) {
      other.push({ id: p.id, marketplace: p.marketplace, scope: "synced", version: p.version, skills: p.skills });
      continue;
    }
    const c = compare(p, latest);
    synced.push(c);
    const name = `${p.id}@synced ${v(p.version)}`;
    if (!p.enabled) {
      machineLine(note(`${name} disabled ${against(c, latest, release)}`));
      continue;
    }
    const text = `${name} ${against(c, latest, release)}`;
    machineLine(!release ? note(text) : c.current ? green(text) : red(text));
  }
  for (const p of byId(state.installed)) {
    if (p.enabled) for (const s of p.skills ?? []) place(s, `${p.id}@${p.marketplace}`);
    if (p.marketplace !== LIBRARY_MARKETPLACE) {
      other.push({ id: p.id, marketplace: p.marketplace, scope: "installed", version: p.version, skills: p.skills });
      continue;
    }
    const latest = release?.plugins[p.id];
    const c = { ...compare(p, latest), marketplace: p.marketplace };
    installed.push(c);
    const name = `${p.id}@${p.marketplace} ${v(p.version)}`;
    // Claude Code's form is the account plugin; a CLI install of the same name hides it (ADR-0007)
    if (form === "account-plugins") machineLine(red(`${name} installed by the tool; the form is account plugins`));
    else if (!p.enabled) machineLine(red(`${name} installed but disabled`));
    else {
      const text = `${name} ${against(c, latest, release)}`;
      machineLine(!release ? note(text) : c.current ? green(text) : red(text));
    }
  }
  for (const l of state.loose) place(l.name, `loose link -> ${l.target}`);
  for (const f of state.folders) place(f.name, `folder ${f.path}`);

  // after the plugin lines: what is missing, then the duplicates, then the hook and the block, then the notes on what
  // else is there
  const tag = release ? release.tag : "unknown";
  const nothing = form === "loose" ? !state.loose.length && !state.folders.length : !synced.length && !installed.length;
  if (nothing)
    machineLine(red(form === "loose" ? `no skills (latest ${tag})` : `no plugins installed (latest ${tag})`));
  const duplicates = [...places]
    .filter(([, where]) => where.length > 1)
    .map(([skill, where]) => ({ skill, in: where }));
  for (const d of duplicates)
    machineLine(red(`${d.skill} listed ${d.in.length === 2 ? "twice" : `${d.in.length} times`}: ${d.in.join(", ")}`));

  const hook = hookReport(state, cloud ? null : lines);
  const block = blockReport(state, lines);
  for (const old of state.repoBlocks)
    lines.push(
      red(
        `skills-sync block (${old.ids.join(", ")}) in ${old.file}; remove it by hand, the block lives only in ${state.harness.name}'s global file now`,
      ),
    );

  if (state.loose.length || state.folders.length)
    machineLine(note(`${count(state.loose.length, "loose link")}, ${count(state.folders.length, "skill folder")}`));
  if (other.length)
    machineLine(
      note(
        `${count(other.length, "other plugin")} left alone: ${other
          .map(
            (o) =>
              `${o.id}@${o.scope === "synced" ? "synced" : o.marketplace}${o.scope === "synced" && o.marketplace ? ` (${o.marketplace})` : ""}`,
          )
          .join(", ")}`,
      ),
    );

  return {
    name: state.harness.name,
    form,
    cli: state.cli,
    ...(state.note ? { note: state.note } : {}),
    plugins: { synced, installed, other },
    loose: state.loose,
    folders: state.folders,
    duplicates,
    hook,
    block,
    repoBlocks: state.repoBlocks.map((b) => ({ file: b.file, ids: b.ids })),
    lines,
  };
}

/**
 * The session hook's facts and, outside the cloud (`lines` null there: a cloud session never reads user hooks), its
 * line: red when the entry is missing, when the old sync-dev.sh entry is still there, or when the file cannot be worked
 * on; green when present. A present Codex entry the person has not trusted yet is green here and a manual step below:
 * the machine is right, the trust is the person's. Harnesses are told apart by their id, never by `trusted`.
 */
function hookReport(state: HarnessState, lines: StatusLine[] | null): StatusHook | null {
  const h = state.hook;
  if (!h) return null;
  // readHook's note is a file problem when the entry is not there, and the Codex trust step when it is
  const problem = !h.present && h.note ? h.note : null;
  const current = h.present && !h.old;
  if (lines) {
    if (problem) lines.push(red(`session hook in ${h.file}: ${problem}`));
    else if (!h.present) lines.push(red(`no session hook entry in ${h.file}; run sync`));
    else if (h.old) lines.push(red(`old sync-dev.sh hook still in ${h.file}; run sync`));
    else if (state.harness.id === "codex" && h.trusted === false)
      lines.push(green(`session hook in ${h.file}, not trusted in Codex yet (manual step below)`));
    else lines.push(green(`session hook in ${h.file}`));
  }
  return { file: h.file, present: h.present, current, trusted: h.trusted };
}

/** The global block's facts and its line: green when current, red when missing, stale (an older block's text) or a conflict. */
function blockReport(state: HarnessState, lines: StatusLine[]): StatusBlock | null {
  const b = state.block;
  if (!b) return null;
  if (b.status === "current") lines.push(green(`global block in ${b.file} current`));
  else if (b.status === "missing") lines.push(red(`global block in ${b.file} is missing; run sync`));
  else if (b.status === "outdated")
    lines.push(red(`global block in ${b.file} is stale (${b.ids.join(", ")}); run sync`));
  else lines.push(red(`global block in ${b.file}: ${b.reason ?? "cannot be written"}`));
  return {
    file: b.file,
    present: b.status === "current" || b.ids.length > 0,
    current: b.status === "current",
    status: b.status,
    ids: b.ids,
  };
}

/**
 * The checkouts in reach, read-only: the branch and the porcelain status of each (story 53). The same discovery as the
 * hook's (the repository `cwd` is in and the folders beside it, by origin URL); nothing is fetched or moved, so a
 * checkout is judged as it is. Git runs without prompting and with 30 s per call.
 */
export function readCheckouts(cwd: string, env: NodeJS.ProcessEnv = process.env): StatusCheckout[] {
  const git = (dir: string, args: string[]): string => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      input: "",
      timeout: 30_000,
      windowsHide: true,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    });
    return r.status === 0 ? (r.stdout ?? "") : "";
  };
  return findCheckouts(cwd, env).map((c) => {
    const branch = git(c.path, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "HEAD";
    const dirty = git(c.path, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).length;
    return { path: c.path, repo: c.repo, branch, dirty, clean: dirty === 0, ok: branch === "dev" && dirty === 0 };
  });
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/** A checkout as one line: `<path> on dev, clean`, or red with the branch and the dirty file count. */
function checkoutLine(c: StatusCheckout): StatusLine {
  const text = `${c.path} on ${c.branch}${c.clean ? ", clean" : `, dirty (${count(c.dirty, "file")})`}`;
  return c.ok ? green(text) : red(text);
}

/**
 * The text a user reads: the release, each harness, the checkouts, the manual steps, the summary. Quiet: only the red
 * lines under their header, the manual steps (they are the person's open work) and the summary; nothing at all when
 * there is neither.
 */
export function statusText(report: StatusReport, quiet: boolean): string {
  const out: string[] = [];
  const show = (l: StatusLine) => !quiet || !l.ok;
  for (const l of report.lines) if (show(l)) out.push(l.mark === "=" ? l.text : `${l.mark} ${l.text}`);
  if (report.cloud && !quiet) out.push(". cloud session");
  for (const h of Object.values(report.harnesses)) {
    const lines = h.lines.filter(show);
    if (!lines.length) continue;
    out.push(`${h.name}  form: ${FORM_LABEL[h.form]}`);
    for (const l of lines) out.push(`${l.mark} ${l.text}`);
  }
  if (!report.cloud) {
    const lines = report.checkouts.map(checkoutLine).filter(show);
    if (lines.length) {
      out.push("Checkouts");
      for (const l of lines) out.push(`${l.mark} ${l.text}`);
    } else if (!report.checkouts.length && !quiet)
      out.push(
        ". no checkout of oneezy/skills or oneezy/tools in reach (the repository here and the folders beside it)",
      );
  }
  if (report.manualSteps.length) {
    out.push("Manual steps");
    report.manualSteps.forEach((s, i) => {
      out.push(`${i + 1}. ${s.title}`);
      s.steps.forEach((step, j) => out.push(`   ${j + 1}. ${step}`));
    });
  }
  const steps = report.manualSteps.length;
  if (report.red || steps)
    out.push(`status: ${count(report.red, "red line")}${steps ? `, ${count(steps, "manual step")}` : ""}`);
  else if (!quiet) out.push("status: all green");
  return out.length ? out.join("\n") + "\n" : "";
}
