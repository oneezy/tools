#!/usr/bin/env node
// skills-sync: one skills library, every harness, every project on the machine.
import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import { readConfig, writeConfig, type Config } from "./config.js";
import { gitExclude, isDir } from "./fs.js";
import { detected, harnessTable, type Harness } from "./harnesses.js";
import { findLibrary, Library, looksLikeLibrary } from "./library.js";
import { apply, line, Report } from "./plan.js";
import { findProjects, home, isRepo, layers, projects, status, unlink } from "./steps.js";
import { runInWsl, wslDistros } from "./wsl.js";

const VERSION = "0.1.0";
const HELP = `skills-sync ${VERSION}
One skills library, every harness, every project on this machine.

Usage: skills-sync [command] [options]

Commands
  sync (default)   restore from the lock, build the library's layers, link user folders and projects
  status           what is linked and what is missing
  unlink           remove every link this tool made in the user folders
  projects         only the project step

Options
  --repo <path>          the skills library (default: walk up from here, $SKILLS_REPO, ~/dev/skills)
  --agents <ids>         harnesses: claude-code,codex,goose,hermes (default: detected)
  --global / --no-global link into the harnesses' user skills folders (default: yes)
  --projects <names|*>   repos under --dev to sync; "*" for all; --no-projects for none
  --dev <dir>            folder whose git repos are offered (default: here, or the parent when here is a repo)
  --copy                 projects get real copies instead of links
  --wsl <distros|*>      Windows: also sync the user folders inside these WSL distros; --no-wsl for none
  --no-restore           do not restore missing lock entries from their sources
  --retry                retry lock entries an earlier run reported as gone upstream
  --no-sidecars          do not generate agents/openai.yaml for own skills
  --no-layers            leave the library's own layers alone (used inside WSL, where Windows owns them)
  --watch                stay running; redo layers and user folders when skills/ or the lock changes
  --plan                 show what would change, touch nothing
  --json                 machine output
  -y, --yes              no prompts: flags, then remembered answers, then defaults
  --ask                  prompt even when answers are remembered
  -h, --help
`;

interface Args {
  command: string;
  repo?: string;
  agents?: string[];
  global?: boolean;
  projects?: string[] | "*" | false;
  dev?: string;
  copy?: boolean;
  wsl?: string[] | "*" | false;
  restore: boolean;
  retry: boolean;
  sidecars: boolean;
  layers: boolean;
  watch: boolean;
  plan: boolean;
  json: boolean;
  yes: boolean;
  ask: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { command: "sync", restore: true, retry: false, sidecars: true, layers: true, watch: false, plan: false, json: false, yes: false, ask: false };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (x === "--repo") a.repo = next();
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
    else if (x === "--no-restore") a.restore = false;
    else if (x === "--retry") a.retry = true;
    else if (x === "--no-sidecars") a.sidecars = false;
    else if (x === "--no-layers") a.layers = false;
    else if (x === "--watch") a.watch = true;
    else if (x === "--plan") a.plan = true;
    else if (x === "--json") a.json = true;
    else if (x === "-y" || x === "--yes") a.yes = true;
    else if (x === "--ask") a.ask = true;
    else if (x.startsWith("-")) {
      process.stderr.write(`unknown option ${x}\n${HELP}`);
      process.exit(2);
    } else a.command = x;
  }
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
  const interactive = !args.yes && !args.json && process.stdin.isTTY && process.stdout.isTTY;

  // 1. the library
  let root = args.repo ? path.resolve(args.repo) : findLibrary(cwd);
  if (interactive) {
    p.intro("skills-sync");
    const v = await p.text({ message: "Skills library", placeholder: "path to the folder with skills/ and skills-lock.json", initialValue: root ?? "", validate: (s) => (s && looksLikeLibrary(s) ? undefined : "no skills/ folder there") });
    if (p.isCancel(v)) return p.cancel("nothing changed");
    root = path.resolve(v);
  }
  if (!root || !looksLikeLibrary(root)) bail("no skills library found: pass --repo <path> (a folder with skills/ and skills-lock.json)");
  const lib = new Library(root);
  const cfg = readConfig(root);
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

  // 2. the choices: flags, then remembered answers, then defaults; prompts fill the gaps when interactive
  const choices = await decide(args, cfg, lib, table, cwd, interactive);
  if (!choices) return p.cancel("nothing changed");
  if (!args.plan) {
    saveConfig(root, choices);
  }

  // 3. run
  const run = () => runOnce(lib, choices, args, cwd);
  await run();
  if (args.watch) {
    const log = (m: string) => process.stderr.write(m + "\n");
    log(`watching ${lib.own} and ${path.basename(lib.lockFile)}; ctrl-c to stop`);
    let timer: NodeJS.Timeout | null = null;
    const trigger = (why: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        log(`change in ${why}`);
        runOnce(lib, choices, { ...args, restore: false }, cwd).catch((e) => log(String(e)));
      }, 400);
    };
    fs.watch(lib.own, { recursive: true }, (_e, f) => trigger(String(f ?? "skills/")));
    if (fs.existsSync(lib.lockFile)) fs.watch(lib.lockFile, () => trigger("skills-lock.json"));
    await new Promise(() => undefined);
  }
}

function saveConfig(root: string, c: Choices): void {
  const saved: Config = { agents: c.agents.map((h) => h.id), global: c.global, dev: c.dev, projects: c.projects, mode: c.mode, wsl: c.wsl };
  if (c.unavailable.length) saved.unavailable = c.unavailable;
  writeConfig(root, saved);
}

