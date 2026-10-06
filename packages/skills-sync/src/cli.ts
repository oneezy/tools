#!/usr/bin/env node
// skills-sync: one skills library, every harness, every project on the machine. One command that works out where it is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { addSource } from "./add.js";
import { build } from "./build.js";
import { check } from "./check.js";
import { LOCAL_NAME, migrateAnswers, readLocal, writeLocal, type LinkMode, type Local } from "./config.js";
import { gitExclude, isDir, isLink, lexists, linkMode, linkTarget, real, samePath, setLinkMode } from "./fs.js";
import { detected, harnessTable, type Harness } from "./harnesses.js";
import { cloneLibrary, DEFAULT_LIBRARY, findLibrary, homeLibrary, Library, looksLikeLibrary, pullLibrary } from "./library.js";
import { apply, line, Report } from "./plan.js";
import { refresh, type Position, type RefreshResult } from "./refresh.js";
import { readLock } from "./lock.js";
import { cloneUrl, cmp, configText, readConfig } from "./sources.js";
import { discard } from "./stage.js";
import { findProjects, home, isRepo, layers, projects, status, unlink, type Status } from "./steps.js";
import { releasesOf, versionLabel } from "./versions.js";
import { runInWsl, wslDistros } from "./wsl.js";

const VERSION = "0.5.0";
const HELP = `skills-sync ${VERSION}
One skills library, every harness, every project on this machine. Run it anywhere; it works out the rest.

  no library on this machine   clone one into ~/.skills-sync (default: ${DEFAULT_LIBRARY}, or --library owner/repo)
  library present              pull it, install the third-party skills its lock records, rebuild its layers, link the user folders

Usage: skills-sync [command] [options]

Commands
  sync (default)   everything above; nothing moves upstream: with skills-sync.json every third-party skill is installed
                   at the commit the lock records (frozen, the lock never written); without one, skills-lock.json is restored
  status           what is linked and what is missing
  unlink           remove every link this tool made in the user folders
  projects         only the project step
  update [<source>...]
                   resolve the named sources (every one when none is named) at the tip of their ref, or at the version
                   skills-sync.json holds them at (a pinned skill at its pin), and their upstream version (release tag,
                   else plugin or package manifest): snapshot under upstream/, rebuild the third-party working set, write
                   skills-sync.lock.json (a skills-lock.json from 0.4.0 is migrated). A source not named keeps its lock
                   entry exactly. Reports each source that moved, from and to (version, commit, commits past it), and
                   the sections of its upstream CHANGELOG.md between the two versions (a downgrade: the ones it undoes).
                   Never writes skills-sync.json
  refresh          the same as update (kept for scripts and CI); refresh --frozen installs the lock as it is
  versions <source>
                   the versions a source has released, newest first, the one the lock is at marked (--json)
  add <source>     declare a source (owner/repo[#ref], a git URL or a path) and the plugin that packages it in
                   skills-sync.json, then refresh
  build            write the plugin form into the library when skills-sync.json has generate.plugins on: --plugins and
                   --catalogs pick the committed outputs (both when neither is named), --artifacts writes the upload
                   archives; --check diffs instead of writing
  check            is what is committed consistent? every own skill's frontmatter (name is its folder's name and a
                   valid id, description present), every skill under skills/play/ named play-<name>, every flow.yaml
                   beside one (schemas/flow.schema.json, unique step ids, after/parallel/join naming steps that exist),
                   and generated-file drift (what build --check computes, plus skills-sync.lock.json against the snapshots).
                   One line per problem, path then reason; exit 1 on any, 0 when clean. Reads only: no network,
                   nothing written (CI, and before committing)

Build
  --plugins              plugins/<id>/ for every plugin in the config: the skill copies, plugin.json,
                         .codex-plugin/plugin.json, .claude-plugin/plugin.json, LICENSE, NOTICE.md. Every copied SKILL.md
                         is marked metadata.internal: true, so npx skills installs each own skill once, from skills/
                         (INSTALL_INTERNAL_SKILLS=1 re-exposes the copies). A package is versioned 0.<n>.0+<sha12>:
                         it keeps its version while its files do, and a change takes the next n (1 for a new package)
                         with the library HEAD's sha; n never comes from git history, so it never goes backwards
  --catalogs             .claude-plugin/marketplace.json and .agents/plugins/marketplace.json, listing ./plugins/<id>
  --artifacts            artifacts/<id>-<version>.zip per plugin for the ChatGPT upload (stored, fixed timestamps, sorted:
                         the same input gives the same bytes), artifacts/releases.json (archive, sha256, version, source
                         commit, files, the release the config records), and artifacts/<id>.changes.md when that
                         release holds a file the archive lacks (upload as a new plugin, not an update)
  --check                compute every output in memory, print each path that differs from disk, write nothing;
                         exit 1 on drift or a package that cannot be built, 0 when clean (CI); never looks at artifacts/.
                         Needs no history: clean in a shallow clone, and after a squash merge left the build's commit behind

Update, refresh and add
  --to <version>|previous|latest
                         update <source> only: take that one source at a release (plain semver, 1.3.0), previous (the
                         highest stable release below the lock's version) or latest (the tip of ref, past a held version).
                         Prints the skills-sync.json change that makes it stick (sources.<id>.version = "1.3.0", or its
                         removal for latest) for the caller to land; never writes it. A version the source has not
                         released is refused with the ones it has, and nothing is written
  --frozen               every skill at the commit skills-sync.lock.json records; nothing moves, the lock is not written (CI)
  --id <id>              add: the source id (default: owner-repo, or the repo's folder name)
  --root <path>          add: where the skill folders live in the repo (default: skills/ when it exists, else the root)
  --skills <names|*>     add: which skills to take (default: all)
  --as <old=new,...>     add: take a skill under another name (tdd=pstack-tdd)
  --plugin <id>          add: the plugin entry's id (default: the source id); --no-plugin declares none

Options
  --repo <path>          the skills library (default: $SKILLS_REPO, ~/.skills-sync, a library folder above here)
  --library <src>        what to clone when there is no library yet (owner/repo or URL; default ${DEFAULT_LIBRARY})
  --agents <ids>         harnesses: claude-code,codex,goose,hermes (default: detected)
  --global / --no-global link into the harnesses' user skills folders (default: yes)
  --projects <names|*>   repos under --dev to sync; "*" for all; --no-projects for none
  --dev <dir>            folder whose git repos are offered (default: here, or the parent when here is a repo)
  --copy                 projects get real copies instead of links
  --wsl <distros|*>      Windows: also sync the user folders inside these WSL distros; --no-wsl for none
  --symlinks             make directory symlinks only (default: a symlink, or a junction when Windows refuses one)
  --junctions            Windows: make junctions only; either flag is remembered in ${LOCAL_NAME}
  --no-pull / --pull     skip, or force, the library pull (default: at most every 30 minutes)
  --no-restore           do not restore missing lock entries from their sources (skips the refresh too)
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

Answers for this machine (harnesses, projects, WSL distros, link mode) are kept in ${LOCAL_NAME} beside the config.
`;

