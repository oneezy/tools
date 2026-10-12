#!/usr/bin/env node
// skills-sync: one skills library, every harness on this machine. Two kinds of command. The machine commands (sync,
// status, branches, unlink) act on this machine against the latest release of the library on GitHub and keep nothing of
// their own here: no library clone, no answers file, nothing remembered between runs (ADR-0012; settings come from the
// release's skills-sync.json, machine facts are detected on every run). The library commands (update, refresh, versions,
// add, build, check, the brain and alias migrations) run inside a checkout of the library, named by --repo or found
// above the current folder, and keep every flag they had.
import fs from "node:fs";
import path from "node:path";
import { addSource } from "./add.js";
import { adoptBrain, rollbackBrain, brainLinks } from "./adoption.js";
import { aliasLinks, migrateAliases, rollbackAliases } from "./aliases.js";
import { build, type BuildResult } from "./build.js";
import { check, unusedReason } from "./check.js";
import { entrypoints } from "./entrypoints.js";
import { readLocal, writeLocal, type LinkMode, type Local } from "./config.js";
import { isDir, linkMode, real, samePath, setLinkMode } from "./fs.js";
import { runBranches } from "./commands/branches.js";
import { runHook } from "./commands/hook.js";
import { runStatus } from "./commands/status.js";
import { runSync, syncFacts } from "./commands/sync.js";
import { runUnlink } from "./commands/unlink.js";
import { harnessTable } from "./harnesses.js";
import { findLibrary, Library, looksLikeLibrary, verifyLibraryRevision } from "./library.js";
import { apply, line, Report } from "./plan.js";
import { byDirection, type Moved, type Position } from "./changelog.js";
import { refresh, type RefreshResult } from "./refresh.js";
import { DEFAULT_REPO, isRepoName } from "./release.js";
import { lockedSource, readLock } from "./lock.js";
import { cloneUrl, cmp, configText, readConfig, renamesOf } from "./sources.js";
import { discard } from "./stage.js";
import { VERSION } from "./version.js";
import { commitsPast, releasesOf, versionLabel } from "./versions.js";
import { runInWsl, wslDistros, type WslRun } from "./wsl.js";

