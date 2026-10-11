// branches: the branch rules of ADR-0013, applied through GitHub REST to each repository named (default: the ones the
// token owns). main, dev and any branch ending in -keep are never deleted and never the target of a request. A branch
// whose pull request was merged into dev, or whose commits are all in dev, is deleted. A branch whose pull request was
// closed without merging gets a tag archive/<name> at its head, then is deleted. Every other branch is left alone and
// listed with why. Pull requests are never touched. --plan lists every tag and delete without making them; --json
// carries the same lists. A repository the token cannot read or write is reported and skipped; the others still run.
import { github, GitHubError, type GitHub } from "../github.js";
import { isRepoName } from "../release.js";

/** The branch names the rules never delete: the two core branches and the one keep marker (ADR-0013). */
export function isKeptName(name: string): boolean {
  return name === "main" || name === "dev" || name.endsWith("-keep");
}

export interface BranchLine {
  /** "-" a delete (with its tag, when one is made), "!" a problem, "." a branch left alone or a note, "=" the kept names */
  mark: "-" | "!" | "." | "=";
  text: string;
}

export interface RepoReport {
  repo: string;
  /** main, dev and *-keep: never deleted, never asked about */
  kept: string[];
  deleted: Array<{ branch: string; reason: string }>;
  /** the archive tags made before a delete; `reused` when a tag at the same commit was there already */
  archived: Array<{ branch: string; tag: string; commit: string; reused: boolean }>;
  left: Array<{ branch: string; why: string }>;
  /** why the repository was not (fully) done; null when it was */
  skipped: string | null;
  /** the red lines: an unreachable or unwritable repository, a tag in the way; exit 1 when any */
  problems: string[];
  lines: BranchLine[];
}

export interface BranchesReport {
  plan: boolean;
  repos: RepoReport[];
  ok: boolean;
}

export interface BranchesOptions {
  /** owner/repo each; none means the repositories the token owns */
  repos: string[];
  plan: boolean;
  json: boolean;
  quiet: boolean;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  warn?: (text: string) => void;
}

interface Branch {
  name: string;
  commit: { sha: string };
  protected?: boolean;
}

interface Pull {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; sha: string };
}

interface Compare {
  ahead_by: number;
}

interface Ref {
  ref: string;
  object: { sha: string };
}

interface UserRepo {
  full_name: string;
  archived?: boolean;
}

/** A ref name in a URL path: each segment encoded, the slashes kept, as GitHub's ref routes expect. */
const refPath = (name: string): string => name.split("/").map(encodeURIComponent).join("/");