interface Args {
  command: string;
  /** what follows the command: the source for add, the sources for update, the source for versions */
  positional: string[];
  frozen: boolean;
  /** update: a plain version, previous or latest, for the one source named */
  to?: string;
  id?: string;
  root?: string;
  skills?: string[] | "*";
  as: Record<string, string>;
  /** add: the plugin entry's id; false for --no-plugin */
  plugin?: string | false;
  /** build: which outputs; all when none is set */
  plugins: boolean;
  catalogs: boolean;
  artifacts: boolean;
  /** build: diff in memory, write nothing, exit 1 on drift */
  check: boolean;
  repo?: string;
  library?: string;
  agents?: string[];
  global?: boolean;
  projects?: string[] | "*" | false;
  dev?: string;
  copy?: boolean;
  wsl?: string[] | "*" | false;
  /** --symlinks or --junctions; remembered in the local file */
  links?: LinkMode;
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
  const a: Args = { command: "sync", positional: [], frozen: false, as: {}, plugins: false, catalogs: false, artifacts: false, check: false, pull: true, restore: true, retry: false, sidecars: false, layers: true, watch: false, plan: false, quiet: false, json: false, yes: false, ask: false };
  const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i];
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (x === "--frozen") a.frozen = true;
    else if (x === "--to") a.to = next();
    else if (x === "--id") a.id = next();
    else if (x === "--root") a.root = next();
    else if (x === "--plugin") a.plugin = next();
    else if (x === "--no-plugin") a.plugin = false;
    else if (x === "--skills") {
      const v = next();
      a.skills = v === "*" ? "*" : list(v);
    } else if (x === "--as") {
      for (const pair of list(next())) {
        const [from, to] = pair.split("=");
        if (!from || !to) bail(`--as takes old=new pairs, not ${pair}`);
        a.as[from] = to;
      }
    } else if (x === "--plugins") a.plugins = true;
    else if (x === "--catalogs") a.catalogs = true;
    else if (x === "--artifacts") a.artifacts = true;
    else if (x === "--check") a.check = true;
    else if (x === "--repo") a.repo = next();
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
    else if (x === "--symlinks") a.links = "symlink";
    else if (x === "--junctions") a.links = "junction";
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
  links: LinkMode;
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
  // check reads what is there: it never clones a library to have one to check
  if (!root && !args.plan && args.command !== "check") {
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
  // the first add is how a library gets its config: with --repo, skills/ alone is enough for it
  const firstAdd = args.command === "add" && !!args.repo && !!root && isDir(path.join(root, "skills"));
  if (!root || (!looksLikeLibrary(root) && !firstAdd)) bail("no skills library found: run this inside one, or pass --repo <path> or --library owner/repo");
  const lib = new Library(root);

  // 2. this machine's answers: the local file, after a 0.2.0 answers file is moved there once; status only reads
  if (!args.plan && args.command !== "status" && args.command !== "check") migrateAnswers(lib.root, setup);
  apply(setup, args.plan);
  const local = readLocal(lib.root);
  setLinkMode(args.links ?? local.links ?? "auto");

  // check reads the library it is pointed at; refresh, add and build edit it and nothing else: no pull, no ~/.skills-sync, no harness
  if (args.command === "check") return runCheck(lib, args);
  if (args.command === "update" || args.command === "refresh") return runUpdate(lib, args, log, setup);
  if (args.command === "versions") return runVersions(lib, args, log);
  if (args.command === "add") return runAdd(lib, args, log, setup);
  if (args.command === "build") return runBuild(lib, args, log, setup);

  // ~/.skills-sync points at the library from now on, so every later run finds it from anywhere
  const hl = homeLibrary(userHome);
  const remember = new Report();
  if (!samePath(real(hl), lib.root)) {
    if (!lexists(hl)) remember.add({ kind: "link", path: hl, target: lib.root, note: "remembers where the library is" });
    else if (isLink(hl)) remember.add({ kind: "relink", path: hl, target: lib.root, note: `was ${linkTarget(hl)}` });
    else remember.add({ kind: "conflict", path: hl, note: "a folder is in the way; ~/.skills-sync is not a link to the library" });
  }
  apply(remember, args.plan);
  setup.merge(remember);

  // 3. keep the library current: the pull, at most every 30 minutes; --pull forces it, --no-pull skips it. Nothing
  //    moves upstream here: the refresh that follows is frozen at the lock the library commits. A lock moved on this
  //    machine (a refresh run here, or an older version's sync) never blocks the pull: the pull puts it back at HEAD
  if (args.pull && args.command !== "status" && !args.plan) {
    if (args.pull === "force") {
      try {
        fs.unlinkSync(path.join(lib.root, ".git", "skills-sync-pulled"));
      } catch {
        /* nothing to reset */
      }
    }
    const r = pullLibrary(lib.root, 30, log, lib.hasConfig() ? [path.basename(lib.lockFile), path.basename(lib.npxLockFile)] : []);
    if (r === "pulled" && !args.quiet) log("library pulled");
    if (r === "dirty" && !args.quiet) log("library has local changes; pull skipped");
  }

  const table = harnessTable();

  if (args.command === "status") {
    const ids = args.agents ?? local.agents;
    return printStatus(lib, ids ? table.filter((h) => ids.includes(h.id)) : detected(table), args.json);
  }
  if (args.command === "unlink") {
    const r = new Report();
    unlink(lib, table, r);
    apply(r, args.plan);
    return printReport(r, args);
  }

  // 4. the choices: flags, then remembered answers, then defaults; prompts fill the gaps when interactive
  const choices = await decide(args, local, lib, table, cwd, interactive);
  if (!choices) return p.cancel("nothing changed");
  if (!args.plan) saveLocal(lib.root, choices);

  // 5. run
  await runOnce(lib, choices, args, cwd, setup);
  if (args.watch) {
    log(`watching ${lib.own}, ${path.basename(lib.configFile)} and ${path.basename(lib.lockFile)}; ctrl-c to stop`);
    let timer: NodeJS.Timeout | null = null;
    const trigger = (why: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        log(`change in ${why}`);
        runOnce(lib, choices, { ...args, restore: false }, cwd, new Report()).catch((e) => log(String(e)));
      }, 400);
    };
    fs.watch(lib.own, { recursive: true }, (_e, f) => trigger(String(f ?? "skills/")));
    for (const f of [lib.lockFile, lib.npxLockFile, lib.configFile]) if (fs.existsSync(f)) fs.watch(f, () => trigger(path.basename(f)));
    await new Promise(() => undefined);
  }
}