const HELP = `skills-sync ${VERSION}
One skills library, every harness on this machine. Run it anywhere; it keeps nothing of its own here.

Machine commands act on this machine against the latest release of ${DEFAULT_REPO} on GitHub: no library clone, no
answers file, nothing remembered between runs. Settings come from the release's skills-sync.json; machine facts (the
harnesses, their plugins and links, the WSL distros) are detected on every run. They take --json, --quiet and
--library, and --plan where they would write (sync, unlink, branches; status only reads, hook refuses it); an older
flag is accepted, does nothing, and is named once on stderr; a word they do not expect is refused (exit 2).

Usage: skills-sync [command] [options]

Commands
  sync (default)   bring every detected harness to its one form (ADR-0007): Claude Code the account plugins claude.ai
                   delivers, Codex the library's plugins from GitHub, Hermes its plugins; and the skills block in each
                   harness's global instructions file (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md): the library's
                   SHARED.md at the release's commit, verbatim, its start marker stamped with the release and the
                   text's sha256 (a release without SHARED.md: the tool's built-in text). Before a file's content
                   changes it is copied beside itself (CLAUDE-backup-<UTC yyyymmdd-HHMMSS>.md, AGENTS-backup-...),
                   never over an earlier backup. GitHub or SHARED.md out of reach keeps a block already there as it
                   is and gives a missing one the built-in text: one line, not a conflict. HTTPS_PROXY and NO_PROXY
                   are honoured. Never a repository file; a block an older version left in one is reported,
                   as is the clone an older version kept at ~/.skills-sync. Outside the cloud
                   also one session-start hook entry per harness (~/.claude/settings.json, ~/.codex/hooks.json) running
                   \`npx --yes @oneezy/skills-sync@latest hook\`; other entries are never touched, the old sync-dev.sh
                   entry goes once the new one is in, Codex asks you to trust it once. In a cloud session
                   (CLAUDE_CODE_REMOTE=true) the block is the whole sync. On Windows the same sync runs inside every WSL
                   distro (through npx there; a distro without Node is one note, not a failure)
  status           is this machine done: against the latest release of ${DEFAULT_REPO} on GitHub (no library needed),
                   per harness its form, each plugin's version against the release, every skill name listed twice, the
                   session hook entry and the global block (current, stale: another text than the release's SHARED.md,
                   or hand-edited: its text no longer matches its stamp); then the checkouts of oneezy/skills and
                   oneezy/tools among the repositories the hook tends (on dev and clean, or not); then the manual
                   steps only you can take, step by step (a plugin to switch on at claude.ai, the Codex hook trust,
                   the cloud setup line). --json for scripts; exit 1 on any red line, never for a manual step alone.
                   Reads only: nothing cloned, linked or written
  branches [owner/repo ...]
                   the branch rules on GitHub (no library needed), for each repository named or, with none, every
                   repository the token owns: main, dev and any *-keep, research/* or prototype/* branch are never
                   deleted (nor the repository's default branch); a branch whose pull request was merged into dev (or
                   whose commits are all in dev) is deleted; one whose pull request was closed without merging is tagged
                   archive/<name> at its head, then deleted; every other branch is left alone and listed. Pull requests
                   are never touched: the head or the base of an open one stays. --plan lists every tag and delete
                   without making them; --json carries the same lists; a repository the token cannot read or write is
                   reported and skipped. Exit 1 when anything was reported, 2 without a token to list your repositories
  hook             what the session-start hook runs: the sync above, quietly (only what changed or went wrong is
                   printed), then every git repository in reach, whoever owns it: the current repository (its main
                   checkout, from a linked worktree) and the git repositories beside it, or outside any repository the
                   ones directly inside the current folder. One with a dev branch and an origin, on dev with a clean
                   tree, is fetched (15 s at most) and fast-forwarded to origin/dev; a dirty one or one on another
                   branch is named and left alone; one with no dev or no origin is not mentioned. Never a rebase, a
                   reset or a branch switch; six at a time, no fetch begins 90 s after the hook started. For the
                   session's own repository only, one line says which branches (counted from the fetch) and, for a
                   GitHub origin, which open pull requests (one GitHub request) are not in dev yet.
                   Takes no flags but --library (any other flag is refused, exit 2: the entry runs it bare).
                   Prints nothing when nothing changed; exit 0 unless the sync hit a conflict
  unlink           take away what this tool put on this machine, and only that: the plugins it installed from the
                   library's catalog (and the catalog's registration once none is left), its loose links in every
                   harness skills folder (to a library copy, or dangling), its session hook entry in each harness's user
                   hooks file, the skills block in each global instructions file (either file too when it held nothing
                   else; a file that keeps your text is backed up beside itself first, as sync does). Account plugins,
                   other marketplaces, real folders, other links, other hook entries, Codex's trust record and
                   repository files are never touched. Offline; exit 1 on a conflict. This machine only: on Windows
                   run it inside each WSL distro too (the sync there put a block and a hook entry)
  adopt-brain      explicitly adopt only this host's two historical Brain links; propagate verified instructions only
  rollback-brain   restore the exact preserved links in --receipt; refuse later destination edits
  migrate-aliases  back up only explicit historical Skills/Status aliases after verifying installed native replacements
  rollback-aliases restore unchanged aliases from --receipt; keep the installed plugins
  update [<source>...]
                   resolve the named sources (every one when none is named) at the tip of their ref, or at the version
                   skills-sync.json holds them at (a pinned skill at its pin), and their upstream version (release tag,
                   else plugin or package manifest): snapshot under upstream/, rebuild the third-party working set, write
                   skills-sync.lock.json (a skills-lock.json from 0.4.0 is migrated). A source not named keeps its lock
                   entry exactly. Reports each source that moved, from and to (version, commit, commits past it), and
                   the sections of its upstream CHANGELOG.md between the two versions (a downgrade: the ones it undoes).
                   A source that selects by a list or a map gets one "not selected upstream: <names>" line naming every
                   skill folder under its root it leaves out (also with --json and --quiet, \`unselected\` in --json, a
                   ::warning:: under GitHub Actions; never an exit code). "skills": "*" takes every one instead, except
                   a new name another source or an own skill already has: left out and named the same way
                   (\`shadowed\`). Under --json every conflict is printed on stderr too. A source with adapt rules
                   gets the same kind of warning for a forbid term the rules leave in new upstream text and for a
                   rule that matches nothing upstream now (\`forbidden\`, \`unusedRules\` in --json).
                   Never writes skills-sync.json
  refresh          the same as update (kept for scripts and CI); refresh --frozen installs the lock as it is
  versions <source>
                   the versions a source has released, newest first, the one the lock is at marked (--json)
  add <source>     declare a source (owner/repo[#ref], a git URL or a path) and the plugin that packages it in
                   skills-sync.json, then update that one source (every other one stays at the lock)
  build            write the plugin form into the library when skills-sync.json has generate.plugins on: --plugins and
                   --catalogs pick the committed outputs (both when neither is named), --artifacts writes the upload
                   archives; --check diffs instead of writing. A source's adapt rules (find/replace, in order) are
                   applied to the Markdown and text files of its skills as they are copied (never a script, the
                   snapshot or the working set); a forbid term left after them is a "forbidden <path>:<line>" line and
                   fails --check; a rule that matches nothing is a note
  check            is what is committed consistent? every own skill's frontmatter (name is its folder's name and a
                   valid id, description present), every skill under skills/play/ named play-<name>, every flow.yaml
                   beside one (schemas/flow.schema.json, unique step ids, after/parallel/join naming steps that exist),
                   and generated-file drift (what build --check computes, plus skills-sync.lock.json against the snapshots,
                   and a version skills-sync.json holds a source at that the lock does not have), and every forbid term
                   a source's adapt rules leave in a package file (file, line, term; an allow pattern accepts a line);
                   an adapt rule that matches nothing is a note.
                   One line per problem, path then reason; exit 1 on any, 0 when clean. Reads only: no network,
                   nothing written (CI, and before committing)

Build
  --plugins              plugins/<id>/ for every plugin in the config: the skill copies, plugin.json,
                         .codex-plugin/plugin.json, .claude-plugin/plugin.json, LICENSE, NOTICE.md. Every copied SKILL.md
                         is marked metadata.internal: true, so npx skills installs each own skill once, from skills/
                         (INSTALL_INTERNAL_SKILLS=1 re-exposes the copies). A source package uses its locked upstream version;
                         unversioned sources omit it. Own packages use the explicit library.version unchanged.
                         Builds never bump a version or append a commit hash; release policy owns authored bumps
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
  --retry                look again for skills an earlier run reported gone upstream
  --id <id>              add: the source id (default: owner-repo, or the repo's folder name)
  --root <path>          add: where the skill folders live in the repo (default: skills/ when it exists, else the root)
  --skills <names|*>     add: which skills to take (default: all found now, as a list); * writes "skills": "*", every
                         skill under the root now and every one upstream adds later
  --as <old=new,...>     add: take a skill under another name (tdd=pstack-tdd); with --skills * it is the "rename" map
  --plugin <id>          add: the plugin entry's id (default: the source id); --no-plugin declares none

Options
  --plan                 show what would change, touch nothing: sync, unlink, branches and the library commands
  --quiet                for scripts: print only changes and problems
  --json                 machine output
  --library <owner/repo> machine commands: the release repo to read (default ${DEFAULT_REPO})
  --repo <path>          library commands: the skills library checkout (default: $SKILLS_REPO, else a library folder
                         above here). Never cloned: a machine command needs no library
  --adoption-file <json> version 1 manifest of exact historical Brain paths and expectedTarget values
  --alias-file <json>    version 1 manifest of exact historical Skills/Status alias paths and expectedTarget values
  --receipt <path>       durable adoption/rollback receipt (required for scoped Brain commands)
  --expect-revision <sha> verify library HEAD and origin's --remote-ref before any instruction rollout
  --remote-ref <ref>     exact remote branch/tag for that verification (default refs/heads/main)
  --no-entrypoints       adopt-brain: skip the library's managed instruction blocks
  --symlinks             library commands: make directory symlinks only (default: a symlink, or a junction when Windows
                         refuses one)
  --junctions            library commands, Windows: make junctions only
  -h, --help

Older flags (-y, --agents, --global, --no-projects, --no-wsl, --links, --plugins, --no-pull, --no-remember, --watch,
--ask, ...) are accepted on a machine command (hook excepted: it takes no flags but --library), do nothing there, and
are named in one line on stderr. The projects command is retired: nothing links skills into projects any more
(ADR-0007).
`;

