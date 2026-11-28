import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import type { Context, Issue, Item, Project } from "../types.ts";
import {
  protectedIssue,
  statuses,
  views,
  workflowsOn,
  callerPath,
  addItem,
  ensureField,
  ensureView,
  getItems,
  getProject,
} from "../project.ts";
import { listIssues } from "./backlog.ts";
import { optional, command, GitHubError } from "../github.ts";

export async function prepareBoard(ctx: Context, project: Project): Promise<void> {
  await ensureField(ctx, project, "Status", "SINGLE_SELECT", statuses);
  await ensureView(ctx, project, views[1]);
  for (const workflow of project.workflows.nodes) {
    if (workflow.name !== "Auto-close issue" || !workflow.enabled) continue;
    ctx.log("turn off Auto-close issue");
    if (!ctx.plan)
      await ctx.api.graphql(
        `mutation($id:ID!) { deleteProjectV2Workflow(input:{workflowId:$id}) { deletedWorkflowId } }`,
        { id: workflow.id },
      );
  }
  for (const name of workflowsOn) {
    if (!project.workflows.nodes.some((w) => w.name === name && w.enabled))
      ctx.log(`manual: enable ${name} at ${project.url}/workflows`);
  }
}
export interface Ticket {
  status?: string;
  state: string;
  labels: string[];
  assignees: number;
}
export function backfillStatus(ticket: Ticket, bootstrap = false): string | undefined {
  if (protectedIssue(ticket.labels)) return;
  if (ticket.state.toUpperCase() === "CLOSED") return ticket.status === "Complete" ? "Complete" : "Done";
  if (ticket.assignees > 0 && (!ticket.status || ticket.status === "Todo")) return "Next Up";
  if (!ticket.status || (bootstrap && ticket.status === "Next Up" && !ticket.assignees)) return "Todo";
}
export function transition(ticket: Ticket, to: string, from?: string[]): boolean {
  return (
    !protectedIssue(ticket.labels) &&
    ticket.status !== to &&
    (ticket.state.toUpperCase() !== "CLOSED" || ["Done", "Complete"].includes(to)) &&
    (!from || from.includes(ticket.status ?? ""))
  );
}
// GitHub's closing keywords followed by a same-repository #n. GitHub fills closing references only for pull requests
// into the default branch, so a pull request into a staging or integration branch is read from its body instead.
export function bodyIssues(body: string): number[] {
  const found = body.matchAll(/(?:^|[^A-Za-z0-9_])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)/gi);
  return [...found].map((match) => Number(match[1])).filter((n) => n > 0);
}
export function branchIssue(ref: string): number | undefined {
  const match = /^[^/]+\/(\d+)-/.exec(ref);
  return match && Number(match[1]) > 0 ? Number(match[1]) : undefined;
}
function belongs(ctx: Context, item: Item): boolean {
  return (
    item.content?.__typename === "Issue" &&
    item.content.repository?.nameWithOwner.toLowerCase() === ctx.repo.full_name.toLowerCase()
  );
}
function itemTicket(item: Item): Ticket {
  return {
    status: item.status?.name,
    state: item.content?.state ?? "",
    labels: item.content?.labels?.nodes.map((l) => l.name) ?? [],
    assignees: item.content?.assignees?.totalCount ?? 0,
  };
}
async function setStatus(ctx: Context, project: Project, item: string, to: string): Promise<void> {
  const field = project.fields.nodes.find((f) => f.name === "Status");
  const option = field?.options?.find((o) => o.name === to)?.id;
  if (!field || !option) throw new Error(`Missing Status option ${to}; run setup first`);
  await ctx.api.graphql(
    `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!) { updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}) { projectV2Item { id } } }`,
    { p: project.id, i: item, f: field.id, o: option },
  );
}
// Close an open issue whose work reached the integration branch: drop needs-changes, comment, then close.
async function closeIssue(ctx: Context, n: number, pr: number | string, integration: string, labels: string[]) {
  ctx.log(`${ctx.plan ? "would close" : "close"} #${n} merged into ${integration} by #${pr}`);
  if (ctx.plan) return;
  if (labels.includes("needs-changes"))
    await ctx.api.rest("DELETE", `repos/${ctx.repo.full_name}/issues/${n}/labels/needs-changes`);
  await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/issues/${n}/comments`, {
    body: `Merged into \`${integration}\` by #${pr}.`,
  });
  await ctx.api.rest("PATCH", `repos/${ctx.repo.full_name}/issues/${n}`, {
    state: "closed",
    state_reason: "completed",
  });
}

