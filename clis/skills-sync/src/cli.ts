#!/usr/bin/env node
// skills-sync: one skills library, every harness, every project on the machine. One command that works out where it is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { addSource, manifestText } from "./add.js";
import { readConfig, writeConfig, type Config } from "./config.js";
import { gitExclude, isDir, isLink, lexists, linkTarget, real, samePath } from "./fs.js";
import { detected, harnessTable, type Harness } from "./harnesses.js";
import { cloneLibrary, DEFAULT_LIBRARY, findLibrary, homeLibrary, Library, looksLikeLibrary, pullLibrary } from "./library.js";
import { apply, line, Report } from "./plan.js";
import { refresh, type RefreshResult } from "./refresh.js";
import { discard } from "./stage.js";
import { findProjects, home, isRepo, layers, projects, status, unlink, type Status } from "./steps.js";
import { runInWsl, wslDistros } from "./wsl.js";

const VERSION = "0.2.0";
const HELP = `skills-sync ${VERSION}
One skills library, every harness, every project on this machine. Run it anywhere; it works out the rest.

  no library on this machine   clone one into ~/.skills-sync (default: ${DEFAULT_LIBRARY}, or --library owner/repo)
  library present              pull it, restore what the lock has, rebuild its layers, link the user folders

Usage: skills-sync [command] [options]

Commands
  sync (default)   everything above; with skills-sources.json, the restore is a frozen refresh
  status           what is linked and what is missing
  unlink           remove every link this tool made in the user folders
  projects         only the project step
  refresh          resolve every source in skills-sources.json: snapshot under upstream/, write the lock,
                   rebuild the third-party working set, regenerate skills-lock.json
  add <source>     declare a source (owner/repo[#ref], a git URL or a path) in skills-sources.json, then refresh

Refresh and add
  --frozen               refresh at the lock's commits; nothing moves (what sync does)
  --id <id>              add: the source id (default: owner-repo, or the repo's folder name)
  --root <path>          add: where the skill folders live in the repo (default: skills/ when it exists, else the root)
  --skills <names|*>     add: which skills to take (default: all)
  --as <old=new,...>     add: take a skill under another name (tdd=pstack-tdd)

Options
  --repo <path>          the skills library (default: $SKILLS_REPO, ~/.skills-sync, a library folder above here)
  --library <src>        what to clone when there is no library yet (owner/repo or URL; default ${DEFAULT_LIBRARY})
  --agents <ids>         harnesses: claude-code,codex,goose,hermes (default: detected)
  --global / --no-global link into the harnesses' user skills folders (default: yes)
  --projects <names|*>   repos under --dev to sync; "*" for all; --no-projects for none
  --dev <dir>            folder whose git repos are offered (default: here, or the parent when here is a repo)
  --copy                 projects get real copies instead of links
  --wsl <distros|*>      Windows: also sync the user folders inside these WSL distros; --no-wsl for none
  --no-pull / --pull     skip, or force, the library pull (default: at most every 30 minutes)
  --no-restore           do not restore missing lock entries from their sources (skips the frozen refresh too)
  --retry                look again for skills an earlier run reported gone upstream (sync and refresh)
  --sidecars             generate agents/openai.yaml for own skills that lack one (writes into skills/, so opt-in)
  --no-layers            leave the library's own layers alone (used inside WSL, where Windows owns them)
  --watch                stay running; redo layers and user folders when skills/ or the lock changes
  --plan                 show what would change, touch nothing
  --quiet                for scripts: no prompts, no WSL fan-out, print only changes and problems
  --json                 machine output
  -y, --yes              no prompts: flags, then remembered answers, then defaults
  --ask                  prompt even when answers are remembered
  -h, --help
`;