const short = (sha: string): string => sha.slice(0, 7);

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Why a GitHub call failed, without the URL its message starts with. */
function detail(e: unknown): string {
  if (e instanceof GitHubError)
    return e.message.startsWith(e.url + ": ") ? e.message.slice(e.url.length + 2) : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Apply the rules (or plan them), print the report. Exit code: 0 all done or planned, 1 something reported, 2 bad usage. */
export async function runBranches(options: BranchesOptions): Promise<number> {
  const env = options.env ?? process.env;
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const warn = options.warn ?? ((text: string) => void process.stderr.write(text));
  const bad = options.repos.filter((r) => !isRepoName(r));
  if (bad.length) {
    warn(`branches: name each repository as owner/repo, not ${bad.join(", ")}\n`);
    return 2;
  }
  const gh = github(env);
  let repos = [...new Set(options.repos)];
  if (!repos.length) {
    if (!gh.hasToken) {
      warn("branches: a token is needed to list your repositories: set GITHUB_TOKEN or GH_TOKEN, or name owner/repo\n");
      return 2;
    }
    try {
      repos = await ownRepos(gh);
    } catch (e) {
      warn(`branches: cannot list your repositories: ${detail(e)}\n`);
      return 1;
    }
  }
  const report: BranchesReport = { plan: options.plan, repos: [], ok: true };
  for (const repo of repos) report.repos.push(await cleanRepo(gh, repo, options.plan));
  report.ok = report.repos.every((r) => !r.problems.length);
  write(options.json ? JSON.stringify(report, null, 2) + "\n" : branchesText(report, options.quiet));
  return report.ok ? 0 : 1;
}

/** The repositories the token's user owns, archived ones left out (they are read-only), sorted. */
async function ownRepos(gh: GitHub): Promise<string[]> {
  const list = await gh.getList<UserRepo>("/user/repos?affiliation=owner&per_page=100");
  return list
    .filter((r) => !r.archived)
    .map((r) => r.full_name)
    .sort();
}

/**
 * One repository: list its branches, decide each by the rules, make (or plan) the tags and deletes. Any GitHub error
 * stops this repository where it is, reported, and the next repository still runs.
 */
export async function cleanRepo(gh: GitHub, repo: string, plan: boolean): Promise<RepoReport> {
  const r: RepoReport = { repo, kept: [], deleted: [], archived: [], left: [], skipped: null, problems: [], lines: [] };
  const skip = (reason: string) => {
    r.skipped = reason;
    r.problems.push(reason);
    r.lines.push({ mark: "!", text: `skipped: ${reason}` });
  };
  let branches: Branch[];
  try {
    branches = await gh.getList<Branch>(`/repos/${repo}/branches?per_page=100`);
  } catch (e) {
    skip(`cannot read branches: ${detail(e)}`);
    return r;
  }
  if (!branches.some((b) => b.name === "dev")) {
    // the rules compare with dev; a repository without one is not in this flow, and that is not a problem
    r.skipped = "no dev branch";
    r.lines.push({ mark: ".", text: "skipped: no dev branch" });
    return r;
  }
  const owner = repo.split("/")[0];
  const sorted = [...branches].sort((a, z) => a.name.localeCompare(z.name));
  // the kept names are known from the listing alone: nothing is ever asked about them
  r.kept = sorted.filter((b) => isKeptName(b.name)).map((b) => b.name);
  const keptLine = () => {
    if (r.kept.length) r.lines.push({ mark: "=", text: `kept: ${r.kept.join(", ")}` });
  };
  for (const b of sorted) {
    if (isKeptName(b.name)) continue;
    try {
      await decide(gh, repo, owner, b, plan, r);
    } catch (e) {
      const status = e instanceof GitHubError ? e.status : 0;
      keptLine();
      skip(`${status === 403 || status === 404 ? "cannot write" : "GitHub"}: ${detail(e)}`);
      return r;
    }
  }
  keptLine();
  return r;
}

/** The rules for one branch that is not main, dev or *-keep. Writes go through here only when `plan` is false. */
async function decide(gh: GitHub, repo: string, owner: string, b: Branch, plan: boolean, r: RepoReport): Promise<void> {
  const left = (why: string) => {
    r.left.push({ branch: b.name, why });
    r.lines.push({ mark: ".", text: `${b.name}  left: ${why}` });
  };
  const remove = async (reason: string, tag = "") => {
    if (!plan) await gh.del(`/repos/${repo}/git/refs/heads/${refPath(b.name)}`);
    r.deleted.push({ branch: b.name, reason });
    r.lines.push({ mark: "-", text: `${b.name}  ${tag}${plan ? "delete" : "deleted"}: ${reason}` });
  };
  if (b.protected) return left("protected on GitHub");
  const pulls = await gh.getList<Pull>(
    `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${b.name}`)}&per_page=100`,
  );
  const pr = (p: Pull) => `pull request #${p.number}`;
  // deleting a branch closes its open pull request, and pull requests are never touched
  const open = pulls.find((p) => p.state === "open");
  if (open) return left(`open ${pr(open)}`);
  const intoDev = pulls.find((p) => p.merged_at && p.base.ref === "dev");
  if (intoDev && intoDev.head.sha === b.commit.sha) return remove(`${pr(intoDev)} merged into dev`);
  const cmp = await gh.getJson<Compare>(`/repos/${repo}/compare/dev...${refPath(b.name)}`);
  if (cmp.ahead_by === 0) return remove("all commits are in dev");
  // merged, but commits came after the merge: nothing of them is in dev, so the branch stays
  if (intoDev) return left(`${pr(intoDev)} merged into dev, then ${count(cmp.ahead_by, "commit")} more`);
  const merged = pulls.find((p) => p.merged_at);
  if (merged) return left(`${pr(merged)} merged into ${merged.base.ref}, ${count(cmp.ahead_by, "commit")} not in dev`);
  const closed = pulls.find((p) => p.state === "closed" && !p.merged_at);
  if (!closed) return left(`no pull request, ${count(cmp.ahead_by, "commit")} not in dev`);
  const tag = `archive/${b.name}`;
  let existing: Ref | null = null;
  try {
    existing = await gh.getJson<Ref>(`/repos/${repo}/git/ref/tags/${refPath(tag)}`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
  }
  if (existing && existing.object.sha !== b.commit.sha) {
    const why = `${tag} exists at ${short(existing.object.sha)}, the branch is at ${short(b.commit.sha)}`;
    r.left.push({ branch: b.name, why });
    r.problems.push(`${b.name}: ${why}; left alone`);
    r.lines.push({ mark: "!", text: `${b.name}  ${why}; left alone` });
    return;
  }
  if (!existing && !plan) await gh.post(`/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: b.commit.sha });
  r.archived.push({ branch: b.name, tag, commit: b.commit.sha, reused: !!existing });
  const made = existing ? `${tag} already at` : `${plan ? "tag" : "tagged"} ${tag} at`;
  await remove(`${pr(closed)} closed without merging`, `${made} ${short(b.commit.sha)}, `);
}

/** The text a user reads. Quiet: only the changes and the problems, under their repository, and the summary when any. */
export function branchesText(report: BranchesReport, quiet: boolean): string {
  const out: string[] = [];
  const show = (l: BranchLine) => !quiet || l.mark === "-" || l.mark === "!";
  for (const r of report.repos) {
    const lines = r.lines.filter(show);
    if (lines.length) out.push(r.repo, ...lines.map((l) => `${l.mark} ${l.text}`));
  }
  const sum = (key: "deleted" | "archived" | "left" | "kept" | "problems") =>
    report.repos.reduce((n, r) => n + r[key].length, 0);
  const problems = sum("problems");
  const summary = [
    `${sum("deleted")} ${report.plan ? "to delete" : "deleted"}`,
    `${sum("archived")} ${report.plan ? "to tag" : "tagged"}`,
    ...(quiet ? [] : [`${sum("left")} left alone`, `${sum("kept")} kept`]),
    ...(problems ? [count(problems, "problem")] : []),
  ];
  if (!quiet || out.length) out.push(`${report.plan ? "plan" : "branches"}: ${summary.join(", ")}`);
  return out.length ? out.join("\n") + "\n" : "";
}