async function decide(args: Args, cfg: Config, lib: Library, table: Harness[], cwd: string, interactive: boolean): Promise<Choices | null> {
  const found = detected(table);
  const byId = new Map(table.map((h) => [h.id, h]));
  let agentIds = args.agents ?? cfg.agents ?? found.map((h) => h.id);
  let global = args.global ?? cfg.global ?? true;
  const here = path.resolve(cwd);
  let dev = args.dev ? path.resolve(args.dev) : cfg.dev ?? (isRepo(here) && !looksLikeLibrary(here) ? path.dirname(here) : here);
  const offered = findProjects(dev, lib).map((pp) => path.basename(pp));
  let projectNames: string[] =
    args.projects === false ? [] : args.projects === "*" ? offered : args.projects ?? cfg.projects ?? (isRepo(here) && !looksLikeLibrary(here) && offered.includes(path.basename(here)) ? [path.basename(here)] : []);
  let mode: "link" | "copy" = args.copy ? "copy" : cfg.mode ?? "link";
  const distros = wslDistros();
  let wsl: string[] = args.wsl === false ? [] : args.wsl === "*" ? distros : args.wsl ?? cfg.wsl ?? [];

  const remembered = Object.keys(cfg).length > 0;
  if (interactive && (args.ask || !remembered || args.command === "projects")) {
    const agentsPick = await p.multiselect({
      message: "Harnesses to sync (checked = detected on this machine)",
      options: table.map((h) => ({ value: h.id, label: h.name, hint: found.includes(h) ? "detected" : "not found" })),
      initialValues: agentIds,
      required: true,
    });
    if (p.isCancel(agentsPick)) return null;
    agentIds = agentsPick as string[];

    const whereOptions = [{ value: "global", label: "User folders", hint: "every project on this machine" }];
    if (offered.length) whereOptions.push({ value: "projects", label: `Projects in ${dev}`, hint: `${offered.length} git repos` });
    const where = await p.multiselect({ message: "Where", options: whereOptions, initialValues: [global ? "global" : "", projectNames.length ? "projects" : ""].filter(Boolean), required: false });
    if (p.isCancel(where)) return null;
    global = (where as string[]).includes("global");
    if ((where as string[]).includes("projects")) {
      const pick = await p.multiselect({ message: "Which projects (a = all/none in most terminals: use space)", options: offered.map((n) => ({ value: n, label: n })), initialValues: projectNames.length ? projectNames : offered, required: false });
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

async function runOnce(lib: Library, c: Choices, args: Args, cwd: string): Promise<void> {
  const log = (m: string) => (args.json ? undefined : process.stderr.write(m + "\n"));
  const report = new Report();
  const missing = lib.missingFromLock().filter((n) => !c.unavailable.includes(n));
  if (args.restore && args.command !== "projects" && missing.length && !args.plan) {
    const r = lib.restore(log, missing);
    log(`restored ${r.restored.length} skill(s) from skills-lock.json`);
    for (const m of r.moved) log(`  moved upstream: ${m}`);
    for (const m of r.missing) log(`  gone upstream: ${m}`);
    if (r.missing.length) log(`  (npx skills remove <name> drops it from the lock; a copy in skills/ keeps it as your own; --retry checks again)`);
    for (const m of r.failed) log(`  failed: ${m}`);
    c.unavailable = [...new Set([...c.unavailable, ...r.missing.map((m) => m.split(":")[0])])];
    saveConfig(lib.root, c);
  } else if (missing.length) log(`${missing.length} lock entries are not installed yet (run without --plan or --no-restore to restore them)`);
  if (c.unavailable.length) log(`${c.unavailable.length} lock entr${c.unavailable.length === 1 ? "y is" : "ies are"} gone upstream (${c.unavailable.join(", ")}); --retry to check again`);

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
  if (c.wsl.length && args.command !== "projects") {
    for (const d of c.wsl) {
      const r = runInWsl(d, lib.root, [], args.plan);
      log(`WSL ${d}: ${r.ok ? "ok" : "failed"}${r.output ? "\n  " + r.output.split("\n").slice(-3).join("\n  ") : ""}`);
    }
  }
  void cwd;
}

function printReport(r: Report, args: Args): void {
  if (args.json) {
    process.stdout.write(JSON.stringify({ plan: args.plan, actions: r.actions }, null, 2) + "\n");
    return;
  }
  for (const a of r.actions) if (a.kind !== "skip") process.stdout.write(line(a) + "\n");
  const verb = args.plan ? "would change" : "changed";
  process.stdout.write(`${args.plan ? "plan: " : ""}${r.changes().length} ${verb}, ${r.skips()} already right, ${r.conflicts().length} left alone\n`);
}

function printStatus(lib: Library, table: Harness[], json: boolean): void {
  const s = status(lib, table);
  if (json) {
    process.stdout.write(JSON.stringify(s, null, 2) + "\n");
    return;
  }
  process.stdout.write(`library ${s.library}: ${s.own.length} own, ${s.thirdParty.length} third-party, ${s.missingFromLock.length} in the lock but not installed\n`);
  for (const [layer, v] of Object.entries(s.layers)) process.stdout.write(`${layer}: ${v.linked} linked, ${v.missing.length} missing\n`);
  for (const [dir, v] of Object.entries(s.user)) process.stdout.write(`${dir}: ${v.linked} linked, ${v.missing.length} missing\n`);
}

main().catch((e) => bail(String(e?.stack ?? e)));