interface Args {
  command: string;
  /** what follows the command: the source for add */
  positional: string[];
  frozen: boolean;
  id?: string;
  root?: string;
  skills?: string[] | "*";
  as: Record<string, string>;
  repo?: string;
  library?: string;
  agents?: string[];
  global?: boolean;
  projects?: string[] | "*" | false;
  dev?: string;
  copy?: boolean;
  wsl?: string[] | "*" | false;
  pull: boolean | "force";
  restore: boolean;
  retry: boolean;
  sidecars: boolean;
  layers: boolean;
  watch: boolean;
  plan: boolean;
  quiet: boolean;
  json: boolean;
  yes: boolean;
  ask: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: "sync", positional: [], frozen: false, as: {}, pull: true, restore: true, retry: false, sidecars: false, layers: true, watch: false, plan: false, quiet: false, json: false, yes: false, ask: false };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (x === "--frozen") a.frozen = true;
    else if (x === "--id") a.id = next();
    else if (x === "--root") a.root = next();
    else if (x === "--skills") {
      const v = next();
      a.skills = v === "*" ? "*" : list(v);
    } else if (x === "--as") {
      for (const pair of list(next())) {
        const [from, to] = pair.split("=");
        if (!from || !to) bail(`--as takes old=new pairs, not ${pair}`);
        a.as[from] = to;
      }
    } else if (x === "--repo") a.repo = next();
    else if (x === "--library") a.library = next();
    else if (x === "--agents") a.agents = list(next());
    else if (x === "--global") a.global = true;
    else if (x === "--no-global") a.global = false;
    else if (x === "--projects") {
      const v = next();
      a.projects = v === "*" ? "*" : list(v);
    } else if (x === "--no-projects") a.projects = false;
    else if (x === "--dev") a.dev = next();
    else if (x === "--copy") a.copy = true;
    else if (x === "--wsl") {
      const v = next();
      a.wsl = v === "*" ? "*" : list(v);
    } else if (x === "--no-wsl") a.wsl = false;
    else if (x === "--no-pull") a.pull = false;
    else if (x === "--pull") a.pull = "force";
    else if (x === "--no-restore") a.restore = false;
    else if (x === "--retry") a.retry = true;
    else if (x === "--sidecars") a.sidecars = true;
    else if (x === "--no-layers") a.layers = false;
    else if (x === "--watch") a.watch = true;
    else if (x === "--plan") a.plan = true;
    else if (x === "--quiet") a.quiet = true;
    else if (x === "--json") a.json = true;
    else if (x === "-y" || x === "--yes") a.yes = true;
    else if (x === "--ask") a.ask = true;
    else if (x.startsWith("-")) {
      process.stderr.write(`unknown option ${x}\n${HELP}`);
      process.exit(2);
    } else if (command === null) command = a.command = x;
    else a.positional.push(x);
  }
  if (a.quiet) a.yes = true;
  return a;
}

interface Choices {
  agents: Harness[];
  global: boolean;
  dev: string;
  projects: string[];
  mode: "link" | "copy";
  wsl: string[];
  unavailable: string[];
}

