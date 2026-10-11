// hook: what the session-start entry runs (ADR-0010). First the machine sync, quietly: nothing printed unless something
// changed or went wrong. Then the checkout duties on the clones of oneezy/skills and oneezy/tools this session can see
// (the repository the current folder is in and the folders beside it, found on every run, nothing remembered,
// ADR-0012): fetch origin; a clean checkout on dev is fast-forwarded, a dirty one or one on another branch is named
// and left alone. Last, one line per repository: the branches ahead of dev, counted from the refs the fetch just
// brought (no request spent: the hook often runs without a token, and anonymous GitHub allows 60 requests an hour),
// and the open pull requests into dev, one GitHub request. The harness feeds stdout to the model as session context,
// so stdout carries only what a user should read, and problems go to stderr. The exit code is 0 unless the sync hit a
// conflict a person must fix: GitHub out of reach, a fetch that fails or a checkout that cannot fast-forward are
// reported, not failures of the session start.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDir, lexists, samePath } from "../fs.js";
import { github, GitHubError, type GitHub } from "../github.js";
import { line } from "../plan.js";
import { DEFAULT_REPO } from "../release.js";
import { runSync } from "./sync.js";

/** The repositories whose checkouts the hook keeps on dev: the library and the tool's own (ADR-0010). */
export const CHECKOUT_REPOS = [DEFAULT_REPO, "oneezy/tools"];

export interface HookOptions {
  /** the release repo, owner/repo (default: the library) */
  repo?: string;
  env?: NodeJS.ProcessEnv;
  /** where the session starts: its repository and the folders beside it are looked at for checkouts */
  cwd?: string;
  write?: (text: string) => void;
  warn?: (text: string) => void;
}

/** A local clone of one of the repositories the hook tends. */
export interface Checkout {
  path: string;
  /** owner/name, as the origin URL says */
  repo: string;
}

interface Pull {
  number: number;
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Why a call failed: GitHub's status and message, or the error's text. */
const detail = (e: unknown): string =>
  e instanceof GitHubError ? e.detail : e instanceof Error ? e.message : String(e);

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

  // 2. the checkouts in reach; the first of a repository whose fetch worked answers for the repository below
  const fetched = new Map<string, Checkout>();
  for (const c of findCheckouts(cwd, env))
    if (tend(c, env, write, warn) && !fetched.has(c.repo)) fetched.set(c.repo, c);

  // 3. what is not in dev yet, one line per repository; the pull requests are not asked for when GitHub already failed
  // the release read (one red line is enough), the branches still count
  const gh = sync.error === null ? github(env) : null;
  for (const c of fetched.values()) {
    try {
      const text = await drift(c, gh, env);
      if (text) write(text + "\n");
    } catch (e) {
      warn(`${c.repo}: open pull requests not read: ${detail(e)}\n`);
    }
  }
  return code;
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
  /** how it ended: `exit 128`, `signal SIGTERM`, or `not run: <why>` when git could not be started */
  why: string;
}

/** git in `cwd`, never prompting: a remote that wants credentials fails instead of hanging the session start. */
function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: "",
    timeout: 60_000,
    windowsHide: true,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  const why = r.error ? `not run: ${r.error.message}` : r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "", why };
}

/**
 * Why a git call failed, for the user and for a bug report: how it ended, then git's own words (the first three lines
 * of its stderr), or that it said nothing. `(exit 128): fatal: not a git repository`.
 */
function reason(r: GitResult): string {
  const said = r.err.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(" | ");
  return `(${r.why})${said ? `: ${said}` : ", nothing on stderr"}`;
}

