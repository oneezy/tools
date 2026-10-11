// status: this machine against the latest release of the library, per harness. Lines a user reads, and a --json object
// /oneezy-status reads with the same facts. Red lines: a plugin behind the release (version or skill set), a plugin
// this tool installed where the form is account plugins, nothing installed at all, a skill name listed twice. Exit 1
// when any line is red. Nothing is written, no library is looked for. Later tickets add the hook, the global block and
// the checkouts to the same report.
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
  /** version and skill set both match the release */
  current: boolean;
  skills: string[];
  path: string | null;
}

export interface StatusInstalled extends StatusPlugin {
  marketplace: string;
  enabled: boolean;
}

/** A plugin that is not the library's: an account plugin from another marketplace, or a CLI install from elsewhere. */
export interface StatusOther {
  id: string;
  marketplace: string | null;
  scope: "synced" | "installed";
  version: string | null;
  skills: string[];
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
  lines: StatusLine[];
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
  ok: boolean;
}

export interface StatusOptions {
  /** the release repo, owner/repo */
  repo: string;
  json: boolean;
  quiet: boolean;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
}

/** Read the release, probe the machine, print the report. Returns the exit code: 0 all green, 1 something red. */
export async function runStatus(options: StatusOptions): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  let release: Release | null = null;
  let error: string | null = null;
  try {
    release = await latestRelease(github(env), options.repo);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const report = statusReport(options.repo, release, error, probe(harnessTable(undefined, env), env));
  write(options.json ? JSON.stringify(report, null, 2) + "\n" : statusText(report, options.quiet));
  return report.ok ? 0 : 1;
}

const green = (text: string): StatusLine => ({ ok: true, mark: "=", text });
const red = (text: string): StatusLine => ({ ok: false, mark: "!", text });
const note = (text: string): StatusLine => ({ ok: true, mark: ".", text });

/** The report from a release (or why there is none) and the probe. Pure: what the tests compare, what --json prints. */
export function statusReport(
  repo: string,
  release: Release | null,
  error: string | null,
  machine: Machine,
): StatusReport {
  const lines: StatusLine[] = [
    release
      ? green(`latest: ${release.repo} ${release.tag} (${release.commit.slice(0, 7)})`)
      : red(`latest release of ${repo}: ${error ?? "not read"}`),
  ];
  const harnesses: Record<string, StatusHarness> = {};
  for (const state of machine.harnesses) {
    const form = formOf(state.harness.id);
    if (form) harnesses[state.harness.id] = harnessReport(state, form, release);
  }
  const all = [...lines, ...Object.values(harnesses).flatMap((h) => h.lines)];
  return {
    release: release
      ? { repo: release.repo, tag: release.tag, number: release.number, commit: release.commit, tool: release.tool }
      : null,
    ...(error ? { error } : {}),
    cloud: machine.cloud,
    harnesses,
    lines,
    ok: all.every((l) => l.ok),
  };
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
}

function compare(
  p: { id: string; version: string | null; skills: string[]; path: string | null },
  latest: ReleasePlugin | undefined,
): StatusPlugin {
  return {
    id: p.id,
    version: p.version,
    latest: latest?.version ?? null,
    current: !!latest && p.version === latest.version && sameSet(p.skills, latest.skills),
    skills: p.skills,
    path: p.path,
  };
}

/** "(latest 1.3.1)" with, when the skill sets differ, which skills are missing from or extra in the installed copy. */
function against(p: StatusPlugin, latest: ReleasePlugin | undefined, release: Release | null): string {
  if (!release) return "(latest unknown)";
  if (!latest) return "(not in the release)";
  const parts = [`latest ${latest.version ?? "no version"}`];
  if (!sameSet(p.skills, latest.skills)) {
    const missing = latest.skills.filter((s) => !p.skills.includes(s));
    const extra = p.skills.filter((s) => !latest.skills.includes(s));
    parts.push(
      `skills differ: ${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}`,
    );
  }
  return `(${parts.join("; ")})`;
}