export interface Pull {
  number: number;
  state: string;
  draft?: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  body: string | null;
  head: { ref: string };
  base: { ref: string };
}
// The tickets a pull request works on: its branch's number and the issues its body closes. "Refs #n" is not one.
export function pullTickets(pull: Pull): number[] {
  const branch = branchIssue(pull.head.ref);
  return [...new Set([...(branch ? [branch] : []), ...bodyIssues(pull.body ?? "")])];
}
// What git says about one open ticket, strongest first: a merged pull request in the integration branch closes it;
// one merged into the staging branch but not there yet is Review; an open pull request is Review (ready) or In
// Progress (draft); a pushed numbered branch is In Progress, only from Todo, Next Up or no Status.
export type Evidence = { close: number } | { to: string; from?: string[] };
export async function evidence(
  pulls: Pull[],
  branch: boolean,
  inIntegration: (sha: string) => Promise<boolean>,
  staging: string,
): Promise<Evidence | undefined> {
  const merged = pulls.filter((p) => p.merged_at && p.merge_commit_sha);
  for (const pull of merged) if (await inIntegration(pull.merge_commit_sha!)) return { close: pull.number };
  if (staging && merged.some((p) => p.base.ref === staging)) return { to: "Review" };
  const open = pulls.filter((p) => p.state === "open");
  if (open.some((p) => !p.draft)) return { to: "Review" };
  if (open.length) return { to: "In Progress" };
  if (branch) return { to: "In Progress", from: ["", "Todo", "Next Up"] };
}

// Backfill reads git as well as issue state: env carries INTEGRATION_BRANCH (default dev) and STAGING_BRANCH.
export async function backfill(ctx: Context, project: Project, bootstrap = false, env: Event = {}): Promise<void> {
  const integration = env.INTEGRATION_BRANCH || "dev";
  const staging = env.STAGING_BRANCH || "";
  const items = (await getItems(ctx, project)).filter((item) => belongs(ctx, item));
  const pulls = await ctx.api.pages<Pull>(`repos/${ctx.repo.full_name}/pulls?state=all`);
  const branches = new Set(
    (await ctx.api.pages<{ name: string }>(`repos/${ctx.repo.full_name}/branches`))
      .map((b) => branchIssue(b.name))
      .filter((n) => n !== undefined),
  );
  const byTicket = new Map<number, Pull[]>();
  for (const pull of pulls) for (const n of pullTickets(pull)) byTicket.set(n, [...(byTicket.get(n) ?? []), pull]);
  const known = new Map<string, boolean>();
  const inIntegration = async (sha: string) => {
    if (!known.has(sha)) {
      const compare = await optional(() =>
        ctx.api.rest<{ status: string }>(
          "GET",
          `repos/${ctx.repo.full_name}/compare/${encodeURIComponent(integration)}...${sha}`,
        ),
      );
      known.set(sha, compare?.status === "identical" || compare?.status === "behind");
    }
    return known.get(sha)!;
  };
  // fromGit <n> <ticket>: the Status git gives an open ticket, after closing it when its work is in integration;
  // null when git found the ticket's work but it stays where it is; undefined when git knows nothing of it.
  const fromGit = async (n: number, ticket: Ticket): Promise<string | null | undefined> => {
    if (ticket.state.toUpperCase() !== "OPEN" || protectedIssue(ticket.labels)) return;
    // A reopened ticket sent back with needs-changes waits for new work, not for the pull request already merged.
    const found = await evidence(
      (byTicket.get(n) ?? []).filter((p) => !(ticket.labels.includes("needs-changes") && p.merged_at)),
      branches.has(n),
      inIntegration,
      staging,
    );
    if (!found) return;
    if ("close" in found) {
      await closeIssue(ctx, n, found.close, integration, ticket.labels);
      return "Done";
    }
    if (found.to === "Review" && ticket.labels.includes("wayfinder:research")) return null;
    if (found.from && !found.from.includes(ticket.status ?? "")) return null;
    return found.to;
  };
  for (const item of items) {
    const ticket = itemTicket(item);
    const n = item.content!.number!;
    const git = await fromGit(n, ticket);
    const to = git === undefined ? backfillStatus(ticket, bootstrap) : git;
    if (!to || !transition(ticket, to)) continue;
    ctx.log(`${ctx.plan ? "would move" : "move"} #${n}: ${ticket.status ?? "none"} -> ${to}`);
    if (!ctx.plan) await setStatus(ctx, project, item.id, to);
  }
  const seen = new Set(items.map((item) => item.content!.number));
  for (const issue of await listIssues(ctx, "open")) {
    const labels = issue.labels.map((l) => l.name);
    if (seen.has(issue.number) || protectedIssue(labels)) continue;
    const ticket = { state: issue.state, labels, assignees: issue.assignees.length };
    const to = (await fromGit(issue.number, ticket)) || (issue.assignees.length ? "Next Up" : "Todo");
    ctx.log(`${ctx.plan ? "would add" : "add"} #${issue.number}: ${to}`);
    if (!ctx.plan) await setStatus(ctx, project, await addItem(ctx, project, issue.node_id), to);
  }
}