/**
 * update (refresh is the same command): the named sources (every one when none is named) at the tip of their ref, pins
 * and --frozen excepted; every other source stays at the lock. Gone-upstream skills are remembered like restore's.
 */
function runUpdate(lib: Library, args: Args, log: (m: string) => void, report: Report): void {
  if (!lib.hasConfig()) bail(`no ${path.basename(lib.configFile)} in ${lib.root}; add <source> writes one`);
  const ids = Object.keys(readConfig(lib.configFile).sources).sort(cmp);
  const unknown = args.positional.filter((n) => !ids.includes(n));
  if (unknown.length) bail(`${args.command}: no source ${unknown.join(", ")} in ${path.basename(lib.configFile)} (sources: ${ids.join(", ") || "none"})`);
  const local = readLocal(lib.root);
  const unavailable = args.retry ? [] : local.unavailable ?? [];
  const only = args.positional.length ? [...new Set(args.positional)] : undefined;
  if (args.to !== undefined && only?.length !== 1) bail(`${args.command} --to: name the one source it moves (${args.command} <source> --to ${args.to || "<version>|previous|latest"})`);
  if (args.to !== undefined && args.frozen) bail(`${args.command}: --to and --frozen do not go together`);
  const to = args.to !== undefined ? { [only![0]]: args.to } : undefined;
  const r = refresh(lib, { frozen: args.frozen, only, to, plan: args.plan, unavailable, log });
  if (r.refused) {
    if (args.json) process.stdout.write(JSON.stringify({ plan: args.plan, refused: r.refused }, null, 2) + "\n");
    else process.stderr.write(`${args.command}: ${r.refused}; nothing written\n`);
    process.exitCode = 1;
    return;
  }
  reportRefresh(lib, r, unavailable, args, log, !args.quiet);
  report.merge(r.report);
  printReport(report, args, { sources: r.sources, updated: r.updated, config: r.config, gone: r.gone, unlocked: r.unlocked, problems: r.problems });
  if (!args.json) {
    const at = (x: Position) => `${x.version === null ? "" : `${x.ahead ? `${x.version} (+${x.ahead} commit${x.ahead === 1 ? "" : "s"})` : x.version} `}${x.commit.slice(0, 7)}`;
    for (const u of r.updated) {
      process.stdout.write(`updated ${u.id}: ${u.from ? at(u.from) : "(new)"} -> ${at(u.to)}\n`);
      const [low, high] = u.direction === "upgrade" ? [u.from, u.to] : [u.to, u.from];
      if (u.changelog === null) process.stdout.write(`  changelog: none (${u.changelogReason})\n`);
      else process.stdout.write(`  ${u.direction === "upgrade" ? "changelog" : "undoes the changelog"} after ${low!.version} up to ${high!.version}:\n${u.changelog.replace(/\n$/, "").split("\n").map((l) => (l ? `    ${l}\n` : "\n")).join("")}`);
    }
    const file = path.basename(lib.configFile);
    for (const c of r.config) process.stdout.write(c.version === null ? `${file}: remove sources.${c.source}.version (follow latest); land this change, skills-sync never writes it\n` : `${file}: sources.${c.source}.version = "${c.version}"; land this change, skills-sync never writes it\n`);
  }
  if (r.problems.length) process.exitCode = 1;
}

