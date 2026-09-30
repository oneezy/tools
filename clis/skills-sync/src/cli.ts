#!/usr/bin/env node
// skills-sync: one skills library, every harness, every project on the machine. One command that works out where it is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { readConfig, writeConfig, type Config } from "./config.js";
import { gitExclude, isDir, isLink, lexists, linkTarget, real, samePath } from "./fs.js";
import { detected, harnessTable, type Harness } from "./harnesses.js";
import { cloneLibrary, DEFAULT_LIBRARY, findLibrary, homeLibrary, Library, looksLikeLibrary, pullLibrary } from "./library.js";
import { apply, line, Report } from "./plan.js";
import { findProjects, home, isRepo, layers, projects, status, unlink } from "./steps.js";
import { runInWsl, wslDistros } from "./wsl.js";

const VERSION = "0.2.0";
const HELP = `skills-sync ${VERSION}
One skills library, every harness, every project on this machine. Run it anywhere; it works out the rest.

  no library on this machine   clone one into ~/.skills-sync (default: ${DEFAULT_LIBRARY}, or --library owner/repo)
  library present              pull it, restore what the lock has, rebuild its layers, link the user folders

Usage: skills-sync [command] [options]

Commands
  sync (default)   everything above
  status           what is linked and what is missing
  unlink           remove every link this tool made in the user folders
  projects         only the project step

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
  --no-restore           do not restore missing lock entries from their sources
  --retry                retry lock entries an earlier run reported as gone upstream
  --no-sidecars          do not generate agents/openai.yaml for own skills
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
  const a: Args = { command: "sync", pull: true, restore: true, retry: false, sidecars: true, layers: true, watch: false, plan: false, quiet: false, json: false, yes: false, ask: false };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
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
    else if (x === "--no-sidecars") a.sidecars = false;
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
    } else a.command = x;
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
  if (!root || !looksLikeLibrary(root)) bail("no skills library found: run this inside one, or pass --repo <path> or --library owner/repo");
  const lib = new Library(root);

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
  if (c.unavailable.length && !args.quiet) log(`${c.unavailable.length} lock entr${c.unavailable.length === 1 ? "y is" : "ies are"} gone upstream (${c.unavailable.join(", ")}); --retry to check again`);

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

function printReport(r: Report, args: Args): void {
  if (args.json) {
    process.stdout.write(JSON.stringify({ plan: args.plan, actions: r.actions }, null, 2) + "\n");
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
  process.stdout.write(`library ${s.library}: ${s.own.length} own, ${s.thirdParty.length} third-party, ${s.missingFromLock.length} in the lock but not installed\n`);
  for (const [layer, v] of Object.entries(s.layers)) process.stdout.write(`${layer}: ${v.linked} linked, ${v.missing.length} missing\n`);
  for (const [dir, v] of Object.entries(s.user)) process.stdout.write(`${dir}: ${v.linked} linked, ${v.missing.length} missing\n`);
}


main().catch((e) => bail(String(e?.stack ?? e)));