/** The machine commands: against GitHub, nothing of their own on the machine (hook is what the session hook entry runs). */
const MACHINE_COMMANDS = new Set(["sync", "status", "hook", "branches", "unlink"]);
/** The library commands: inside a checkout. */
const LIBRARY_COMMANDS = new Set([
  "update",
  "refresh",
  "versions",
  "add",
  "build",
  "check",
  "adopt-brain",
  "rollback-brain",
  "migrate-aliases",
  "rollback-aliases",
]);
/** Retired commands: one line saying what replaced each. */
const RETIRED: Record<string, string> = {
  projects:
    "projects: retired; nothing links skills into projects any more (ADR-0007), every harness reads its own plugins or user folder: run sync",
};

interface Args {
  command: string;
  /** what follows the command: the source for add, the sources for update, the source for versions, the repos for branches */
  positional: string[];
  /** every flag given that a machine command ignores (any but --plan, --json, --quiet, --library), as spelled, once, in order */
  given: string[];
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
  adoptionFile?: string;
  aliasFile?: string;
  receipt?: string;
  expectRevision?: string;
  remoteRef?: string;
  /** --symlinks or --junctions, for the links a library command makes in the checkout */
  links?: LinkMode;
  retry: boolean;
  /** adopt-brain: the library's managed instruction blocks too (--no-entrypoints skips them) */
  entrypoints: boolean;
  plan: boolean;
  quiet: boolean;
  json: boolean;
}

/** Older flags that take a value: accepted and skipped with it. */
const OLD_VALUED = new Set(["--agents", "--projects", "--dev", "--wsl"]);
/** Older flags without a value: accepted and ignored. */
const OLD_BARE = new Set([
  "--links",
  "--global",
  "--no-global",
  "--no-projects",
  "--copy",
  "--no-wsl",
  "--no-pull",
  "--pull",
  "--no-restore",
  "--sidecars",
  "--no-layers",
  "--no-remember",
  "--watch",
  "-y",
  "--yes",
  "--ask",
]);

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: "sync",
    positional: [],
    given: [],
    frozen: false,
    as: {},
    plugins: false,
    catalogs: false,
    artifacts: false,
    check: false,
    retry: false,
    entrypoints: true,
    plan: false,
    quiet: false,
    json: false,
  };
  const list = (v: string) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => argv[++i] ?? "";
    // a machine command names every flag but these four as ignored, once, in the order given
    if (x.startsWith("-") && !["--plan", "--json", "--quiet", "--library", "-h", "--help"].includes(x))
      if (!a.given.includes(x)) a.given.push(x);
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (x === "--plan") a.plan = true;
    else if (x === "--quiet") a.quiet = true;
    else if (x === "--json") a.json = true;
    else if (x === "--library") a.library = next();
    else if (x === "--frozen") a.frozen = true;
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
    else if (x === "--adoption-file") a.adoptionFile = next();
    else if (x === "--alias-file") a.aliasFile = next();
    else if (x === "--receipt") a.receipt = next();
    else if (x === "--expect-revision") a.expectRevision = next();
    else if (x === "--remote-ref") a.remoteRef = next();
    else if (x === "--symlinks") a.links = "symlink";
    else if (x === "--junctions") a.links = "junction";
    else if (x === "--retry") a.retry = true;
    else if (x === "--no-entrypoints") a.entrypoints = false;
    else if (OLD_VALUED.has(x)) next();
    else if (OLD_BARE.has(x)) {
      /* accepted; nothing to set */
    } else if (x.startsWith("-")) {
      process.stderr.write(`unknown option ${x}\n${HELP}`);
      process.exit(2);
    } else if (command === null) command = a.command = x;
    else a.positional.push(x);
  }
  return a;
}