/**
 * The refresh's lines that are not file actions, and the remembered gone-upstream list, shared by refresh and sync.
 * `verbose` names every source's commit; otherwise only one that moved, so a sync with nothing new says nothing.
 */
function reportRefresh(lib: Library, r: RefreshResult, unavailable: string[], args: Args, log: (m: string) => void, verbose: boolean): string[] {
  for (const [id, s] of Object.entries(r.sources)) if (s.moved || verbose) log(`${id}: ${versionLabel(s)}${s.moved ? ", moved" : ""}`);
  for (const g of r.gone) log(`  gone upstream: ${g}`);
  if (r.gone.length) log(`  (not in the lock; deselect it in ${path.basename(lib.configFile)}, or a copy in skills/ keeps it as your own; --retry checks again)`);
  if (r.unlocked.length && !args.quiet) log(`${r.unlocked.length} selected skill(s) have no commit in ${path.basename(lib.lockFile)} (${r.unlocked.join(", ")}); run update to resolve them`);
  for (const m of r.problems) log(`failed: ${m}`);
  const gone = r.gone.map((g) => g.split(":")[1]);
  const remembered = [...new Set([...unavailable, ...gone])];
  if (remembered.length && !args.quiet) log(`${remembered.length} selected skill${remembered.length === 1 ? " is" : "s are"} gone upstream (${remembered.join(", ")}); --retry to check again`);
  if (!args.plan) {
    const local = readLocal(lib.root);
    const next: Local = { ...local, unavailable: remembered };
    if (!remembered.length) delete next.unavailable;
    if (JSON.stringify(next) !== JSON.stringify(local)) writeLocal(lib.root, next);
  }
  return remembered;
}