export type Event = Record<string, string | undefined>;
export async function runEvent(ctx: Context, project: Project, event: Event): Promise<void> {
  // Read items once, then update this snapshot after each successful move.
  const items = (await getItems(ctx, project)).filter((item) => belongs(ctx, item));
  const getIssue = (number: number) =>
    optional(() => ctx.api.rest<Issue>("GET", `repos/${ctx.repo.full_name}/issues/${number}`));
  const move = async (number: number, to: string, from?: string[]) => {
    const issue = await getIssue(number);
    if (!issue || issue.pull_request) {
      ctx.log(`skip #${number}: not an issue of ${ctx.repo.full_name}`);
      return;
    }
    const item = items.find((i) => i.content?.number === number);
    const ticket = {
      status: item?.status?.name,
      state: issue.state,
      labels: issue.labels.map((l) => l.name),
      assignees: issue.assignees.length,
    };
    if (!transition(ticket, to, from) || (to === "Review" && ticket.labels.includes("wayfinder:research"))) {
      ctx.log(`kept #${number}`);
      return;
    }
    ctx.log(`${ctx.plan ? "would move" : "move"} #${number}: ${ticket.status ?? "none"} -> ${to}`);
    if (!ctx.plan) {
      await setStatus(ctx, project, item?.id ?? (await addItem(ctx, project, issue.node_id)), to);
      if (item) item.status = { name: to };
    }
  };
  const positive = (value: string | undefined, name: string) => {
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`${name} must be a positive issue/PR number`);
    return Number(value);
  };
  const linked = async (pr = positive(event.PR, "PR")) => {
    const numbers = new Set<number>();
    const unchecked = new Set<number>();
    let after: string | null = null;
    let closing = false;
    do {
      const data: {
        repository: {
          pullRequest: {
            headRefName: string;
            body: string | null;
            closingIssuesReferences: {
              nodes: { number: number; repository: { nameWithOwner: string } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string };
            };
          };
        };
      } = await ctx.api.graphql(
        `query($owner:String!,$name:String!,$pr:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$pr) {
          headRefName body closingIssuesReferences(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { number repository { nameWithOwner } } } } } }`,
        { owner: ctx.repo.owner.login, name: ctx.repo.name, pr, after },
      );
      const pull = data.repository.pullRequest;
      if (pull.closingIssuesReferences.nodes.length) closing = true;
      for (const issue of pull.closingIssuesReferences.nodes)
        if (issue.repository.nameWithOwner.toLowerCase() === ctx.repo.full_name.toLowerCase())
          numbers.add(issue.number);
      const branch = branchIssue(pull.headRefName);
      if (branch) unchecked.add(branch);
      if (!after && !closing) for (const n of bodyIssues(pull.body ?? "")) unchecked.add(n);
      after = pull.closingIssuesReferences.pageInfo.hasNextPage
        ? pull.closingIssuesReferences.pageInfo.endCursor
        : null;
    } while (after);
    for (const n of unchecked) {
      if (numbers.has(n)) continue;
      const issue = await getIssue(n);
      if (issue && !issue.pull_request) numbers.add(n);
    }
    return [...numbers].sort((a, b) => a - b);
  };
  const startFrom = ["", "Todo", "Next Up"];
  const integration = event.INTEGRATION_BRANCH || "dev";
  const release = event.RELEASE_BRANCH || "main";
  const staging = event.STAGING_BRANCH || "";
  const closeMerged = async (n: number, pr: number | string) => {
    const issue = await getIssue(n);
    if (!issue || issue.pull_request || protectedIssue(issue.labels.map((l) => l.name))) return;
    if (issue.state.toLowerCase() === "open")
      await closeIssue(
        ctx,
        n,
        pr,
        integration,
        issue.labels.map((l) => l.name),
      );
    await move(n, "Done");
  };
  // A push of PUSH_BEFORE..PUSH_AFTER into the integration branch lands every pull request into the staging branch
  // whose merge commit it brings; one already in PUSH_BEFORE landed with an earlier push.
  const landStaged = async () => {
    const before = event.PUSH_BEFORE ?? "";
    const head = event.PUSH_AFTER ?? "";
    if (/^0+$/.test(before)) return ctx.log(`kept: ${integration} is a new branch, nothing to compare`);
    if (!before || !head) throw new Error(`A push to ${integration} needs PUSH_BEFORE and PUSH_AFTER`);
    const commits = new Set<string>();
    for (let page = 1; ; page++) {
      const compare = await optional(() =>
        ctx.api.rest<{ total_commits: number; commits: { sha: string }[] }>(
          "GET",
          `repos/${ctx.repo.full_name}/compare/${before}...${head}?per_page=100&page=${page}`,
        ),
      );
      if (!compare) return ctx.log(`kept: GitHub cannot compare ${before}...${head}, nothing closed`);
      for (const commit of compare.commits) commits.add(commit.sha);
      if (!compare.commits.length || commits.size >= compare.total_commits) break;
    }
    const pulls = await ctx.api.pages<{ number: number; merge_commit_sha: string | null; merged_at: string | null }>(
      `repos/${ctx.repo.full_name}/pulls?state=closed&base=${encodeURIComponent(staging)}`,
    );
    let landed = 0;
    for (const pull of pulls) {
      if (!pull.merged_at || !pull.merge_commit_sha || !commits.has(pull.merge_commit_sha)) continue;
      ctx.log(`landed #${pull.number}: merged into ${staging}, now in ${integration}`);
      for (const n of await linked(pull.number)) await closeMerged(n, pull.number);
      landed++;
    }
    ctx.log(`landed ${landed} pull request(s) from ${staging} on push to ${integration}`);
  };
  switch (`${event.EVENT}/${event.ACTION ?? ""}`) {
    case "issues/assigned":
      await move(positive(event.ISSUE, "ISSUE"), "Next Up", ["", "Todo"]);
      return;
    case "issues/unassigned": {
      const n = positive(event.ISSUE, "ISSUE");
      if ((await getIssue(n))?.assignees.length === 0) await move(n, "Todo", ["Next Up", "In Progress", "Review"]);
      return;
    }
    case "issues/reopened": {
      const n = positive(event.ISSUE, "ISSUE");
      if ((await getIssue(n))?.labels.some((l) => l.name === "needs-changes")) await move(n, "In Progress");
      return;
    }
    case "issues/labeled":
      if (event.LABEL === "needs-changes") await move(positive(event.ISSUE, "ISSUE"), "In Progress");
      return;
    case "pull_request/opened":
    case "pull_request/ready_for_review":
      for (const n of await linked())
        await move(
          n,
          event.PR_DRAFT === "true" ? "In Progress" : "Review",
          event.PR_DRAFT === "true" ? startFrom : [...startFrom, "In Progress"],
        );
      return;
    case "pull_request/converted_to_draft":
      for (const n of await linked()) await move(n, "In Progress", ["Review"]);
      return;
    case "pull_request_review/submitted":
      if (event.REVIEW_STATE === "changes_requested")
        for (const n of await linked()) await move(n, "In Progress", ["Review"]);
      return;
    case "pull_request/closed":
      if (event.PR_MERGED !== "true" || event.PR_BASE !== integration) return;
      for (const n of await linked()) await closeMerged(n, event.PR!);
      return;
  }
  if (event.EVENT === "create" && event.REF_TYPE === "branch") {
    const number = branchIssue(event.REF ?? "");
    if (number) await move(number, "In Progress", startFrom);
  } else if (event.EVENT === "start" || (event.EVENT === "workflow_dispatch" && event.START)) {
    await move(positive(event.EVENT === "start" ? event.ISSUE : event.START, "ISSUE/START"), "In Progress", startFrom);
  } else if (event.EVENT === "workflow_dispatch" && event.BACKFILL === "true") {
    await backfill(ctx, project);
  } else if (event.EVENT === "push" && event.PUSH_REF === `refs/heads/${release}`) {
    for (const item of items) if (item.status?.name === "Done") await move(item.content!.number!, "Complete", ["Done"]);
  } else if (event.EVENT === "push" && staging && event.PUSH_REF === `refs/heads/${integration}`) {
    await landStaged();
  } else ctx.log(`kept: no rule for ${event.EVENT}/${event.ACTION ?? ""}`);
}