function harnessReport(state: HarnessState, form: MachineForm, release: Release | null): StatusHarness {
  const lines: StatusLine[] = [];
  const synced: StatusPlugin[] = [];
  const installed: StatusInstalled[] = [];
  const other: StatusOther[] = [];
  /** skill name -> where it is listed, for the duplicate lines */
  const places = new Map<string, string[]>();
  const place = (skill: string, where: string) => places.set(skill, [...(places.get(skill) ?? []), where]);
  const v = (x: string | null) => x ?? "no version";

  const byId = <T extends { id: string }>(list: T[]): T[] => [...list].sort((a, b) => a.id.localeCompare(b.id));

  if (state.note) lines.push(note(state.note));
  for (const p of byId(state.synced)) {
    for (const s of p.skills) place(s, `${p.id}@synced`);
    const latest = release?.plugins[p.id];
    // without the release, every account plugin may be the library's: all are listed, none judged
    if (release && !latest) {
      other.push({ id: p.id, marketplace: p.marketplace, scope: "synced", version: p.version, skills: p.skills });
      continue;
    }
    const c = compare(p, latest);
    synced.push(c);
    const text = `${p.id}@synced ${v(p.version)} ${against(c, latest, release)}`;
    lines.push(!release ? note(text) : c.current ? green(text) : red(text));
  }
  for (const p of byId(state.installed)) {
    for (const s of p.skills) place(s, `${p.id}@${p.marketplace}`);
    if (p.marketplace !== LIBRARY_MARKETPLACE) {
      other.push({ id: p.id, marketplace: p.marketplace, scope: "installed", version: p.version, skills: p.skills });
      continue;
    }
    const latest = release?.plugins[p.id];
    const c = { ...compare(p, latest), marketplace: p.marketplace, enabled: p.enabled };
    installed.push(c);
    const name = `${p.id}@${p.marketplace} ${v(p.version)}`;
    // Claude Code's form is the account plugin; a CLI install of the same name hides it (ADR-0007)
    if (form === "account-plugins") lines.push(red(`${name} installed by the tool; the form is account plugins`));
    else if (!p.enabled) lines.push(red(`${name} installed but disabled`));
    else {
      const text = `${name} ${against(c, latest, release)}`;
      lines.push(!release ? note(text) : c.current ? green(text) : red(text));
    }
  }
  for (const l of state.loose) place(l.name, `loose link -> ${l.target}`);
  for (const f of state.folders) place(f.name, `folder ${f.path}`);

  const tag = release ? release.tag : "unknown";
  if (form === "loose") {
    if (!state.loose.length && !state.folders.length) lines.push(red(`no skills (latest ${tag})`));
    else lines.push(note(`${count(state.loose.length, "loose link")}, ${count(state.folders.length, "skill folder")}`));
  } else {
    if (!synced.length && !installed.length) lines.push(red(`no plugins installed (latest ${tag})`));
    if (state.loose.length || state.folders.length)
      lines.push(note(`${count(state.loose.length, "loose link")}, ${count(state.folders.length, "skill folder")}`));
  }
  if (other.length)
    lines.push(
      note(
        `${count(other.length, "other plugin")} left alone: ${other
          .map(
            (o) =>
              `${o.id}@${o.scope === "synced" ? "synced" : o.marketplace}${o.scope === "synced" && o.marketplace ? ` (${o.marketplace})` : ""}`,
          )
          .join(", ")}`,
      ),
    );
  const duplicates = [...places]
    .filter(([, where]) => where.length > 1)
    .map(([skill, where]) => ({ skill, in: where }));
  for (const d of duplicates)
    lines.push(red(`${d.skill} listed ${d.in.length === 2 ? "twice" : `${d.in.length} times`}: ${d.in.join(", ")}`));

  return {
    name: state.harness.name,
    form,
    cli: state.cli,
    ...(state.note ? { note: state.note } : {}),
    plugins: { synced, installed, other },
    loose: state.loose,
    folders: state.folders,
    duplicates,
    lines,
  };
}

function count(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/** The text a user reads. Quiet: only the red lines, under their harness, and the summary when there is anything red. */
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
  const reds = [...report.lines, ...Object.values(report.harnesses).flatMap((h) => h.lines)].filter(
    (l) => !l.ok,
  ).length;
  if (reds) out.push(`status: ${count(reds, "red line")}`);
  else if (!quiet) out.push("status: all green");
  return out.length ? out.join("\n") + "\n" : "";
}
