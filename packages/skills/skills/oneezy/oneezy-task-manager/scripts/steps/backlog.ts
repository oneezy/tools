import { setTimeout } from "node:timers/promises";
import type { Context, Issue, Project } from "../types.ts";
import { priorities, labels, views, protectedIssue, addItem, ensureField, ensureView, getItems } from "../project.ts";

export async function prepareBacklog(ctx: Context, project: Project): Promise<void> {
  await ensureField(ctx, project, "Priority", "SINGLE_SELECT", priorities);
  await ensureField(ctx, project, "Estimate", "NUMBER");
  await ensureLabels(ctx);
  await ensureView(ctx, project, views[0]);
}
export async function ensureLabels(ctx: Context, only?: string): Promise<void> {
  const existing = await ctx.api.pages<{ name: string; color: string; description: string }>(
    `repos/${ctx.repo.full_name}/labels`,
  );
  for (const label of labels.filter((l) => !only || l.name === only)) {
    const live = existing.find((l) => l.name === label.name);
    if (live?.color.toLowerCase() === label.color && live.description === label.description) continue;
    ctx.log(`${live ? "repair" : "create"} label ${label.name}`);
    if (!ctx.plan)
      await ctx.api.rest(
        live ? "PATCH" : "POST",
        `repos/${ctx.repo.full_name}/labels${live ? `/${encodeURIComponent(label.name)}` : ""}`,
        label,
      );
  }
}
export async function listIssues(ctx: Context, state = "all"): Promise<Issue[]> {
  return (await ctx.api.pages<Issue>(`repos/${ctx.repo.full_name}/issues?state=${state}`)).filter(
    (issue) => !issue.pull_request,
  );
}
export async function importIssues(ctx: Context, project: Project): Promise<void> {
  const have = new Set((await getItems(ctx, project)).map((item) => item.content?.url));
  let added = 0;
  for (const issue of await listIssues(ctx)) {
    if (have.has(issue.html_url)) continue;
    ctx.log(`add #${issue.number} to project`);
    if (!ctx.plan) {
      await addItem(ctx, project, issue.node_id);
      added++;
    }
  }
  // Match bootstrap's delay so GitHub's built-in Item added -> Todo lands first.
  if (added) await (ctx.sleep ?? setTimeout)(6000);
}
// Same JSONL shape used by the estimate skill, with repository identity included.
export async function readBacklog(ctx: Context, project: Project): Promise<unknown[]> {
  const fields = Object.fromEntries(
    project.fields.nodes
      .filter((f) => ["Status", "Priority", "Estimate"].includes(f.name))
      .map((f) => [f.name, { id: f.id, options: Object.fromEntries((f.options ?? []).map((o) => [o.name, o.id])) }]),
  );
  const result: unknown[] = [
    { kind: "project", repo: ctx.repo.full_name, id: project.id, number: project.number, title: project.title, fields },
  ];
  for (const item of await getItems(ctx, project)) {
    const issue = item.content;
    if (
      issue?.__typename !== "Issue" ||
      issue.repository?.nameWithOwner.toLowerCase() !== ctx.repo.full_name.toLowerCase()
    )
      continue;
    const value = (name: string) => item.fieldValues.nodes.find((v) => v.field?.name === name);
    result.push({
      kind: "issue",
      number: issue.number,
      title: issue.title,
      state: issue.state,
      status: item.status?.name ?? null,
      estimate: value("Estimate")?.number ?? null,
      priority: value("Priority")?.name ?? null,
      labels: issue.labels?.nodes.map((l) => l.name) ?? [],
      assignees: issue.assignees?.nodes.map((a) => a.login) ?? [],
      blocked_by: issue.deps?.blockedBy ?? 0,
      blocks: issue.deps?.blocking ?? 0,
      created: issue.createdAt,
      item: item.id,
      body: (issue.body ?? "").length > 2000 ? `${issue.body!.slice(0, 2000)} [.]` : (issue.body ?? ""),
    });
  }
  return result;
}

