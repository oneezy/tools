// hook: what the session-start entry runs (ADR-0010). First the machine sync, quietly: nothing printed unless something
// changed or went wrong. Then the checkout duties on every git repository this session can see, whoever owns it
// (tools#145): the repository the current folder is in (its main checkout, from a linked worktree) and the git
// repositories beside it, or, outside any repository, the ones directly inside the current folder; found on every run,
// nothing remembered (ADR-0012). A repository with a dev branch and an origin takes part: on dev with a clean tree it is
// fetched and fast-forwarded, never rebased, reset or switched; a dirty one or one on another branch is named and left
// alone, not even fetched. One with no dev or no origin is not mentioned. Last, one line per repository fetched: the
// branches ahead of dev, counted from the refs the fetch just brought (no request spent: the hook often runs without a
// token, and anonymous GitHub allows 60 requests an hour), and, for a GitHub origin, the open pull requests into dev,
// one GitHub request; eight names at most of each, the rest a count, since the harness feeds stdout to the model as
// session context. Stdout carries only what a user should read, and problems go to stderr. The exit code is 0 unless
// the sync hit a conflict a person must fix: GitHub out of reach, a fetch that fails or a checkout that cannot
// fast-forward are reported, not failures of the session start. The repositories are tended six at a time, a fetch gets
// 15 s and any other git call 30 s, so a black-holed network cannot run the hook past the 120 s its entry allows.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDir, samePath } from "../fs.js";
import { github, GitHubError, type GitHub } from "../github.js";
import { line } from "../plan.js";
import { DEFAULT_REPO } from "../release.js";
import { runSync } from "./sync.js";

/** The repositories whose checkouts `status` judges on dev and clean: the library and the tool's own (ADR-0010). */
export const CHECKOUT_REPOS = [DEFAULT_REPO, "oneezy/tools"];

/** How long one fetch may take before it is cut off; `SKILLS_SYNC_FETCH_TIMEOUT_MS` overrides it (tests). */
export const FETCH_TIMEOUT_MS = 15_000;

/** How many repositories are tended at once. */
export const CONCURRENCY = 6;

export interface HookOptions {
  /** the release repo, owner/repo (default: the library) */
  repo?: string;
  env?: NodeJS.ProcessEnv;
  /** where the session starts: its repository and the folders beside it are looked at for checkouts */
  cwd?: string;
  write?: (text: string) => void;
  warn?: (text: string) => void;
}

/** A git repository in reach of the session, whoever owns it. */
export interface Repository {
  path: string;
  /** owner/name when origin is on GitHub, else null */
  repo: string | null;
  /** whether it has an origin remote at all */
  origin: boolean;
}

/** A local clone of one of the CHECKOUT_REPOS, as `status` reads it. */
export interface Checkout {
  path: string;
  /** owner/name, as the origin URL says */
  repo: string;
}

interface Pull {
  number: number;
}

/** What tending one repository said, kept until every repository is done so the lines come out in a fixed order. */
interface Tended {
  out: string[];
  err: string[];
  /** fetched and origin has dev: the drift line can be counted */
  fetched: boolean;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** How many names a drift line spells out; the rest is a count, so a repository with forty old branches is one line. */
const NAMED = 8;

const some = (names: string[]): string =>
  names.length > NAMED ? `${names.slice(0, NAMED).join(", ")} … and ${names.length - NAMED} more` : names.join(", ");

/** Why a call failed: GitHub's status and message, or the error's text. */
const detail = (e: unknown): string =>
  e instanceof GitHubError ? e.detail : e instanceof Error ? e.message : String(e);

function fetchTimeout(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SKILLS_SYNC_FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : FETCH_TIMEOUT_MS;
}

export async function runHook(options: HookOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const repo = options.repo ?? DEFAULT_REPO;
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const warn = options.warn ?? ((text: string) => void process.stderr.write(text));

  // 1. the sync, quietly: its report only when it changed something (the notes with it, as sync prints them); every
  // conflict on stderr, whether or not anything changed
  const sync = await runSync({ repo, plan: false, env, cwd });
  const { report } = sync;
  const changes = report.changes();
  const conflicts = report.conflicts();
  if (changes.length) {
    for (const a of report.actions) if (a.kind !== "skip" && a.kind !== "conflict") write(line(a) + "\n");
    write(`${changes.length} changed, ${report.skips()} already right, ${conflicts.length} left alone\n`);
  }
  for (const a of conflicts) warn(line(a) + "\n");
  // GitHub out of reach is one red line (the release conflict), not a failed hook: a session start must stay green offline
  const releaseConflict = (a: (typeof conflicts)[number]) => sync.error !== null && a.path === repo && !a.failed;
  const code = conflicts.some((a) => !releaseConflict(a)) ? 1 : 0;

  // 2. every repository in reach, a few at a time; the lines in the order the repositories were found. The first
  // repository fetched answers for its GitHub name (or its path) below
  const repos = findRepositories(cwd, env);
  const timeout = fetchTimeout(env);
  const tended = await inPool(repos, CONCURRENCY, (r) => tend(r, env, timeout));
  const fetched = new Map<string, Repository>();
  repos.forEach((r, i) => {
    const t = tended[i];
    for (const l of t.out) write(l + "\n");
    for (const l of t.err) warn(l + "\n");
    const key = r.repo?.toLowerCase() ?? r.path;
    if (t.fetched && !fetched.has(key)) fetched.set(key, r);
  });

  // 3. what is not in dev yet, one line per repository; the pull requests are not asked for when GitHub already failed
  // the release read (one red line is enough), the branches still count
  const gh = sync.error === null ? github(env) : null;
  for (const r of fetched.values()) {
    try {
      const text = await drift(r, gh, env);
      if (text) write(text + "\n");
    } catch (e) {
      warn(`${r.repo ?? r.path}: open pull requests not read: ${detail(e)}\n`);
    }
  }
  return code;
}

/** `fn` over `items`, at most `limit` at once; the results in the items' order. */
async function inPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  /** how it ended: `exit 128`, `signal SIGTERM`, `timed out after 15 s`, or `not run: <why>` when git could not start */
  why: string;
}