function bail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (RETIRED[args.command]) {
    process.stderr.write(RETIRED[args.command] + "\n");
    process.exit(2);
  }
  if (MACHINE_COMMANDS.has(args.command)) return machineCommand(args);
  if (LIBRARY_COMMANDS.has(args.command)) return libraryCommand(args);
  process.stderr.write(`unknown command ${args.command}\n${HELP}`);
  process.exit(2);
}

/**
 * A machine command: dispatched before anything looks for a library, a clone, ~/.skills-sync, a local file or a pull,
 * none of which it has. --library names the release repo; every older flag is named once and ignored.
 */
async function machineCommand(args: Args): Promise<void> {
  const repo = args.library ?? DEFAULT_REPO;
  if (!isRepoName(repo)) {
    process.stderr.write(`${args.command}: --library names the release repo as owner/repo, not ${repo}\n`);
    process.exit(2);
  }
  // the hook entry runs `hook` bare: a flag on it is a mistake, and --plan on a run that must write would be a silent one
  if (args.command === "hook" && (args.plan || args.json || args.quiet || args.given.length)) {
    process.stderr.write("hook takes no flags but --library\n");
    process.exit(2);
  }
  // a word none of them expects (branches takes repos) is a mistake, not something to drop silently
  if (args.command !== "branches" && args.positional.length) {
    process.stderr.write(`${args.command}: takes no argument (got ${args.positional.join(" ")})\n`);
    process.exit(2);
  }
  if (args.given.length)
    process.stderr.write(
      `ignored: ${args.given.join(", ")} (settings come from the release's skills-sync.json; machine facts are detected on every run)\n`,
    );
  const cwd = process.cwd();
  if (args.command === "hook") {
    process.exitCode = await runHook({ repo, cwd });
    return;
  }
  if (args.command === "status") {
    process.exitCode = await runStatus({ repo, json: args.json, quiet: args.quiet });
    return;
  }
  if (args.command === "branches") {
    process.exitCode = await runBranches({
      repos: args.positional,
      plan: args.plan,
      json: args.json,
      quiet: args.quiet,
    });
    return;
  }
  if (args.command === "unlink") {
    const r = runUnlink({ repo, plan: args.plan, cwd });
    if (r.report.conflicts().length) process.exitCode = 1;
    return printReport(r.report, args, { oldLibrary: r.machine.oldLibrary, oldLocalFile: r.machine.oldLocalFile });
  }
  const r = await runSync({ repo, plan: args.plan, cwd });
  // Windows: the same sync inside every WSL distro (ADR-0010), each a machine of its own; never from the cloud
  const wsl = r.machine.cloud ? [] : fanOut(r.report, args);
  if (r.report.conflicts().length) process.exitCode = 1;
  printReport(r.report, args, {
    ...syncFacts(r),
    wsl: wsl.map(({ distro, ok, noNode, output }) => ({ distro, ok, noNode, output })),
  });
}

/**
 * The machine sync inside each WSL distro, with this run's flags, as one line each in the report: a note when it ran
 * (its last line), a note when the distro has no Node to run it with, a conflict when it failed.
 */
function fanOut(report: Report, args: Args): WslRun[] {
  // this run's flags travel: the distro plans, prints and reads the same release repo as the host
  const flags = [
    ...(args.plan ? ["--plan"] : []),
    ...(args.json ? ["--json"] : []),
    ...(args.quiet ? ["--quiet"] : []),
    ...(args.library ? ["--library", args.library] : []),
  ];
  const runs: WslRun[] = [];
  for (const distro of wslDistros()) {
    const r = runInWsl(distro, flags);
    runs.push(r);
    const last = r.output.split("\n").filter(Boolean).at(-1);
    if (r.noNode)
      report.add({ kind: "note", path: `WSL ${distro}`, note: "no npx in the distro; install Node there to sync it" });
    else if (!r.ok)
      report.add({ kind: "conflict", path: `WSL ${distro}`, note: `sync failed there${last ? `: ${last}` : ""}` });
    else report.add({ kind: "note", path: `WSL ${distro}`, note: `synced${last && !args.json ? `: ${last}` : ""}` });
  }
  return runs;
}