function bail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const userHome = os.homedir();
  const interactive = !args.yes && !args.json && process.stdin.isTTY && process.stdout.isTTY;
  const log = (m: string) => (args.json ? undefined : process.stderr.write(m + "\n"));
  const setup = new Report();

  // 1. the library: find it, or get one
  let root = args.repo ? real(path.resolve(args.repo)) : findLibrary(cwd);
  if (!root && !args.plan) {
    let source = args.library ?? DEFAULT_LIBRARY;
    if (interactive) {
      p.intro("skills-sync");
      const v = await p.text({ message: "No skills library on this machine. Clone which one into ~/.skills-sync?", initialValue: source, placeholder: "owner/repo, a git URL, or a local path" });
      if (p.isCancel(v)) return p.cancel("nothing changed");
      source = String(v);
    }
    if (looksLikeLibrary(source)) root = real(path.resolve(source));
    else {
      const c = cloneLibrary(source, userHome, log);
      if (!c.ok) bail(`could not clone ${source}: ${c.error}`);
      root = c.root;
    }
  }
  // the first add is how a library gets its manifest: with --repo, skills/ alone is enough for it
  const firstAdd = args.command === "add" && !!args.repo && !!root && isDir(path.join(root, "skills"));
  if (!root || (!looksLikeLibrary(root) && !firstAdd)) bail("no skills library found: run this inside one, or pass --repo <path> or --library owner/repo");
  const lib = new Library(root);

  // refresh and add edit the library they are pointed at and nothing else: no pull, no ~/.skills-sync, no harness
  if (args.command === "refresh") return runRefresh(lib, args, log);
  if (args.command === "add") return runAdd(lib, args, log);

  // ~/.skills-sync points at the library from now on, so every later run finds it from anywhere
  const hl = homeLibrary(userHome);
  if (!samePath(real(hl), lib.root)) {
    if (!lexists(hl)) setup.add({ kind: "link", path: hl, target: lib.root, note: "remembers where the library is" });
    else if (isLink(hl)) setup.add({ kind: "relink", path: hl, target: lib.root, note: `was ${linkTarget(hl)}` });
    else setup.add({ kind: "conflict", path: hl, note: "a folder is in the way; ~/.skills-sync is not a link to the library" });
  }
  apply(setup, args.plan);

  // 2. keep the library current
  if (args.pull && args.command !== "status" && !args.plan) {
    if (args.pull === "force") {
      try {
        fs.unlinkSync(path.join(lib.root, ".git", "skills-sync-pulled"));
      } catch {
        /* nothing to reset */
      }
    }
    const r = pullLibrary(lib.root, 30, log);
    if (r === "pulled" && !args.quiet) log("library pulled");
    if (r === "dirty" && !args.quiet) log("library has local changes; pull skipped");
  }

  const cfg = readConfig(lib.root);
  const table = harnessTable();

  if (args.command === "status") {
    const ids = args.agents ?? cfg.agents;
    return printStatus(lib, ids ? table.filter((h) => ids.includes(h.id)) : detected(table), args.json);
  }
  if (args.command === "unlink") {
    const r = new Report();
    unlink(lib, table, r);
    apply(r, args.plan);
    return printReport(r, args);
  }

  // 3. the choices: flags, then remembered answers, then defaults; prompts fill the gaps when interactive
  const choices = await decide(args, cfg, lib, table, cwd, interactive);
  if (!choices) return p.cancel("nothing changed");
  if (!args.plan) saveConfig(lib.root, choices);

  // 4. run
  const run = () => runOnce(lib, choices, args, cwd, setup);
  await run();
  if (args.watch) {
    log(`watching ${lib.own} and ${path.basename(lib.lockFile)}; ctrl-c to stop`);
    let timer: NodeJS.Timeout | null = null;
    const trigger = (why: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        log(`change in ${why}`);
        runOnce(lib, choices, { ...args, restore: false }, cwd, new Report()).catch((e) => log(String(e)));
      }, 400);
    };
    fs.watch(lib.own, { recursive: true }, (_e, f) => trigger(String(f ?? "skills/")));
    for (const f of [lib.lockFile, lib.sourcesLockFile]) if (fs.existsSync(f)) fs.watch(f, () => trigger(path.basename(f)));
    await new Promise(() => undefined);
  }
}

/** refresh: every source per its policy (or the lock's commits with --frozen); gone-upstream skills are remembered like restore's. */
function runRefresh(lib: Library, args: Args, log: (m: string) => void): void {
  if (!lib.hasManifest()) bail(`no ${path.basename(lib.manifestFile)} in ${lib.root}; add <source> writes one`);
  const cfg = readConfig(lib.root);
  const unavailable = args.retry ? [] : cfg.unavailable ?? [];
  const r = refresh(lib, { frozen: args.frozen, plan: args.plan, unavailable, log });
  reportRefresh(lib, r, unavailable, args, log, !args.quiet);
  printReport(r.report, args, { sources: r.sources, gone: r.gone, unlocked: r.unlocked, problems: r.problems });
  if (r.problems.length) process.exitCode = 1;
}

/**
 * The refresh's lines that are not file actions, and the remembered gone-upstream list, shared by refresh and sync.
 * `verbose` names every source's commit; otherwise only one that moved, so a sync with nothing new says nothing.
 */