export interface EstimateInput {
  number: number;
  estimate?: number;
  priority?: string;
  type?: string;
  comment: string;
}
export class EstimateRefusal extends Error {}
const types = ["bug", "feature", "tech-debt", "question", "learning", "reference"];
// Decisions remain an agent's work. This guard is portable and never invokes another skill.
export async function setEstimate(ctx: Context, project: Project, input: EstimateInput): Promise<void> {
  if (!Number.isSafeInteger(input.number) || input.number < 1) throw new Error("Issue number must be positive");
  if (!input.comment.trim()) throw new Error("A reasoning comment is required");
  if (input.estimate === undefined && !input.priority && !input.type) throw new Error("Nothing to set");
  if (input.estimate !== undefined && ![1, 2, 3, 5, 8, 13].includes(input.estimate))
    throw new Error("Estimate must be 1, 2, 3, 5, 8 or 13");
  if (input.priority && !["Low", "Medium", "High", "Critical"].includes(input.priority))
    throw new Error("Invalid Priority");
  if (input.type && !types.includes(input.type)) throw new Error("Invalid Type");
  const issue = await ctx.api.rest<Issue>("GET", `repos/${ctx.repo.full_name}/issues/${input.number}`);
  const item = (await getItems(ctx, project)).find((i) => i.content?.url === issue.html_url);
  const refuse = (message: string): never => {
    throw new EstimateRefusal(message);
  };
  if (issue.pull_request) refuse("Pull requests are not tickets");
  if (!item) return refuse("Issue is not on the project");
  if (protectedIssue(issue.labels.map((l) => l.name))) refuse("Maps and phases are never sized");
  if (input.type && issue.state.toLowerCase() !== "open") refuse("Type is only set on open issues");
  const value = (name: string) => item.fieldValues.nodes.find((v) => v.field?.name === name);
  if (input.estimate !== undefined && value("Estimate")?.number !== undefined) refuse("Estimate is write-once");
  if (input.priority && value("Priority")?.name) {
    if (!["Todo", "Next Up"].includes(item.status?.name ?? "")) refuse("Priority changes only in Todo or Next Up");
    if (input.priority === value("Priority")!.name) refuse("Priority is already set to that value");
  }
  if (input.type && issue.labels.some((l) => types.includes(l.name))) refuse("One type per ticket");
  const estimateField = project.fields.nodes.find((f) => f.name === "Estimate");
  const priorityField = project.fields.nodes.find((f) => f.name === "Priority");
  const option = priorityField?.options?.find((o) => o.name === input.priority)?.id;
  if (input.estimate !== undefined && !estimateField) refuse("Missing Estimate field");
  if (input.priority && !option) refuse("Missing Priority option");
  // All validation precedes any write. Remote writes are sequential, not transactional.
  const write = async (field: string, fieldValue: unknown) =>
    ctx.api.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}) { clientMutationId } }`,
      { p: project.id, i: item.id, f: field, v: fieldValue },
    );
  if (input.estimate !== undefined) {
    ctx.log(`${ctx.plan ? "would set" : "set"} #${input.number} Estimate ${input.estimate}`);
    if (!ctx.plan) await write(estimateField!.id, { number: input.estimate });
  }
  if (input.priority) {
    ctx.log(`${ctx.plan ? "would set" : "set"} #${input.number} Priority ${input.priority}`);
    if (!ctx.plan) await write(priorityField!.id, { singleSelectOptionId: option });
  }
  if (input.type) {
    ctx.log(`${ctx.plan ? "would set" : "set"} #${input.number} Type ${input.type}`);
    if (!ctx.plan)
      await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/issues/${input.number}/labels`, { labels: [input.type] });
  }
  ctx.log(`${ctx.plan ? "would comment" : "comment"} #${input.number}: ${input.comment}`);
  if (!ctx.plan)
    await ctx.api.rest("POST", `repos/${ctx.repo.full_name}/issues/${input.number}/comments`, { body: input.comment });
}