/** owner/name from a GitHub remote URL (https, ssh or git@), null for anything else. */
export function repoOf(url: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The checkouts of the tended repositories in reach of `cwd`: the repository `cwd` is in, and every folder beside its
 * root that is a git repository, each known by its origin URL. Nowhere near a repository: none, and nothing to do.
 */
export function findCheckouts(cwd: string, env: NodeJS.ProcessEnv = process.env): Checkout[] {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], env);
  if (!top.ok || !top.out.trim()) return [];
  const root = path.resolve(top.out.trim());
  const dirs = [root];
  const parent = path.dirname(root);
  let siblings: string[] = [];
  try {
    siblings = fs.readdirSync(parent);
  } catch {
    /* an unreadable parent: the root alone */
  }
  for (const name of siblings.sort()) {
    const dir = path.join(parent, name);
    if (name.startsWith(".") || samePath(dir, root) || !isDir(dir) || !lexists(path.join(dir, ".git"))) continue;
    dirs.push(dir);
  }
  const out: Checkout[] = [];
  for (const dir of dirs) {
    // the URL as configured: `remote get-url` would show it after any insteadOf rewrite, which is not the repository's name
    const url = git(dir, ["config", "--get", "remote.origin.url"], env);
    const name = url.ok ? repoOf(url.out) : null;
    const repo = name && CHECKOUT_REPOS.find((r) => r.toLowerCase() === name.toLowerCase());
    if (repo) out.push({ path: dir, repo });
  }
  return out;
}

/**
 * One checkout: fetch origin (every branch, gone ones pruned: dev for the fast-forward, the rest for the drift line);
 * on dev with a clean tree, fast-forward and say so when it moved; otherwise name the branch and the dirty files and
 * touch nothing (stories 33, 34, 75). A fetch or a merge that fails is a line, not a stop. Returns whether the fetch
 * worked, which is what the drift line needs.
 */
function tend(c: Checkout, env: NodeJS.ProcessEnv, write: (t: string) => void, warn: (t: string) => void): boolean {
  const fetched = git(c.path, ["fetch", "--quiet", "--prune", "origin"], env);
  if (!fetched.ok) {
    warn(`${c.path}: fetch of origin failed ${reason(fetched)}\n`);
    return false;
  }
  const branch = git(c.path, ["rev-parse", "--abbrev-ref", "HEAD"], env).out.trim() || "HEAD";
  const dirty = git(c.path, ["status", "--porcelain"], env).out.split(/\r?\n/).filter(Boolean).length;
  if (branch !== "dev" || dirty) {
    warn(`${c.path}: on ${branch}${dirty ? `, dirty (${count(dirty, "file")})` : ""}; left alone\n`);
    return true;
  }
  const before = git(c.path, ["rev-parse", "HEAD"], env).out.trim();
  const merged = git(c.path, ["merge", "--ff-only", "--quiet", "origin/dev"], env);
  if (!merged.ok) {
    warn(`${c.path}: dev does not fast-forward to origin/dev ${reason(merged)}; left alone\n`);
    return true;
  }
  const after = git(c.path, ["rev-parse", "HEAD"], env).out.trim();
  if (after !== before) write(`${c.path}: dev fast-forwarded to ${after.slice(0, 7)}\n`);
  return true;
}

/**
 * The repository's drift from dev as one line (story 35): the branches with commits dev lacks (main and dev left out),
 * counted in the checkout from the remote-tracking refs its fetch just refreshed; and the open pull requests into dev,
 * one GitHub request, or none when `gh` is null. Null when there is neither.
 */
export async function drift(
  c: Checkout,
  gh: GitHub | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const refs = git(c.path, ["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin/"], env);
  const others = refs.out
    .split(/\r?\n/)
    .filter((n) => n && n !== "HEAD" && n !== "main" && n !== "dev")
    .sort();
  const ahead: string[] = [];
  for (const name of others) {
    const n = git(c.path, ["rev-list", "--count", `origin/dev..origin/${name}`], env);
    if (n.ok && Number(n.out.trim()) > 0) ahead.push(name);
  }
  const numbers: number[] = [];
  if (gh) {
    const pulls = await gh.getList<Pull>(`/repos/${c.repo}/pulls?state=open&base=dev&per_page=100`);
    numbers.push(...pulls.map((p) => p.number).sort((a, b) => a - b));
  }
  if (!ahead.length && !numbers.length) return null;
  const parts: string[] = [];
  if (ahead.length) parts.push(`${count(ahead.length, "branch", "branches")} ahead of dev (${ahead.join(", ")})`);
  if (numbers.length)
    parts.push(`${count(numbers.length, "open pull request")} (${numbers.map((n) => `#${n}`).join(", ")})`);
  return `${c.repo}: ${parts.join(", ")}`;
}