/**
 * git in `cwd`, never prompting: a remote that wants credentials fails instead of hanging the session start, and a
 * call gets 30 s (the release read has 30 s too, and the hook's entry allows 120 s in all).
 */
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: "",
    timeout: 30_000,
    windowsHide: true,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  const why = r.error ? `not run: ${r.error.message}` : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", why };
}

/**
 * git in `cwd` without blocking, so several repositories are tended at once; never prompting, and cut off after
 * `timeoutMs`. Outside Windows it runs in a process group of its own, so the cut-off also ends what git started (the
 * ssh of a fetch, which would otherwise keep the pipes open), and with no terminal, so ssh cannot sit at a passphrase
 * prompt. A call that is cut off answers at once, whatever its children still do.
 */
function gitAsync(cwd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child: ChildProcess;
    const finish = (r: GitResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      stop(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish({ ok: false, out, err, why: `timed out after ${timeoutMs / 1000} s` });
    }, timeoutMs);
    try {
      child = spawn("git", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (e) {
      finish({ ok: false, out, err, why: `not run: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    child.stdout?.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => finish({ ok: false, out, err, why: `not run: ${e.message}` }));
    child.on("close", (code, signal) =>
      finish({ ok: code === 0, out, err, why: signal ? `signal ${signal}` : `exit ${code}` }),
    );
  });
}

/** End a git call and, outside Windows, the process group it leads. */
function stop(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill();
  } catch {
    child.kill();
  }
}

/**
 * Why a git call failed, for the user and for a bug report: how it ended, then git's own words (the first three lines
 * of its stderr), or that it said nothing. `(exit 128): fatal: not a git repository`.
 */
export function reason(r: GitResult): string {
  const said = r.err.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ");
  return `(${r.why})${said ? `: ${said}` : ", nothing on stderr"}`;
}

/** owner/name from a GitHub remote URL (https, ssh with or without a port, or git@), null for anything else. */
export function repoOf(url: string): string | null {
  const m = /(?:^|[/@])github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Every git repository in reach of `cwd`, whoever owns it: the repository `cwd` is in, then every folder beside its root
 * that is a git repository, by name. A linked worktree (a task's, in `<repo>/.claude/worktrees/<name>`) stands for its
 * main worktree: that is the repository, and the folders beside it are the others. Outside any repository: the git
 * repositories directly inside `cwd`. Never deeper than one level, and a folder whose `.git` is a file (a linked
 * worktree, a submodule) or whose name starts with a dot is none.
 */
export function findRepositories(cwd: string, env: NodeJS.ProcessEnv = process.env): Repository[] {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env);
  let dirs: string[];
  if (top.ok && top.out.trim()) {
    const root = mainWorktree(cwd, env) ?? path.resolve(top.out.trim());
    dirs = [root, ...repositoriesIn(path.dirname(root), root)];
  } else dirs = repositoriesIn(path.resolve(cwd));
  return dirs.map((dir) => {
    // the URL as configured: `remote get-url` would show it after any insteadOf rewrite, which is not the repository's name
    const url = git(dir, ["config", "--get", "remote.origin.url"], env);
    const origin = url.ok && url.out.trim() !== "";
    return { path: dir, repo: origin ? repoOf(url.out) : null, origin };
  });
}

/** The git repositories directly inside `parent` (their own `.git` folder), by name, `except` left out. */
function repositoriesIn(parent: string, except?: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    /* an unreadable folder: none */
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const dir = path.join(parent, name);
    if (name.startsWith(".") || (except && samePath(dir, except))) continue;
    if (isDir(dir) && isDir(path.join(dir, ".git"))) out.push(dir);
  }
  return out;
}

/**
 * The checkouts of oneezy/skills and oneezy/tools among the repositories in reach (`status` judges these on dev and
 * clean), known by their origin URL.
 */
export function findCheckouts(cwd: string, env: NodeJS.ProcessEnv = process.env): Checkout[] {
  const out: Checkout[] = [];
  for (const r of findRepositories(cwd, env)) {
    const name = r.repo;
    const repo = name && CHECKOUT_REPOS.find((c) => c.toLowerCase() === name.toLowerCase());
    if (repo) out.push({ path: r.path, repo });
  }
  return out;
}

/**
 * The main worktree of the repository `cwd` is in: the folder that holds the common `.git` folder. Null when git cannot
 * say (older than 2.31) or the common folder is not a worktree's `.git` (a bare repository, a submodule).
 */
function mainWorktree(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const r = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
  const common = r.ok ? r.out.trim() : "";
  if (!common || path.basename(common) !== ".git") return null;
  const root = path.dirname(path.resolve(common));
  return isDir(root) ? root : null;
}

/**
 * One repository. Its git status first: one git cannot give is a line and nothing more, never taken for clean. A
 * repository with no dev branch (its own or origin's) or no origin takes no part in the dev flow and is not mentioned.
 * Otherwise: on dev with a clean tree, fetch origin (every branch, gone ones pruned: dev for the fast-forward, the rest
 * for the drift line; cut off after `timeout` ms), fast-forward only and say so when it moved; on another branch or
 * dirty, name the branch and the dirty files and touch nothing, not even a fetch (stories 33, 34, 75). Never a rebase,
 * a reset or a switch. A fetch or a merge that fails, or an origin with no dev, is a line, not a stop.
 */
async function tend(r: Repository, env: NodeJS.ProcessEnv, timeout: number): Promise<Tended> {
  const t: Tended = { out: [], err: [], fetched: false };
  const status = await gitAsync(r.path, ["--no-optional-locks", "status", "--porcelain"], env);
  if (!status.ok) {
    t.err.push(`${r.path}: git status not read ${reason(status)}; left alone`);
    return t;
  }
  const refs = await gitAsync(
    r.path,
    ["for-each-ref", "--format=%(refname)", "refs/heads/dev", "refs/remotes/origin/dev"],
    env,
  );
  const devs = refs.out.split(/\r?\n/);
  if (!r.origin || !devs.some((n) => n === "refs/heads/dev" || n === "refs/remotes/origin/dev")) return t;
  const branch = (await gitAsync(r.path, ["rev-parse", "--abbrev-ref", "HEAD"], env)).out.trim() || "HEAD";
  const dirty = status.out.split(/\r?\n/).filter(Boolean).length;
  if (branch !== "dev" || dirty) {
    t.err.push(`${r.path}: on ${branch}${dirty ? `, dirty (${count(dirty, "file")})` : ""}; left alone`);
    return t;
  }
  const fetched = await gitAsync(r.path, ["fetch", "--quiet", "--prune", "origin"], env, timeout);
  if (!fetched.ok) {
    t.err.push(`${r.path}: fetch of origin failed ${reason(fetched)}`);
    return t;
  }
  if (!(await gitAsync(r.path, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev"], env)).ok) {
    t.err.push(`${r.path}: origin has no dev; left alone`);
    return t;
  }
  t.fetched = true;
  const before = (await gitAsync(r.path, ["rev-parse", "HEAD"], env)).out.trim();
  const merged = await gitAsync(r.path, ["merge", "--ff-only", "--quiet", "origin/dev"], env);
  if (!merged.ok) {
    t.err.push(`${r.path}: dev does not fast-forward to origin/dev ${reason(merged)}; left alone`);
    return t;
  }
  const after = (await gitAsync(r.path, ["rev-parse", "HEAD"], env)).out.trim();
  if (after !== before) t.out.push(`${r.path}: dev fast-forwarded to ${after.slice(0, 7)}`);
  return t;
}

/**
 * The repository's drift from dev as one line (story 35): the branches with commits dev lacks (main and dev left out),
 * counted in the checkout from the remote-tracking refs its fetch just refreshed; and, for a GitHub origin, the open
 * pull requests into dev, one GitHub request, or none when `gh` is null. Named by its GitHub owner/name, else its path.
 * Null when there is neither.
 */
export async function drift(
  r: Pick<Repository, "path" | "repo">,
  gh: GitHub | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const refs = git(r.path, ["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin/"], env);
  const others = refs.out
    .split(/\r?\n/)
    .filter((n) => n && n !== "HEAD" && n !== "main" && n !== "dev")
    .sort();
  const ahead: string[] = [];
  for (const name of others) {
    const n = git(r.path, ["rev-list", "--count", `origin/dev..origin/${name}`], env);
    if (n.ok && Number(n.out.trim()) > 0) ahead.push(name);
  }
  const numbers: number[] = [];
  if (gh && r.repo) {
    const pulls = await gh.getList<Pull>(`/repos/${r.repo}/pulls?state=open&base=dev&per_page=100`);
    numbers.push(...pulls.map((p) => p.number).sort((a, b) => a - b));
  }
  if (!ahead.length && !numbers.length) return null;
  const parts: string[] = [];
  if (ahead.length) parts.push(`${count(ahead.length, "branch", "branches")} ahead of dev (${some(ahead)})`);
  if (numbers.length)
    parts.push(`${count(numbers.length, "open pull request")} (${some(numbers.map((n) => `#${n}`))})`);
  return `${r.repo ?? r.path}: ${parts.join(", ")}`;
}