/** versions: the releases of one source, highest first, the one the lock is at marked; reads only (a temp clone). */
function runVersions(lib: Library, args: Args, log: (m: string) => void): void {
  if (!lib.hasConfig()) bail(`no ${path.basename(lib.configFile)} in ${lib.root}; add <source> writes one`);
  const config = readConfig(lib.configFile);
  const ids = Object.keys(config.sources).sort(cmp);
  const id = args.positional[0];
  if (!id || !config.sources[id]) bail(`versions: ${id ? `no source ${id}` : "which source?"} in ${path.basename(lib.configFile)} (sources: ${ids.join(", ") || "none"})`);
  const src = config.sources[id];
  const locked = readLock(lib.root, config)?.sources[id];
  const prior = locked?.repo === src.repo ? locked : undefined;
  const r = releasesOf(cloneUrl(src.repo), src.ref, src.root, prior?.commit ?? null, log);
  if (!r.ok) bail(`versions: ${id}: ${r.error}`);
  const current: Position | null = prior ? { version: prior.version, commit: prior.commit, ahead: r.current?.version === prior.version ? r.current.ahead : null } : null;
  const versions = r.releases.map((x) => ({ ...x, current: !!current && x.version === current.version }));
  if (args.json) {
    process.stdout.write(JSON.stringify({ source: id, repo: src.repo, ref: src.ref, current, versions }, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${id}: ${src.repo}@${src.ref}, ${versions.length} version${versions.length === 1 ? "" : "s"}, newest first${src.version ? `; held at ${src.version} in ${path.basename(lib.configFile)}` : ""}\n`);
  for (const v of versions) process.stdout.write(`${v.current ? "*" : " "} ${v.version.padEnd(12)} ${v.commit.slice(0, 7)}  ${v.date.slice(0, 10)}${v.current ? `  current${current!.ahead ? ` (+${current!.ahead} commit${current!.ahead === 1 ? "" : "s"})` : ""}` : ""}\n`);
  if (!versions.length) process.stdout.write("  no release tag and no manifest version\n");
  if (current && !versions.some((v) => v.current)) process.stdout.write(`  the lock is at ${current.version ?? "no version"} ${current.commit.slice(0, 7)}\n`);
}

/** add: stage the source, write its config entry, then refresh with the staged clone. --plan shows the entry and writes nothing. */
function runAdd(lib: Library, args: Args, log: (m: string) => void, report: Report): void {
  const spec = args.positional[0];
  if (!spec) bail("add: which source? owner/repo[#ref], a git URL or a local path");
  const r = addSource(lib, spec, { id: args.id, root: args.root, skills: args.skills, as: args.as, plugin: args.plugin, log });
  if (!r.ok) bail(r.error);
  const names = Object.keys(r.entry.skills).length;
  const renames = Array.isArray(r.entry.skills) ? [] : Object.entries(r.entry.skills).filter(([a, b]) => a !== b);
  log(`${r.id}: ${r.entry.repo}@${r.entry.ref} (${r.staged.commit.slice(0, 7)}), ${names} of ${r.found.size} skills under ${r.entry.root ?? "the root"}${renames.length ? `, renaming ${renames.map(([a, b]) => `${a} -> ${b}`).join(", ")}` : ""}`);
  if (args.plan) {
    discard(r.staged);
    process.stdout.write(`plan: would add to ${lib.configFile}:\n${JSON.stringify({ sources: { [r.id]: r.entry }, ...(r.plugin ? { plugins: { [r.plugin.id]: r.plugin.entry } } : {}) }, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(lib.configFile, configText(r.config));
  log(`wrote ${path.basename(lib.configFile)}${r.plugin ? `, with plugin ${r.plugin.id}; build --plugins --catalogs packages it` : ""}`);
  const local = readLocal(lib.root);
  const unavailable = args.retry ? [] : local.unavailable ?? [];
  const res = refresh(lib, { frozen: false, plan: false, unavailable, log, prestaged: { [r.id]: r.staged } });
  reportRefresh(lib, res, unavailable, args, log, !args.quiet);
  report.merge(res.report);
  printReport(report, args, { sources: res.sources, gone: res.gone, unlocked: res.unlocked, problems: res.problems });
  if (res.problems.length) process.exitCode = 1;
}

/**
 * build: the plugin form from skills-sync.json, every output computed in memory and written only where disk differs.
 * --check reports the differences instead and exits 1 when there are any; CI runs it on every push. A package that
 * cannot be built (a source not in the config or without a snapshot, a link inside the package) is a conflict: left
 * alone, exit 1 in both modes, listed as drift by --check. A group with no skill yet is skipped with a note. The committed form (packages
 * and catalogs) is what a build with no output named writes and what --check looks at; the archives under artifacts/
 * are written only when --artifacts asks, and never checked.
 */
function runBuild(lib: Library, args: Args, log: (m: string) => void, report: Report): void {
  if (!lib.hasConfig()) bail(`no ${path.basename(lib.configFile)} in ${lib.root}; add <source> writes one`);
  const none = !args.plugins && !args.catalogs && (args.check || !args.artifacts);
  const r = build(lib, { plugins: args.plugins || none, catalogs: args.catalogs || none, artifacts: args.artifacts, check: args.check, plan: args.plan, log });
  report.merge(r.report);
  if (r.off && !args.quiet) log(`generate.plugins is false in ${path.basename(lib.configFile)}: nothing built, nothing checked`);
  const conflicts = r.report.conflicts().length;
  if (!args.check) {
    printReport(report, args, { versions: r.versions });
    if (conflicts) process.exitCode = 1;
    return;
  }
  if (r.drift.length) process.exitCode = 1;
  if (args.json) return printReport(report, args, { check: true, drift: r.drift, versions: r.versions });
  for (const a of report.actions) if (a.kind === "note" || a.kind === "conflict") process.stdout.write(line(a) + "\n");
  for (const d of r.drift) process.stdout.write(`drift        ${d}\n`);
  const fix = conflicts ? `${conflicts} conflict(s) above to fix first, then build --plugins --catalogs` : "run build --plugins --catalogs";
  process.stdout.write(r.drift.length ? `build --check: ${r.drift.length} path(s) differ from what build would write; ${fix}\n` : `build --check: clean, ${report.skips()} files as built\n`);
}

/**
 * check: one line per problem (the file, then the rule it breaks) on stdout, exit 1 when there is any; a clean library
 * gets one summary line and exit 0. It writes nothing, in the library or outside it.
 */
function runCheck(lib: Library, args: Args): void {
  const r = check(lib);
  if (r.problems.length) process.exitCode = 1;
  if (args.json) {
    process.stdout.write(JSON.stringify({ check: true, problems: r.problems, notes: r.notes, skills: r.skills, flows: r.flows, generated: r.generated }, null, 2) + "\n");
    return;
  }
  for (const p of r.problems) process.stdout.write(`${p.path}: ${p.reason}\n`);
  if (!args.quiet) for (const n of r.notes) process.stdout.write(`note: ${n.path}: ${n.reason}\n`);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (r.problems.length) process.stdout.write(`check: ${[count(r.problems.length, "problem"), ...r.fixes].join("; ")}\n`);
  else if (!args.quiet) process.stdout.write(`check: clean, ${count(r.skills, "own skill")}, ${count(r.flows, "flow")}, ${count(r.generated, "generated file")} as built\n`);
}

function saveLocal(root: string, c: Choices): void {
  const saved: Local = { agents: c.agents.map((h) => h.id), global: c.global, dev: c.dev, projects: c.projects, mode: c.mode, wsl: c.wsl, links: c.links };
  if (c.unavailable.length) saved.unavailable = c.unavailable;
  writeLocal(root, saved);
}

async function decide(args: Args, local: Local, lib: Library, table: Harness[], cwd: string, interactive: boolean): Promise<Choices | null> {
  const found = detected(table);
  const byId = new Map(table.map((h) => [h.id, h]));
  // first run with nothing remembered: only the two harnesses this tool is built around, unless asked
  let agentIds = args.agents ?? local.agents ?? found.filter((h) => h.id === "claude-code" || h.id === "codex").map((h) => h.id);
  let global = args.global ?? local.global ?? true;
  const here = path.resolve(cwd);
  let dev = args.dev ? path.resolve(args.dev) : local.dev ?? (isRepo(here) && !looksLikeLibrary(here) ? path.dirname(here) : here);
  const offered = findProjects(dev, lib).map((pp) => path.basename(pp));
  let projectNames: string[] = args.projects === false ? [] : args.projects === "*" ? offered : args.projects ?? local.projects ?? [];
  let mode: "link" | "copy" = args.copy ? "copy" : local.mode ?? "link";
  const distros = args.quiet ? [] : wslDistros();
  let wsl: string[] = args.wsl === false ? [] : args.wsl === "*" ? distros : args.wsl ?? local.wsl ?? [];

  const remembered = Object.keys(local).length > 0;
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
  return { agents, global, dev, projects: projectNames, mode, wsl, unavailable: args.retry ? [] : local.unavailable ?? [], links: args.links ?? local.links ?? "auto" };
}

/** One pass over the steps. A config library's refresh is always frozen: every third-party skill at the lock's commit. */
async function runOnce(lib: Library, c: Choices, args: Args, cwd: string, report: Report): Promise<void> {
  const log = (m: string) => (args.json ? undefined : process.stderr.write(m + "\n"));

  const missing = lib.missingFromLock().filter((n) => !c.unavailable.includes(n));
  if (lib.hasConfig() && args.restore && args.command !== "projects" && !args.plan) {
    // a config library: the frozen refresh rebuilds the working set at the lock's commits and never writes the lock
    const r = refresh(lib, { frozen: true, plan: false, unavailable: c.unavailable, log });
    c.unavailable = reportRefresh(lib, r, c.unavailable, args, log, false);
    report.merge(r.report);
  } else if (lib.hasConfig() && missing.length) log(`${missing.length} lock entries are not installed yet (run without --plan or --no-restore for the refresh that restores them)`);
  else if (args.restore && args.command !== "projects" && missing.length && !args.plan) {
    const r = lib.restore(log, missing);
    log(`restored ${r.restored.length} skill(s) from skills-lock.json`);
    for (const m of r.moved) log(`  moved upstream: ${m}`);
    for (const m of r.missing) log(`  gone upstream: ${m}`);
    if (r.missing.length) log(`  (npx skills remove <name> drops it from the lock; a copy in skills/ keeps it as your own; --retry checks again)`);
    for (const m of r.failed) log(`  failed: ${m}`);
    c.unavailable = [...new Set([...c.unavailable, ...r.missing.map((m) => m.split(":")[0])])];
    saveLocal(lib.root, c);
  } else if (missing.length) log(`${missing.length} lock entries are not installed yet (run without --plan or --no-restore to restore them)`);
  if (c.unavailable.length && !args.quiet && !lib.hasConfig()) log(`${c.unavailable.length} lock entr${c.unavailable.length === 1 ? "y is" : "ies are"} gone upstream (${c.unavailable.join(", ")}); --retry to check again`);

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
    process.stdout.write(JSON.stringify({ plan: args.plan, actions, links: r.links, linkMode: linkMode(), ...extra }, null, 2) + "\n");
    return;
  }
  const changes = r.changes();
  const conflicts = r.conflicts();
  if (args.quiet && !changes.length && !conflicts.length) return;
  for (const a of r.actions) if (a.kind !== "skip") process.stdout.write(line(a) + "\n");
  if (r.links.symlink + r.links.junction) process.stdout.write(linksLine(r) + "\n");
  const verb = args.plan ? "would change" : "changed";
  process.stdout.write(`${args.plan ? "plan: " : ""}${changes.length} ${verb}, ${r.skips()} already right, ${conflicts.length} left alone\n`);
}

/** Which kind of link this run made, and why, when it made any. */
function linksLine(r: Report): string {
  const { symlink, junction } = r.links;
  const mode = linkMode();
  if (junction && !symlink) return `links: ${junction} made as junctions${mode === "auto" ? " (directory symlinks were refused: Developer Mode or elevation allows them; --junctions makes this the rule)" : " (--junctions)"}`;
  if (junction) return `links: ${symlink} made as symlinks, ${junction} as junctions (symlinks were refused part way)`;
  return `links: ${symlink} made as symlinks${mode === "symlink" ? " (--symlinks)" : ""}`;
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