function reportRefresh(lib: Library, r: RefreshResult, unavailable: string[], args: Args, log: (m: string) => void, verbose: boolean): string[] {
  for (const [id, s] of Object.entries(r.sources)) if (s.moved || verbose) log(`${id}: ${s.commit.slice(0, 7)} (${s.date.slice(0, 10)})${s.moved ? ", moved" : ""}`);
  for (const g of r.gone) log(`  gone upstream: ${g}`);
  if (r.gone.length) log(`  (not in the lock; deselect it in ${path.basename(lib.manifestFile)}, or a copy in skills/ keeps it as your own; --retry checks again)`);
  if (r.unlocked.length && !args.quiet) log(`${r.unlocked.length} selected skill(s) not in ${path.basename(lib.sourcesLockFile)} (${r.unlocked.join(", ")}); run refresh to resolve them`);
  for (const m of r.problems) log(`failed: ${m}`);
  const gone = r.gone.map((g) => g.split(":")[1]);
  const remembered = [...new Set([...unavailable, ...gone])];
  if (remembered.length && !args.quiet) log(`${remembered.length} selected skill${remembered.length === 1 ? " is" : "s are"} gone upstream (${remembered.join(", ")}); --retry to check again`);
  if (!args.plan) {
    const cfg = readConfig(lib.root);
    const next: Config = { ...cfg, unavailable: remembered };
    if (!remembered.length) delete next.unavailable;
    if (JSON.stringify(next) !== JSON.stringify(cfg)) writeConfig(lib.root, next);
  }
  return remembered;
}