interface FileContent {
  content: string;
  sha: string;
}
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
// A caller may name its own staging branch; every other line must match the template.
const stagingLine = /^[ \t]*staging-branch:.*$/m;
async function branchSha(ctx: Context, branch: string): Promise<string | undefined> {
  return (
    await optional(() =>
      ctx.api.rest<{ object: { sha: string } }>(
        "GET",
        `repos/${ctx.repo.full_name}/git/ref/heads/${encodeURIComponent(branch)}`,
      ),
    )
  )?.object.sha;
}
async function baseBranch(ctx: Context): Promise<string> {
  return (await branchSha(ctx, "dev")) ? "dev" : ctx.repo.default_branch;
}
const content = (ctx: Context, branch: string) =>
  optional(() =>
    ctx.api.rest<FileContent>(
      "GET",
      `repos/${ctx.repo.full_name}/contents/${callerPath}?ref=${encodeURIComponent(branch)}`,
    ),
  );
export async function ensureCaller(ctx: Context, template?: string): Promise<boolean> {
  let wanted = normalize(template ?? (await readFile(new URL("../../caller.yml", import.meta.url), "utf8")));
  const base = await baseBranch(ctx);
  const live = await content(ctx, base);
  if (live) {
    const have = normalize(Buffer.from(live.content, "base64").toString("utf8"));
    const own = stagingLine.exec(have)?.[0];
    if (own && stagingLine.test(wanted)) wanted = wanted.replace(stagingLine, () => own);
    if (/^\s+workflow_call:/m.test(have) || have === wanted) {
      ctx.log(`caller ready on ${base}`);
      return true;
    }
  }
  const branch = "chore/task-manager-caller";
  const pulls = await ctx.api.pages<{ number: number; html_url: string }>(
    `repos/${ctx.repo.full_name}/pulls?state=open&head=${encodeURIComponent(`${ctx.repo.owner.login}:${branch}`)}&base=${encodeURIComponent(base)}`,
  );
  if (pulls.length) {
    ctx.log(`waiting: merge caller PR ${pulls[0].html_url}, then rerun`);
    return false;
  }
  ctx.log(
    `${ctx.plan ? "would open" : "open"} caller workflow PR into ${base}; requires PROJECT_PAT and CLAUDE_CODE_OAUTH_TOKEN secrets`,
  );
  if (ctx.plan) return false;
  if (!(await branchSha(ctx, branch))) {
    const sha = await branchSha(ctx, base);
    if (!sha) throw new Error(`Missing base branch ${base}`);
    await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  const onBranch = await content(ctx, branch);
  await ctx.api.rest("PUT", `repos/${ctx.repo.full_name}/contents/${callerPath}`, {
    message: "chore(task-manager): add or update caller workflow",
    content: Buffer.from(wanted).toString("base64"),
    branch,
    ...(onBranch ? { sha: onBranch.sha } : {}),
  });
  const pr = await ctx.api.rest<{ html_url: string }>("POST", `repos/${ctx.repo.full_name}/pulls`, {
    title: "chore(task-manager): add the task-manager caller workflow",
    head: branch,
    base,
    body: "Calls `oneezy/tools/.github/workflows/task-manager.yml@main` for issue, branch, pull request and push events, and backfill/estimate dispatches.\n\nRequires `PROJECT_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`. Written by Task Manager. Promote the caller to the default branch before relying on issue events and dispatches.",
  });
  ctx.log(`opened ${pr.html_url}`);
  return false;
}
export async function dispatchBackfill(ctx: Context): Promise<void> {
  const ref = await baseBranch(ctx);
  if (!(await content(ctx, ref))) {
    ctx.log(`pending: caller missing on ${ref}`);
    return;
  }
  // Dispatch is registered only after the workflow reaches the default branch.
  if (ref !== ctx.repo.default_branch && !(await content(ctx, ctx.repo.default_branch))) {
    ctx.log(`pending: promote caller to ${ctx.repo.default_branch}, then rerun backfill`);
    return;
  }
  ctx.log(`${ctx.plan ? "would dispatch" : "dispatch"} backfill on ${ref}`);
  if (!ctx.plan) {
    try {
      await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/actions/workflows/task-manager.yml/dispatches`, {
        ref,
        inputs: { backfill: "true" },
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404)
        ctx.log(`pending: workflow is not registered on ${ctx.repo.default_branch}; promote, then rerun`);
      else throw error;
    }
  }
}
export async function openBrowser(url: string): Promise<void> {
  if (!url.startsWith("https://github.com/")) throw new Error("Expected a GitHub browser URL");
  if (process.platform === "win32") {
    // Encoded PowerShell avoids shell interpolation of a project URL.
    const script = `Start-Process -FilePath '${url.replace(/'/g, "''")}'`;
    await command("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ]);
  } else await command(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}
export async function waitAutoAdd(
  ctx: Context,
  project: Project,
  seconds: number,
  open = false,
  dependencies = { browser: openBrowser, sleep: (ms: number) => setTimeout(ms), now: () => Date.now() },
): Promise<boolean> {
  const enabled = (p: Project) => p.workflows.nodes.some((w) => w.name === "Auto-add to project" && w.enabled);
  if (enabled(project)) return true;
  const url = `${project.url}/workflows`;
  ctx.log(
    `manual: Auto-add to project > repository ${ctx.repo.full_name}, filter is:issue > Save and turn on workflow: ${url}`,
  );
  if (ctx.plan) return false;
  if (open) await dependencies.browser(url);
  const deadline = dependencies.now() + seconds * 1000;
  while (dependencies.now() < deadline) {
    await dependencies.sleep(Math.min(5000, deadline - dependencies.now()));
    if (enabled(await getProject(ctx, project.id))) {
      ctx.log("verified Auto-add enabled");
      return true;
    }
  }
  if (seconds) ctx.log("pending: Auto-add still off; enable it and rerun status");
  return false;
}
