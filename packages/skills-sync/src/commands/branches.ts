// branches: the branch rules of ADR-0013, applied through GitHub REST to each repository named (default: the ones the
// token owns). main, dev, the repository's default branch, any branch ending in -keep and any research/ or prototype/
// branch are never deleted and never the target of a request. A branch whose pull request was merged into dev, or whose
// commits are all in dev, is deleted. A branch whose pull request was closed without merging gets a tag archive/<name>
// at its head, then is deleted. Every other branch is left alone and listed with why. Pull requests are never touched:
// a branch that is the head or the base of an open one stays. --plan lists every tag and delete without making them;
// --json carries the same lists. A repository the token cannot read or write is reported and skipped; the others still
// run.
import { github, GitHubError, type GitHub } from "../github.js";
import { isRepoName } from "../release.js";

export interface BranchLine {
  /** "-" a delete (with its tag, when one is made), "!" a problem, "." a branch left alone or a note, "=" the kept names */
  mark: "-" | "!" | "." | "=";
  text: string;
}

export interface RepoReport {
  repo: string;
  /** main, dev, the default branch, *-keep, research/* and prototype/*: never deleted, never asked about */
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

interface Repository {
  default_branch?: string;
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

/** One repository being cleaned: what every rule needs to know, and the report it writes into. */
interface Job {
  gh: GitHub;
  repo: string;
  /** the repository's owner, the `owner:` half of a pull request's head */
  owner: string;
  plan: boolean;
  r: RepoReport;
}

/**
 * The branch names the rules never delete: the two core branches, the keep marker, and research and prototype work
 * (ADR-0013; Justin, 2026-10-11: research/ and prototype/ branches are kept, merged or not). Exact and case-sensitive
 * on purpose: `Main`, `DEV`, `-Keep` or `Research/x` are other branches, and a rule that guesses is a rule nobody can
 * predict.
 */
const isKeptName = (name: string): boolean =>
  name === "main" ||
  name === "dev" ||
  name.endsWith("-keep") ||
  name.startsWith("research/") ||
  name.startsWith("prototype/");

/** A ref name in a URL path: each segment encoded, the slashes kept, as GitHub's ref routes expect. */
const refPath = (name: string): string => name.split("/").map(encodeURIComponent).join("/");

const short = (sha: string): string => sha.slice(0, 7);

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;

/** Why a call failed: GitHub's status and message, or the error's text. */
const detail = (e: unknown): string =>
  e instanceof GitHubError ? e.detail : e instanceof Error ? e.message : String(e);

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
 * One repository: read it and its branches, decide each by the rules, make (or plan) the tags and deletes. Any GitHub
 * error stops this repository where it is, reported, and the next repository still runs.
 */
async function cleanRepo(gh: GitHub, repo: string, plan: boolean): Promise<RepoReport> {
  const r: RepoReport = { repo, kept: [], deleted: [], archived: [], left: [], skipped: null, problems: [], lines: [] };
  const skip = (reason: string) => {
    r.skipped = reason;
    r.problems.push(reason);
    r.lines.push({ mark: "!", text: `skipped: ${reason}` });
  };
  let defaultBranch: string;
  let branches: Branch[];
  try {
    // GitHub refuses to delete the default branch (422), so it is kept like main, whatever it is called
    defaultBranch = (await gh.getJson<Repository>(`/repos/${repo}`)).default_branch ?? "main";
    branches = await gh.getList<Branch>(`/repos/${repo}/branches?per_page=100`);
  } catch (e) {
    skip(`cannot read repository: ${detail(e)}`);
    return r;
  }
  if (!branches.some((b) => b.name === "dev")) {
    // the rules compare with dev; a repository without one is not in this flow, and that is not a problem
    r.skipped = "no dev branch";
    r.lines.push({ mark: ".", text: "skipped: no dev branch" });
    return r;
  }
  const kept = (name: string) => isKeptName(name) || name === defaultBranch;
  const sorted = [...branches].sort((a, z) => a.name.localeCompare(z.name));
  // the kept names are known from the listing alone: nothing is ever asked about them
  r.kept = sorted.filter((b) => kept(b.name)).map((b) => b.name);
  const keptLine = () => {
    if (r.kept.length) r.lines.push({ mark: "=", text: `kept: ${r.kept.join(", ")}` });
  };
  const job: Job = { gh, repo, owner: repo.split("/")[0], plan, r };
  for (const b of sorted) {
    if (kept(b.name)) continue;
    try {
      await decide(job, b);
    } catch (e) {
      keptLine();
      // the only writes are the ref routes; a 403 or 404 there is the token's reach, anywhere else it is GitHub's answer
      const write = e instanceof GitHubError && (e.status === 403 || e.status === 404) && e.url.includes("/git/refs");
      skip(`${write ? "cannot write" : "GitHub"}: ${detail(e)}`);
      return r;
    }
  }
  keptLine();
  return r;
}

/** The rules for one branch that is not kept. Writes go through here only when `plan` is false. */
async function decide({ gh, repo, owner, plan, r }: Job, b: Branch): Promise<void> {
  const left = (why: string) => {
    r.left.push({ branch: b.name, why });
    r.lines.push({ mark: ".", text: `${b.name}  left: ${why}` });
  };
  /**
   * Before the first write to this branch, read its head again: a push since the listing means the rules decided on
   * a branch that no longer exists as read, so it stays. Planning writes nothing and so reads nothing more.
   */
  const stillAtHead = async (): Promise<boolean> => {
    if (plan) return true;
    const ref = await gh.getJson<Ref>(`/repos/${repo}/git/ref/heads/${refPath(b.name)}`);
    return ref.object.sha === b.commit.sha;
  };
  /** Delete the branch (unless planning); `prefix` names the tag made first, when one was; `checked` says the head was re-read. */
  const remove = async (reason: string, prefix = "", checked = false) => {
    if (!checked && !(await stillAtHead())) return left("moved during the run");
    if (!plan) await gh.del(`/repos/${repo}/git/refs/heads/${refPath(b.name)}`);
    r.deleted.push({ branch: b.name, reason });
    r.lines.push({ mark: "-", text: `${b.name}  ${prefix}${plan ? "delete" : "deleted"}: ${reason}` });
  };
  if (b.protected) return left("protected on GitHub");
  const pulls = await gh.getList<Pull>(
    `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${b.name}`)}&per_page=100`,
  );
  const pr = (p: Pull) => `pull request #${p.number}`;
  // deleting a branch closes its open pull request, and pull requests are never touched
  const open = pulls.find((p) => p.state === "open");
  if (open) return left(`open ${pr(open)}`);
  // nor is a pull request whose base this branch is (a stacked pull request): GitHub would close or retarget it
  const stacked = await gh.getList<Pull>(
    `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(b.name)}&per_page=100`,
  );
  if (stacked.length) return left(`base of open ${pr(stacked.sort((a, z) => a.number - z.number)[0])}`);
  const mergedIntoDev = (p: Pull) => !!p.merged_at && p.base.ref === "dev";
  // the pull request that merged this very head, else the latest merged into dev (GitHub lists newest first)
  const intoDev = pulls.find((p) => mergedIntoDev(p) && p.head.sha === b.commit.sha) ?? pulls.find(mergedIntoDev);
  if (intoDev && intoDev.head.sha === b.commit.sha) return remove(`${pr(intoDev)} merged into dev`);
  const cmp = await gh.getJson<Compare>(`/repos/${repo}/compare/dev...${refPath(b.name)}`);
  if (cmp.ahead_by === 0) return remove("all commits are in dev");
  const elsewhere = pulls.find((p) => p.merged_at && p.base.ref !== "dev");
  // merged, but commits came after the merge: nothing of them is in dev, so the branch stays
  if (intoDev)
    return left(
      `${pr(intoDev)} merged into dev, then ${count(cmp.ahead_by, "commit")} more` +
        (elsewhere ? `; ${pr(elsewhere)} merged into ${elsewhere.base.ref}` : ""),
    );
  if (elsewhere)
    return left(`${pr(elsewhere)} merged into ${elsewhere.base.ref}, ${count(cmp.ahead_by, "commit")} not in dev`);
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
  if (!(await stillAtHead())) return left("moved during the run");
  if (!existing && !plan) await gh.post(`/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: b.commit.sha });
  r.archived.push({ branch: b.name, tag, commit: b.commit.sha, reused: !!existing });
  const made = existing ? `${tag} already at` : `${plan ? "tag" : "tagged"} ${tag} at`;
  await remove(`${pr(closed)} closed without merging`, `${made} ${short(b.commit.sha)}, `, true);
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