/** A library command: inside the checkout --repo names, or the one above the current folder. Never clones one. */
async function libraryCommand(args: Args): Promise<void> {
  const cwd = process.cwd();
  const log = (m: string) => (args.json ? undefined : process.stderr.write(m + "\n"));
  const setup = new Report();

  const scopedBrain = args.command === "adopt-brain" || args.command === "rollback-brain";
  const scopedAliases = args.command === "migrate-aliases" || args.command === "rollback-aliases";
  if (scopedBrain || scopedAliases) {
    const label = scopedBrain ? "Brain" : "alias";
    if (!args.receipt) bail(`Scoped ${label} commands require --receipt`);
    if (!args.repo || !looksLikeLibrary(path.resolve(args.repo)))
      bail(`Scoped ${label} commands require --repo pointing to an existing reviewed library`);
    if (args.command === "adopt-brain" && !args.adoptionFile) bail("adopt-brain requires --adoption-file");
    if (args.command === "migrate-aliases" && !args.aliasFile) bail("migrate-aliases requires --alias-file");
  }

  // the library: --repo, $SKILLS_REPO, or a library folder above here; never cloned
  const root = args.repo ? real(path.resolve(args.repo)) : findLibrary(cwd);
  // the first add is how a library gets its config: with --repo, skills/ alone is enough for it
  const firstAdd = args.command === "add" && !!args.repo && !!root && isDir(path.join(root, "skills"));
  if (!root || (!looksLikeLibrary(root) && !firstAdd))
    bail("no skills library found: run this inside one, or pass --repo <path>");
  const lib = new Library(root);
  if (scopedAliases) {
    const report = new Report();
    try {
      if (args.command === "rollback-aliases")
        rollbackAliases(path.resolve(args.receipt!), aliasLinks(process.platform), report, args.plan);
      else {
        const reason = verifyLibraryRevision(lib.root, args.expectRevision, args.remoteRef);
        if (reason) throw new Error(reason);
        migrateAliases(
          lib,
          JSON.parse(fs.readFileSync(path.resolve(args.aliasFile!), "utf8")),
          aliasLinks(process.platform),
          harnessTable(),
          path.resolve(args.receipt!),
          report,
          args.plan,
        );
      }
    } catch (error) {
      report.add({ kind: "conflict", path: lib.root, note: String(error) });
    }
    if (report.conflicts().length) process.exitCode = 1;
    return printReport(report, args, { receipt: path.resolve(args.receipt!) });
  }
  // Scoped recovery never enters broad sync, pulls, remembers a library or saves machine answers.
  if (scopedBrain) {
    const report = new Report();
    if (!args.receipt) bail("Scoped Brain commands require --receipt");
    if (args.command === "rollback-brain") {
      rollbackBrain(path.resolve(args.receipt), brainLinks(process.platform), report, args.plan);
      if (report.conflicts().length) process.exitCode = 1;
      return printReport(report, args);
    }
    if (!args.adoptionFile) bail("adopt-brain requires --adoption-file");
    const reason = verifyLibraryRevision(lib.root, args.expectRevision, args.remoteRef);
    if (reason) {
      report.add({ kind: "conflict", path: lib.root, note: reason });
      process.exitCode = 1;
      return printReport(report, args, { entrypoints: [] });
    }
    const manifest = JSON.parse(fs.readFileSync(path.resolve(args.adoptionFile), "utf8"));
    adoptBrain(lib, manifest, brainLinks(process.platform), path.resolve(args.receipt), report, args.plan);
    const selected = new Set<string>(manifest.links.map((item: { path: string }) => path.resolve(item.path)));
    const hosts = harnessTable().filter(
      (h) =>
        selected.has(path.resolve(path.join(h.userSkills, "oneezy-brain"))) &&
        !report.conflicts().some((a) => samePath(a.path, path.join(h.userSkills, "oneezy-brain"))),
    );
    const instructions = new Report();
    if (args.entrypoints) {
      const changedRevision = verifyLibraryRevision(lib.root, args.expectRevision, args.remoteRef);
      if (changedRevision) report.add({ kind: "conflict", path: lib.root, note: changedRevision });
      else {
        entrypoints(lib, hosts, true, [], instructions, true, args.plan ? report : undefined, false, "oneezy-brain");
        apply(instructions, args.plan);
        report.merge(instructions);
      }
    }
    const verified = args.entrypoints
      ? entrypoints(lib, hosts, true, [], new Report(), true, args.plan ? report : undefined, false, "oneezy-brain")
      : [];
    if (report.conflicts().length || (!args.plan && verified.some((item) => item.state !== "current")))
      process.exitCode = 1;
    return printReport(report, args, { entrypoints: verified, receipt: path.resolve(args.receipt) });
  }

  // how the working set's links are made in this checkout: the flag, else what the checkout's local file says
  setLinkMode(args.links ?? readLocal(lib.root).links ?? "auto");
  if (args.command === "check") return runCheck(lib, args);
  if (args.command === "update" || args.command === "refresh") return runUpdate(lib, args, log, setup);
  if (args.command === "versions") return runVersions(lib, args, log);
  if (args.command === "add") return runAdd(lib, args, log, setup);
  return runBuild(lib, args, log, setup);
}
/**
 * update (refresh is the same command): the named sources (every one when none is named) at the tip of their ref, pins
 * and --frozen excepted; every other source stays at the lock. Gone-upstream skills are remembered like restore's.
 */
function runUpdate(lib: Library, args: Args, log: (m: string) => void, report: Report): void {
  if (!lib.hasConfig()) bail(`no ${path.basename(lib.configFile)} in ${lib.root}; add <source> writes one`);
  const ids = Object.keys(readConfig(lib.configFile).sources).sort(cmp);
  const unknown = args.positional.filter((n) => !ids.includes(n));
  if (unknown.length)
    bail(
      `${args.command}: no source ${unknown.join(", ")} in ${path.basename(lib.configFile)} (sources: ${ids.join(", ") || "none"})`,
    );
  const local = readLocal(lib.root);
  const unavailable = args.retry ? [] : (local.unavailable ?? []);
  const only = args.positional.length ? [...new Set(args.positional)] : undefined;
  if (args.to !== undefined && only?.length !== 1)
    bail(
      `${args.command} --to: name the one source it moves (${args.command} <source> --to ${args.to || "<version>|previous|latest"})`,
    );
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
  printReport(report, args, {
    sources: r.sources,
    updated: r.updated,
    config: r.config,
    gone: r.gone,
    unselected: r.unselected,
    shadowed: r.shadowed,
    forbidden: r.forbidden,
    unusedRules: r.unusedRules,
    unlocked: r.unlocked,
    problems: r.problems,
  });
  if (!args.json) {
    printUpdated(r.updated);
    const file = path.basename(lib.configFile);
    for (const c of r.config)
      process.stdout.write(
        c.version === null
          ? `${file}: remove sources.${c.source}.version (follow latest); land this change, skills-sync never writes it\n`
          : `${file}: sources.${c.source}.version = "${c.version}"; land this change, skills-sync never writes it\n`,
      );
  }
  if (r.problems.length) process.exitCode = 1;
}

