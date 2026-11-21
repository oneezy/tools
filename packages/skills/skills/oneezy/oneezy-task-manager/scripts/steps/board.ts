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
export async function backfill(ctx: Context, project: Project, bootstrap = false): Promise<void> {
  const items = (await getItems(ctx, project)).filter((item) => belongs(ctx, item));
  for (const item of items) {
    const ticket = itemTicket(item);
    const to = backfillStatus(ticket, bootstrap);
    if (!to || !transition(ticket, to)) continue;
    ctx.log(`${ctx.plan ? "would move" : "move"} #${item.content!.number}: ${ticket.status ?? "none"} -> ${to}`);
    if (!ctx.plan) await setStatus(ctx, project, item.id, to);
  }
  const seen = new Set(items.map((item) => item.content!.number));
  for (const issue of await listIssues(ctx, "open")) {
    if (seen.has(issue.number) || protectedIssue(issue.labels.map((l) => l.name))) continue;
    const to = issue.assignees.length ? "Next Up" : "Todo";
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
  const linked = async () => {
    const pr = positive(event.PR, "PR");
    const numbers = new Set<number>();
    let after: string | null = null;
    do {
      const data: {
        repository: {
          pullRequest: {
            headRefName: string;
            closingIssuesReferences: {
              nodes: { number: number; repository: { nameWithOwner: string } }[];
              pageInfo: { hasNextPage: boolean; endCursor: string };
            };
          };
        };
      } = await ctx.api.graphql(
        `query($owner:String!,$name:String!,$pr:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$pr) {
          headRefName closingIssuesReferences(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { number repository { nameWithOwner } } } } } }`,
        { owner: ctx.repo.owner.login, name: ctx.repo.name, pr, after },
      );
      const pull = data.repository.pullRequest;
      for (const issue of pull.closingIssuesReferences.nodes)
        if (issue.repository.nameWithOwner.toLowerCase() === ctx.repo.full_name.toLowerCase())
          numbers.add(issue.number);
      const branch = branchIssue(pull.headRefName);
      if (branch) {
        const issue = await getIssue(branch);
        if (issue && !issue.pull_request) numbers.add(branch);
      }
      after = pull.closingIssuesReferences.pageInfo.hasNextPage
        ? pull.closingIssuesReferences.pageInfo.endCursor
        : null;
    } while (after);
    return [...numbers].sort((a, b) => a - b);
  };
  const startFrom = ["", "Todo", "Next Up"];
  const integration = event.INTEGRATION_BRANCH || "dev";
  const release = event.RELEASE_BRANCH || "main";
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
      for (const n of await linked()) {
        const issue = await getIssue(n);
        if (!issue || issue.pull_request || protectedIssue(issue.labels.map((l) => l.name))) continue;
        if (issue.state.toLowerCase() === "open") {
          ctx.log(`${ctx.plan ? "would close" : "close"} #${n} merged into ${integration} by #${event.PR}`);
          if (!ctx.plan) {
            if (issue.labels.some((l) => l.name === "needs-changes"))
              await ctx.api.rest("DELETE", `repos/${ctx.repo.full_name}/issues/${n}/labels/needs-changes`);
            await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/issues/${n}/comments`, {
              body: `Merged into \`${integration}\` by #${event.PR}.`,
            });
            await ctx.api.rest("PATCH", `repos/${ctx.repo.full_name}/issues/${n}`, {
              state: "closed",
              state_reason: "completed",
            });
          }
        }
        await move(n, "Done");
      }
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
  } else ctx.log(`kept: no rule for ${event.EVENT}/${event.ACTION ?? ""}`);
}

interface FileContent {
  content: string;
  sha: string;
}
const normalize = (text: string) => text.replace(/\r\n/g, "\n");
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
  const wanted = normalize(template ?? (await readFile(new URL("../../caller.yml", import.meta.url), "utf8")));
  const base = await baseBranch(ctx);
  const live = await content(ctx, base);
  if (live) {
    const have = normalize(Buffer.from(live.content, "base64").toString("utf8"));
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