/** add: stage the source, write its manifest entry, then refresh with the staged clone. --plan shows the entry and writes nothing. */
function runAdd(lib: Library, args: Args, log: (m: string) => void): void {
  const spec = args.positional[0];
  if (!spec) bail("add: which source? owner/repo[#ref], a git URL or a local path");
  const r = addSource(lib, spec, { id: args.id, root: args.root, skills: args.skills, as: args.as, log });
  if (!r.ok) bail(r.error);
  const names = Object.keys(r.entry.skills).length;
  const renames = Array.isArray(r.entry.skills) ? [] : Object.entries(r.entry.skills).filter(([a, b]) => a !== b);
  log(`${r.id}: ${r.entry.repo}@${r.entry.ref} (${r.staged.commit.slice(0, 7)}), ${names} of ${r.found.size} skills under ${r.entry.root ?? "the root"}${renames.length ? `, renaming ${renames.map(([a, b]) => `${a} -> ${b}`).join(", ")}` : ""}`);
  if (args.plan) {
    discard(r.staged);
    process.stdout.write(`plan: would add to ${lib.manifestFile}:\n${JSON.stringify({ [r.id]: r.entry }, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(lib.manifestFile, manifestText(r.manifest));
  log(`wrote ${path.basename(lib.manifestFile)}`);
  const cfg = readConfig(lib.root);
  const unavailable = args.retry ? [] : cfg.unavailable ?? [];
  const res = refresh(lib, { frozen: false, plan: false, unavailable, log, prestaged: { [r.id]: r.staged } });
  reportRefresh(lib, res, unavailable, args, log, !args.quiet);
  printReport(res.report, args, { sources: res.sources, gone: res.gone, unlocked: res.unlocked, problems: res.problems });
  if (res.problems.length) process.exitCode = 1;
}

function saveConfig(root: string, c: Choices): void {
  const saved: Config = { agents: c.agents.map((h) => h.id), global: c.global, dev: c.dev, projects: c.projects, mode: c.mode, wsl: c.wsl };
  if (c.unavailable.length) saved.unavailable = c.unavailable;
  writeConfig(root, saved);
}

async function decide(args: Args, cfg: Config, lib: Library, table: Harness[], cwd: string, interactive: boolean): Promise<Choices | null> {
  const found = detected(table);
  const byId = new Map(table.map((h) => [h.id, h]));
  // first run with nothing remembered: only the two harnesses this tool is built around, unless asked
  let agentIds = args.agents ?? cfg.agents ?? found.filter((h) => h.id === "claude-code" || h.id === "codex").map((h) => h.id);
  let global = args.global ?? cfg.global ?? true;
  const here = path.resolve(cwd);
  let dev = args.dev ? path.resolve(args.dev) : cfg.dev ?? (isRepo(here) && !looksLikeLibrary(here) ? path.dirname(here) : here);
  const offered = findProjects(dev, lib).map((pp) => path.basename(pp));
  let projectNames: string[] = args.projects === false ? [] : args.projects === "*" ? offered : args.projects ?? cfg.projects ?? [];
  let mode: "link" | "copy" = args.copy ? "copy" : cfg.mode ?? "link";
  const distros = args.quiet ? [] : wslDistros();
  let wsl: string[] = args.wsl === false ? [] : args.wsl === "*" ? distros : args.wsl ?? cfg.wsl ?? [];

  const remembered = Object.keys(cfg).length > 0;
  if (interactive && (args.ask || !remembered || args.command === "projects")) {
    if (!remembered) p.intro("skills-sync: first run on this machine");
    const agentsPick = await p.multiselect({
      message: "Harnesses to sync (checked = detected on this machine)",
      options: table.map((h) => ({ value: h.id, label: h.name, hint: found.includes(h) ? "detected" : "not found" })),
      initialValues: agentIds,
      required: true,
    });
    if (p.isCancel(agentsPick)) return null;
    agentIds = agentsPick as string[];

    const whereOptions = [{ value: "global", label: "User folders", hint: "every project on this machine; edits are live" }];
    if (offered.length) whereOptions.push({ value: "projects", label: `Projects in ${dev}`, hint: `${offered.length} git repos; only for repos that must carry copies` });
    const where = await p.multiselect({ message: "Where", options: whereOptions, initialValues: [global ? "global" : "", projectNames.length ? "projects" : ""].filter(Boolean), required: false });
    if (p.isCancel(where)) return null;
    global = (where as string[]).includes("global");
    if ((where as string[]).includes("projects")) {
      const pick = await p.multiselect({ message: "Which projects (space to check)", options: offered.map((n) => ({ value: n, label: n })), initialValues: projectNames.length ? projectNames : offered, required: false });
      if (p.isCancel(pick)) return null;
      projectNames = pick as string[];
      const m = await p.select({
        message: "Project mode",
        options: [
          { value: "link", label: "link", hint: "machine-local, hidden from git through .git/info/exclude" },
          { value: "copy", label: "copy", hint: "committed, travels with the repo" },
        ],
        initialValue: mode,
      });
      if (p.isCancel(m)) return null;
      mode = m as "link" | "copy";
    } else projectNames = [];
    if (distros.length) {
      const m = await p.multiselect({ message: "Machines", options: [{ value: "__win__", label: "Windows", hint: "this one" }, ...distros.map((d) => ({ value: d, label: `WSL: ${d}` }))], initialValues: ["__win__", ...wsl], required: true });
      if (p.isCancel(m)) return null;
      wsl = (m as string[]).filter((x) => x !== "__win__");
    }
  }
  const agents = agentIds.map((id) => byId.get(id)).filter((h): h is Harness => !!h);
  if (!agents.length) bail("no harness selected; pass --agents claude-code,codex");
  return { agents, global, dev, projects: projectNames, mode, wsl, unavailable: args.retry ? [] : cfg.unavailable ?? [] };
}

async function runOnce(lib: Library, c: Choices, args: Args, cwd: string, report: Report): Promise<void> {
  const log = (m: string) => (args.json ? undefined : process.stderr.write(m + "\n"));
  const userHome = os.homedir();

  const missing = lib.missingFromLock().filter((n) => !c.unavailable.includes(n));
  if (lib.hasManifest() && args.restore && args.command !== "projects" && !args.plan) {
    // a manifest library: the frozen refresh restores from the lock's commits and rebuilds the working set
    const r = refresh(lib, { frozen: true, plan: false, unavailable: c.unavailable, log });
    c.unavailable = reportRefresh(lib, r, c.unavailable, args, log, false);
    report.merge(r.report);
  } else if (lib.hasManifest() && missing.length) log(`${missing.length} lock entries are not installed yet (run without --plan or --no-restore for the frozen refresh that restores them)`);
  else if (args.restore && args.command !== "projects" && missing.length && !args.plan) {
    const r = lib.restore(log, missing);
    log(`restored ${r.restored.length} skill(s) from skills-lock.json`);
    for (const m of r.moved) log(`  moved upstream: ${m}`);
    for (const m of r.missing) log(`  gone upstream: ${m}`);
    if (r.missing.length) log(`  (npx skills remove <name> drops it from the lock; a copy in skills/ keeps it as your own; --retry checks again)`);
    for (const m of r.failed) log(`  failed: ${m}`);
    c.unavailable = [...new Set([...c.unavailable, ...r.missing.map((m) => m.split(":")[0])])];
    saveConfig(lib.root, c);
  } else if (missing.length) log(`${missing.length} lock entries are not installed yet (run without --plan or --no-restore to restore them)`);
  if (c.unavailable.length && !args.quiet && !lib.hasManifest()) log(`${c.unavailable.length} lock entr${c.unavailable.length === 1 ? "y is" : "ies are"} gone upstream (${c.unavailable.join(", ")}); --retry to check again`);

  if (args.command !== "projects") {
    if (args.layers) {
      const s = new Report();
      layers(lib, c.agents, s, args.sidecars);
      apply(s, args.plan);
      report.merge(s);
    }
    if (c.global) {
      const u = new Report();
      home(lib, c.agents, u);
      apply(u, args.plan);
      report.merge(u);
    }
  }
  if (c.projects.length) {
    const targets = c.projects.map((n) => path.join(c.dev, n)).filter((pp) => isDir(pp));
    const pr = new Report();
    projects(lib, c.agents, targets, null, c.mode, pr);
    apply(pr, args.plan, gitExclude);
    report.merge(pr);
  }

  printReport(report, args);
  if (c.wsl.length && args.command !== "projects" && !args.quiet) {
    for (const d of c.wsl) {
      const r = runInWsl(d, lib.root, [], args.plan);
      log(`WSL ${d}: ${r.ok ? "ok" : "failed"}${r.output ? "\n  " + r.output.split("\n").slice(-3).join("\n  ") : ""}`);
    }
  }
}

function printReport(r: Report, args: Args, extra: Record<string, unknown> = {}): void {
  if (args.json) {
    // a write's payload is the file body; bytes (an attribution file) are summarised, text is kept as before
    const actions = r.actions.map((a) => (Buffer.isBuffer(a.payload) ? { ...a, payload: `<${a.payload.length} bytes>` } : a));
    process.stdout.write(JSON.stringify({ plan: args.plan, actions, ...extra }, null, 2) + "\n");
    return;
  }
  const changes = r.changes();
  const conflicts = r.conflicts();
  if (args.quiet && !changes.length && !conflicts.length) return;
  for (const a of r.actions) if (a.kind !== "skip") process.stdout.write(line(a) + "\n");
  const verb = args.plan ? "would change" : "changed";
  process.stdout.write(`${args.plan ? "plan: " : ""}${changes.length} ${verb}, ${r.skips()} already right, ${conflicts.length} left alone\n`);
}

function printStatus(lib: Library, table: Harness[], json: boolean): void {
  const s = status(lib, table);
  if (json) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return;
  }
  process.stdout.write(`library ${s.library}: ${s.own.length} own${groupSummary(s)}, ${s.thirdParty.length} third-party, ${s.missingFromLock.length} in the lock but not installed\n`);
  for (const [layer, v] of Object.entries(s.layers)) process.stdout.write(`${layer}: ${v.linked} linked, ${v.missing.length} missing\n`);
  for (const [dir, v] of Object.entries(s.user)) process.stdout.write(`${dir}: ${v.linked} linked, ${v.missing.length} missing\n`);
}


/** " (oneezy: 2, flat: 1)" when any own skill sits in a group; nothing for a flat-only library. */
function groupSummary(s: Status): string {
  const counts = new Map<string, number>();
  for (const o of s.ownSkills) counts.set(o.plugin ?? "flat", (counts.get(o.plugin ?? "flat") ?? 0) + 1);
  if (![...counts.keys()].some((k) => k !== "flat")) return "";
  return ` (${[...counts].map(([k, v]) => `${k}: ${v}`).join(", ")})`;
}

main().catch((e) => bail(String(e?.stack ?? e)));