/** Per source a refresh moved: from and to (version, commits past it, commit), then the changelog range it brings or undoes, indented. */
function printUpdated(updated: Moved[]): void {
  const at = (x: Position) =>
    `${x.version === null ? "" : `${versionLabel({ ...x, date: "" })} `}${x.commit.slice(0, 7)}`;
  for (const u of updated) {
    process.stdout.write(`updated ${u.id}: ${u.from ? at(u.from) : "(new)"} -> ${at(u.to)}\n`);
    const [low, high] = byDirection(u);
    if (u.changelog === null) process.stdout.write(`  changelog: none (${u.changelogReason})\n`);
    else
      process.stdout.write(
        `  ${u.direction === "upgrade" ? "changelog" : "undoes the changelog"} after ${low!.version} up to ${high!.version}:\n${u.changelog
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => (l ? `    ${l}\n` : "\n"))
          .join("")}`,
      );
  }
}

/**
 * The refresh's lines that are not file actions, and the remembered gone-upstream list, shared by refresh and sync.
 * `verbose` names every source's commit; otherwise only one that moved, so a sync with nothing new says nothing.
 */
function reportRefresh(
  lib: Library,
  r: RefreshResult,
  unavailable: string[],
  args: Args,
  log: (m: string) => void,
  verbose: boolean,
): string[] {
  for (const [id, s] of Object.entries(r.sources))
    if (s.moved || verbose) log(`${id}: ${versionLabel(s)}${s.moved ? ", moved" : ""}`);
  for (const g of r.gone) log(`  gone upstream: ${g}`);
  if (r.gone.length)
    log(
      `  (not in the lock; deselect it in ${path.basename(lib.configFile)}, or a copy in skills/ keeps it as your own; --retry checks again)`,
    );
  if (r.unlocked.length && !args.quiet)
    log(
      `${r.unlocked.length} selected skill(s) have no commit in ${path.basename(lib.lockFile)} (${r.unlocked.join(", ")}); run update to resolve them`,
    );
  for (const m of r.problems) log(`failed: ${m}`);
  for (const [id, names] of bySource(r.unselected))
    warn(
      `skills-sync ${args.command}`,
      `${id}: not selected upstream: ${names.join(", ")} (select them in ${path.basename(lib.configFile)}, or take every skill under the root with "skills": "*")`,
    );
  for (const [id, names] of bySource(r.shadowed))
    warn(
      `skills-sync ${args.command}`,
      `${id}: not taken from upstream, the name is already another's: ${names.map((n) => `${n} (${r.shadowedBy[`${id}:${n}`]})`).join(", ")}; give each a "rename" to take it`,
    );
  for (const [id, hits] of bySource(r.forbidden))
    warn(
      `skills-sync ${args.command}`,
      `${id}: forbidden term left after the adapt rules in new upstream text: ${hits
        .map((h) => {
          const m = /^(.*):(\d+): (.*)$/.exec(h);
          return m ? `${m[1]}:${m[2]} ${JSON.stringify(m[3])}` : h;
        })
        .join(
          ", ",
        )}; add a rule, or an allow, under sources.${id}.adapt in ${path.basename(lib.configFile)}, or check fails after the build`,
    );
  for (const u of r.unusedRules)
    warn(
      `skills-sync ${args.command}`,
      `${u.source}: adapt rule rules[${u.rule}] (find ${JSON.stringify(u.find)}) matches nothing upstream now; fix it or remove it from ${path.basename(lib.configFile)}`,
    );
  // text output prints every conflict with the file actions; --json would carry them only in its actions
  if (args.json) for (const a of r.report.conflicts()) warn(`skills-sync ${args.command}`, line(a).trim());
  const gone = r.gone.map((g) => g.split(":")[1]);
  const remembered = [...new Set([...unavailable, ...gone])];
  if (remembered.length && !args.quiet)
    log(
      `${remembered.length} selected skill${remembered.length === 1 ? " is" : "s are"} gone upstream (${remembered.join(", ")}); --retry to check again`,
    );
  if (!args.plan) {
    const local = readLocal(lib.root);
    const next: Local = { ...local, unavailable: remembered };
    if (!remembered.length) delete next.unavailable;
    if (JSON.stringify(next) !== JSON.stringify(local)) writeLocal(lib.root, next);
  }
  return remembered;
}

/** source:name entries grouped by source, in the order given. */
function bySource(entries: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    const at = e.indexOf(":");
    const id = e.slice(0, at);
    out.set(id, [...(out.get(id) ?? []), e.slice(at + 1)]);
  }
  return out;
}

/**
 * A line that reaches the person whatever the flags (--json and --quiet included): on stderr, and under GitHub Actions as
 * a ::warning:: workflow command, so the daily update run flags it on its page. It never sets the exit code.
 */
function warn(title: string, m: string): void {
  const data = m.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stderr.write(process.env.GITHUB_ACTIONS === "true" ? `::warning title=${title}::${data}\n` : `${m}\n`);
}

/** versions: the releases of one source, highest first, the one the lock is at marked; reads only (a temp clone). */
function runVersions(lib: Library, args: Args, log: (m: string) => void): void {
  if (!lib.hasConfig()) bail(`no ${path.basename(lib.configFile)} in ${lib.root}; add <source> writes one`);
  const config = readConfig(lib.configFile);
  const ids = Object.keys(config.sources).sort(cmp);
  const id = args.positional[0];
  if (!id || !config.sources[id])
    bail(
      `versions: ${id ? `no source ${id}` : "which source?"} in ${path.basename(lib.configFile)} (sources: ${ids.join(", ") || "none"})`,
    );
  const src = config.sources[id];
  const prior = lockedSource(readLock(lib.root, config), id, src);
  const r = releasesOf(cloneUrl(src.repo), src.ref, src.root, prior?.commit ?? null, log);
  if (!r.ok) bail(`versions: ${id}: ${r.error}`);
  const current: Position | null = prior
    ? {
        version: prior.version,
        commit: prior.commit,
        ahead: r.current?.version === prior.version ? r.current.ahead : null,
      }
    : null;
  const versions = r.releases.map((x) => ({ ...x, current: !!current && x.version === current.version }));
  if (args.json) {
    process.stdout.write(
      JSON.stringify({ source: id, repo: src.repo, ref: src.ref, current, versions }, null, 2) + "\n",
    );
    return;
  }
  process.stdout.write(
    `${id}: ${src.repo}@${src.ref}, ${versions.length} version${versions.length === 1 ? "" : "s"}, newest first${src.version ? `; held at ${src.version} in ${path.basename(lib.configFile)}` : ""}\n`,
  );
  for (const v of versions)
    process.stdout.write(
      `${v.current ? "*" : " "} ${v.version.padEnd(12)} ${v.commit.slice(0, 7)}  ${v.date.slice(0, 10)}${v.current ? `  current${commitsPast(current!.ahead)}` : ""}\n`,
    );
  if (!versions.length) process.stdout.write("  no release tag and no manifest version\n");
  if (current && !versions.some((v) => v.current))
    process.stdout.write(`  the lock is at ${current.version ?? "no version"} ${current.commit.slice(0, 7)}\n`);
}

/**
 * add: stage the source, write its config entry, then refresh that one source with the staged clone (every other source
 * stays at the lock) and report it as update does. --plan shows the entry and writes nothing.
 */
function runAdd(lib: Library, args: Args, log: (m: string) => void, report: Report): void {
  const spec = args.positional[0];
  if (!spec) bail("add: which source? owner/repo[#ref], a git URL or a local path");
  const r = addSource(lib, spec, {
    id: args.id,
    root: args.root,
    skills: args.skills,
    as: args.as,
    plugin: args.plugin,
    log,
  });
  if (!r.ok) bail(r.error);
  const taken =
    r.entry.skills === "*"
      ? `every one of ${r.found.size} skills (now and later)`
      : `${Object.keys(r.entry.skills).length} of ${r.found.size} skills`;
  const renames = [...renamesOf(r.entry)].map(([to, from]) => `${from} -> ${to}`);
  log(
    `${r.id}: ${r.entry.repo}@${r.entry.ref} (${r.staged.commit.slice(0, 7)}), ${taken} under ${r.entry.root ?? "the root"}${renames.length ? `, renaming ${renames.join(", ")}` : ""}`,
  );
  if (args.plan) {
    discard(r.staged);
    process.stdout.write(
      `plan: would add to ${lib.configFile}:\n${JSON.stringify({ sources: { [r.id]: r.entry }, ...(r.plugin ? { plugins: { [r.plugin.id]: r.plugin.entry } } : {}) }, null, 2)}\n`,
    );
    return;
  }
  fs.writeFileSync(lib.configFile, configText(r.config));
  log(
    `wrote ${path.basename(lib.configFile)}${r.plugin ? `, with plugin ${r.plugin.id}; build --plugins --catalogs packages it` : ""}`,
  );
  const local = readLocal(lib.root);
  const unavailable = args.retry ? [] : (local.unavailable ?? []);
  // only the new source resolves upstream: every other one stays at the lock, as update <source> leaves them
  const res = refresh(lib, {
    frozen: false,
    only: [r.id],
    plan: false,
    unavailable,
    log,
    prestaged: { [r.id]: r.staged },
  });
  reportRefresh(lib, res, unavailable, args, log, !args.quiet);
  report.merge(res.report);
  printReport(report, args, {
    sources: res.sources,
    updated: res.updated,
    gone: res.gone,
    unselected: res.unselected,
    shadowed: res.shadowed,
    forbidden: res.forbidden,
    unusedRules: res.unusedRules,
    unlocked: res.unlocked,
    problems: res.problems,
  });
  if (!args.json) printUpdated(res.updated);
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
  const r = build(lib, {
    plugins: args.plugins || none,
    catalogs: args.catalogs || none,
    artifacts: args.artifacts,
    check: args.check,
    plan: args.plan,
    log,
  });
  report.merge(r.report);
  if (r.off && !args.quiet)
    log(`generate.plugins is false in ${path.basename(lib.configFile)}: nothing built, nothing checked`);
  const conflicts = r.report.conflicts().length;
  const adapt = { forbidden: r.forbidden, unusedRules: r.unusedRules };
  if (!args.check) {
    printReport(report, args, { versions: r.versions, ...adapt });
    if (!args.json) printAdapt(lib, r, args);
    if (conflicts) process.exitCode = 1;
    return;
  }
  if (r.drift.length || r.forbidden.length) process.exitCode = 1;
  if (args.json) return printReport(report, args, { check: true, drift: r.drift, versions: r.versions, ...adapt });
  for (const a of report.actions) if (a.kind === "note" || a.kind === "conflict") process.stdout.write(line(a) + "\n");
  for (const d of r.drift) process.stdout.write(`drift        ${d}\n`);
  printAdapt(lib, r, args);
  const fix = conflicts
    ? `${conflicts} conflict(s) above to fix first, then build --plugins --catalogs`
    : "run build --plugins --catalogs";
  const forbidden = r.forbidden.length
    ? `build --check: ${r.forbidden.length} forbidden term(s) left after the adapt rules; add a rule, or an allow, under sources.<id>.adapt in ${path.basename(lib.configFile)}\n`
    : "";
  process.stdout.write(
    r.drift.length
      ? `build --check: ${r.drift.length} path(s) differ from what build would write; ${fix}\n${forbidden}`
      : forbidden || `build --check: clean, ${report.skips()} files as built\n`,
  );
}

/**
 * The adapt lines of a build: every forbidden term left in a package file (whatever the flags: it fails check), and,
 * unless --quiet, every rule that matched nothing in its source's skills.
 */
function printAdapt(lib: Library, r: BuildResult, args: Args): void {
  for (const f of r.forbidden)
    process.stdout.write(
      `forbidden    ${f.path}:${f.line}: ${JSON.stringify(f.term)} (sources.${f.source}.adapt.forbid: ${f.pattern})\n`,
    );
  if (!args.quiet)
    for (const u of r.unusedRules)
      process.stdout.write(`note         ${path.basename(lib.configFile)}: ${unusedReason(u)}\n`);
}

/**
 * check: one line per problem (the file, then the rule it breaks) on stdout, exit 1 when there is any; a clean library
 * gets one summary line and exit 0. It writes nothing, in the library or outside it.
 */
function runCheck(lib: Library, args: Args): void {
  const r = check(lib);
  if (r.problems.length) process.exitCode = 1;
  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        { check: true, problems: r.problems, notes: r.notes, skills: r.skills, flows: r.flows, generated: r.generated },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  for (const p of r.problems) process.stdout.write(`${p.path}: ${p.reason}\n`);
  if (!args.quiet) for (const n of r.notes) process.stdout.write(`note: ${n.path}: ${n.reason}\n`);
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (r.problems.length)
    process.stdout.write(`check: ${[count(r.problems.length, "problem"), ...r.fixes].join("; ")}\n`);
  else if (!args.quiet)
    process.stdout.write(
      `check: clean, ${count(r.skills, "own skill")}, ${count(r.flows, "flow")}, ${count(r.generated, "generated file")} as built\n`,
    );
}

function printReport(r: Report, args: Args, extra: Record<string, unknown> = {}): void {
  if (r.actions.some((action) => action.failed)) process.exitCode = 1;
  if (args.json) {
    // a write's payload is the file body; bytes (an attribution file) are summarised, text is kept as before
    const actions = r.actions.map((a) =>
      Buffer.isBuffer(a.payload) ? { ...a, payload: `<${a.payload.length} bytes>` } : a,
    );
    process.stdout.write(
      JSON.stringify({ plan: args.plan, actions, links: r.links, linkMode: linkMode(), ...extra }, null, 2) + "\n",
    );
    return;
  }
  const changes = r.changes();
  const conflicts = r.conflicts();
  // quiet with nothing changed or red: only a loud note (the block that could not be updated), else nothing
  if (args.quiet && !changes.length && !conflicts.length) {
    for (const a of r.actions) if (a.kind === "note" && a.loud) process.stdout.write(line(a) + "\n");
    return;
  }
  for (const a of r.actions) if (a.kind !== "skip") process.stdout.write(line(a) + "\n");
  if (r.links.symlink + r.links.junction) process.stdout.write(linksLine(r) + "\n");
  const verb = args.plan ? "would change" : "changed";
  process.stdout.write(
    `${args.plan ? "plan: " : ""}${changes.length} ${verb}, ${r.skips()} already right, ${conflicts.length} left alone\n`,
  );
}

/** Which kind of link this run made, and why, when it made any. */
function linksLine(r: Report): string {
  const { symlink, junction } = r.links;
  const mode = linkMode();
  if (junction && !symlink)
    return `links: ${junction} made as junctions${mode === "auto" ? " (directory symlinks were refused: Developer Mode or elevation allows them; --junctions makes this the rule)" : " (--junctions)"}`;
  if (junction) return `links: ${symlink} made as symlinks, ${junction} as junctions (symlinks were refused part way)`;
  return `links: ${symlink} made as symlinks${mode === "symlink" ? " (--symlinks)" : ""}`;
}

main().catch((e) => bail(String(e?.stack ?? e)));
