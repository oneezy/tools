import type { Connection, Context, Field, Item, Option, Project, View } from "./types.ts";

export const statuses: Option[] = [
  { name: "Todo", color: "GRAY", description: "Opened, unassigned" },
  { name: "Next Up", color: "BLUE", description: "Assigned" },
  { name: "In Progress", color: "YELLOW", description: "Branch on GitHub" },
  { name: "Review", color: "ORANGE", description: "Pull request ready for a human" },
  { name: "Done", color: "GREEN", description: "Merged into dev" },
  { name: "Complete", color: "PURPLE", description: "Promoted to main" },
];
export const priorities: Option[] = ["Low", "Medium", "High", "Critical"].map((name, i) => ({
  name,
  color: ["GREEN", "YELLOW", "ORANGE", "RED"][i],
  description: "",
}));
export const labels = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "feature", color: "0075ca", description: "New capability" },
  { name: "tech-debt", color: "ff8c00", description: "Cleanup that pays later" },
  { name: "question", color: "c2e0c6", description: "Needs an answer before work" },
  { name: "learning", color: "fbca04", description: "Something to learn" },
  { name: "reference", color: "d4d4d4", description: "Reference material, not work" },
  { name: "waiting", color: "fdba74", description: "Waiting on something outside the tickets" },
  { name: "needs-changes", color: "ff1493", description: "Sent back after Done; returns to In Progress" },
  { name: "phase", color: "1e3a8a", description: "A dated chunk of work; a bar on the roadmap" },
];
export interface ViewSpec {
  name: string;
  layout: string;
  filter: string;
  fields: string[];
  sort?: string;
  columns?: string;
}
export const views: ViewSpec[] = [
  {
    name: "Backlog",
    layout: "table",
    filter: "is:open -label:phase",
    sort: "Priority",
    fields: ["Title", "Status", "Priority", "Estimate", "Labels", "Assignees", "Linked pull requests"],
  },
  {
    name: "Board",
    layout: "board",
    filter: '-label:phase -label:"wayfinder:map"',
    sort: "Priority",
    columns: "Status",
    fields: ["Title", "Priority", "Estimate", "Labels", "Assignees", "Linked pull requests"],
  },
  { name: "Roadmap", layout: "roadmap", filter: "label:phase", fields: [] },
];
export const workflowsOn = [
  "Item added to project",
  "Item closed",
  "Pull request merged",
  "Pull request linked to issue",
  "Auto-add sub-issues to project",
  "Auto-add to project",
];
export const callerPath = ".github/workflows/task-manager.yml";
export const protectedIssue = (names: string[]) => names.some((name) => name === "wayfinder:map" || name === "phase");

const projectFields = `id number title closed public url owner { ... on User { login } ... on Organization { login } }
  fields(first:100) { pageInfo { hasNextPage } nodes { ... on ProjectV2FieldCommon { id name dataType }
    ... on ProjectV2SingleSelectField { options { id name color description } } } }
  views(first:100) { pageInfo { hasNextPage } nodes { id name layout filter
    sortByFields(first:10) { nodes { direction field { ... on ProjectV2FieldCommon { name } } } }
    verticalGroupByFields(first:10) { nodes { ... on ProjectV2FieldCommon { name } } }
    fields(first:100) { nodes { ... on ProjectV2FieldCommon { name } } } } }
  workflows(first:100) { pageInfo { hasNextPage } nodes { id name enabled } }`;
function checked(project: Project): Project {
  for (const list of [project.fields, project.views, project.workflows]) {
    if (list.pageInfo?.hasNextPage)
      throw new Error("Project metadata exceeds 100 entries; refusing an incomplete repair.");
  }
  return project;
}
export async function getProject(ctx: Context, id: string): Promise<Project> {
  const data = await ctx.api.graphql<{ node: Project }>(
    `query($id:ID!) { node(id:$id) { ... on ProjectV2 { ${projectFields} } } }`,
    { id },
  );
  if (!data.node) throw new Error(`Project ${id} is inaccessible`);
  return checked(data.node);
}
export async function findProject(ctx: Context): Promise<Project | undefined> {
  const projects: Project[] = [];
  let after: string | null = null;
  do {
    const data: { repository: { projectsV2: Connection<Project> } } = await ctx.api.graphql(
      `query($owner:String!,$name:String!,$after:String) { repository(owner:$owner,name:$name) {
        projectsV2(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { ${projectFields} } } } }`,
      { owner: ctx.repo.owner.login, name: ctx.repo.name, after },
    );
    const page = data.repository.projectsV2;
    projects.push(
      ...page.nodes.filter((p) => !p.closed && p.owner.login.toLowerCase() === ctx.repo.owner.login.toLowerCase()),
    );
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  const found = projects.find((p) => p.title === ctx.repo.name) ?? projects[0];
  return found ? checked(found) : undefined;
}
export async function ensureProject(ctx: Context): Promise<Project | undefined> {
  let project = await findProject(ctx);
  if (!project) {
    ctx.log(`${ctx.plan ? "create" : "creating"} project ${ctx.repo.full_name}, link repository`);
    if (ctx.plan) return undefined;
    const result = await ctx.api.graphql<{ createProjectV2: { projectV2: { id: string } } }>(
      `mutation($owner:ID!,$title:String!,$repo:ID!) { createProjectV2(input:{ownerId:$owner,title:$title,repositoryId:$repo}) { projectV2 { id } } }`,
      { owner: ctx.repo.owner.node_id, title: ctx.repo.name, repo: ctx.repo.node_id },
    );
    project = await getProject(ctx, result.createProjectV2.projectV2.id);
  }
  if (project.public === ctx.repo.private) {
    ctx.log(`set project visibility to ${ctx.repo.private ? "private" : "public"}`);
    if (!ctx.plan)
      await ctx.api.graphql(
        `mutation($id:ID!,$public:Boolean!) { updateProjectV2(input:{projectId:$id,public:$public}) { projectV2 { id } } }`,
        { id: project.id, public: !ctx.repo.private },
      );
  }
  return project;
}
export function optionsWithIds(field: Field, wanted: Option[]): Option[] {
  return wanted.map((option) => ({
    ...option,
    ...(field.options?.find((old) => old.name === option.name)?.id
      ? { id: field.options.find((old) => old.name === option.name)!.id }
      : {}),
  }));
}
export async function ensureField(
  ctx: Context,
  project: Project,
  name: string,
  dataType: string,
  options?: Option[],
): Promise<void> {
  const live = project.fields.nodes.find((f) => f.name === name);
  if (live && live.dataType !== dataType)
    throw new Error(`Field ${name} is ${live.dataType}; rename it in the browser before repair (wanted ${dataType}).`);
  if (!live) {
    ctx.log(`create field ${name} (${dataType})`);
    if (!ctx.plan)
      await ctx.api.graphql(
        `mutation($p:ID!,$name:String!,$type:ProjectV2CustomFieldType!,$options:[ProjectV2SingleSelectFieldOptionInput!]) {
      createProjectV2Field(input:{projectId:$p,name:$name,dataType:$type,singleSelectOptions:$options}) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
        { p: project.id, name, type: dataType, options },
      );
  } else if (
    options &&
    JSON.stringify(live.options?.map((o) => o.name)) !== JSON.stringify(options.map((o) => o.name))
  ) {
    ctx.log(`repair ${name} options (preserve matching IDs)`);
    if (!ctx.plan)
      await ctx.api.graphql(
        `mutation($id:ID!,$options:[ProjectV2SingleSelectFieldOptionInput!]!) {
      updateProjectV2Field(input:{fieldId:$id,singleSelectOptions:$options}) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
        { id: live.id, options: optionsWithIds(live, options) },
      );
  }
}
export function viewDrift(live: View, wanted: ViewSpec): string[] {
  const drift: string[] = [];
  if (live.layout !== `${wanted.layout.toUpperCase()}_LAYOUT`) drift.push("layout");
  if ((live.filter ?? "") !== wanted.filter) drift.push("filter");
  if (
    wanted.sort &&
    (live.sortByFields.nodes.length !== 1 ||
      live.sortByFields.nodes[0].field.name !== wanted.sort ||
      live.sortByFields.nodes[0].direction !== "DESC")
  )
    drift.push("sort");
  if (wanted.columns && live.verticalGroupByFields.nodes.map((f) => f.name).join() !== wanted.columns)
    drift.push("columns");
  if (wanted.fields.length && JSON.stringify(live.fields.nodes.map((f) => f.name)) !== JSON.stringify(wanted.fields))
    drift.push("visible fields");
  return drift;
}
export async function ensureView(ctx: Context, project: Project, wanted: ViewSpec): Promise<void> {
  const live = project.views.nodes.find((v) => v.name === wanted.name);
  if (live && !viewDrift(live, wanted).length) return;
  ctx.log(`${live ? "repair" : "create"} view ${wanted.name}${live ? ` (${viewDrift(live, wanted).join(", ")})` : ""}`);
  if (ctx.plan) return;
  const scope = ctx.repo.owner.type === "Organization" ? "orgs" : "users";
  const path = `${scope}/${ctx.repo.owner.login}/projectsV2/${project.number}`;
  const fields = await ctx.api.pages<{ id: number; name: string }>(`${path}/fields`);
  const id = (name: string) => {
    const f = fields.find((f) => f.name === name);
    if (!f) throw new Error(`Missing view field ${name}`);
    return f.id;
  };
  // Create before deleting: a failed create leaves the old view available.
  await ctx.api.rest("POST", `${path}/views`, {
    name: wanted.name,
    layout: wanted.layout,
    filter: wanted.filter,
    ...(wanted.fields.length ? { visible_fields: wanted.fields.map(id) } : {}),
    ...(wanted.sort ? { sort_by: [[id(wanted.sort), "desc"]] } : {}),
    ...(wanted.columns ? { vertical_group_by: [id(wanted.columns)] } : {}),
  });
  if (live) await deleteView(ctx, live.id);
}
async function deleteView(ctx: Context, id: string): Promise<void> {
  await ctx.api.graphql(`mutation($id:ID!) { deleteProjectV2View(input:{viewId:$id}) { clientMutationId } }`, { id });
}
export async function pruneViews(ctx: Context, project: Project): Promise<void> {
  if (!views.every((wanted) => project.views.nodes.some((v) => v.name === wanted.name))) return;
  const seen = new Set<string>();
  for (const view of project.views.nodes) {
    if (!views.some((v) => v.name === view.name) || seen.has(view.name)) {
      ctx.log(`delete extra view ${view.name}`);
      if (!ctx.plan) await deleteView(ctx, view.id);
    }
    seen.add(view.name);
  }
}
export async function getItems(ctx: Context, project: Project): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | null = null;
  do {
    const data: { node: { items: Connection<Item> } } = await ctx.api.graphql(
      `query($id:ID!,$after:String) { node(id:$id) { ... on ProjectV2 {
      items(first:100,after:$after) { pageInfo { hasNextPage endCursor } nodes { id
        status:fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        fieldValues(first:100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } } }
        content { __typename ... on Issue { number url title body state createdAt repository { nameWithOwner }
          labels(first:100) { nodes { name } } assignees(first:100) { totalCount nodes { login } }
          deps:issueDependenciesSummary { blockedBy blocking } } } } } } } }`,
      { id: project.id, after },
    );
    items.push(...data.node.items.nodes);
    after = data.node.items.pageInfo?.hasNextPage ? data.node.items.pageInfo.endCursor : null;
  } while (after);
  return items;
}
export async function addItem(ctx: Context, project: Project, node: string): Promise<string> {
  const result = await ctx.api.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    `mutation($p:ID!,$c:ID!) { addProjectV2ItemById(input:{projectId:$p,contentId:$c}) { item { id } } }`,
    { p: project.id, c: node },
  );
  return result.addProjectV2ItemById.item.id;
}

export async function status(
  ctx: Context,
  project: Project | undefined,
): Promise<{ state: string; drift: string[]; url?: string }> {
  if (!project) return { state: "no project", drift: [] };
  const drift: string[] = [];
  if (project.public === ctx.repo.private) drift.push("visibility");
  for (const [name, type, options] of [
    ["Status", "SINGLE_SELECT", statuses],
    ["Priority", "SINGLE_SELECT", priorities],
    ["Estimate", "NUMBER", undefined],
    ["Start", "DATE", undefined],
    ["Due", "DATE", undefined],
  ] as const) {
    const field = project.fields.nodes.find((f) => f.name === name);
    if (!field || field.dataType !== type) drift.push(`field ${name}`);
    else if (
      options &&
      JSON.stringify(field.options?.map((o) => o.name)) !== JSON.stringify(options.map((o) => o.name))
    )
      drift.push(`${name} options`);
  }
  for (const wanted of views) {
    const found = project.views.nodes.filter((v) => v.name === wanted.name);
    if (!found.length) drift.push(`view ${wanted.name}`);
    else drift.push(...viewDrift(found[0], wanted).map((reason) => `view ${wanted.name} ${reason}`));
    if (found.length > 1) drift.push(`duplicate view ${wanted.name}`);
  }
  for (const extra of project.views.nodes.filter((v) => !views.some((w) => w.name === v.name)))
    drift.push(`extra view ${extra.name}`);
  const existing = await ctx.api.pages<{ name: string; color: string; description: string }>(
    `repos/${ctx.repo.full_name}/labels`,
  );
  for (const wanted of labels) {
    const live = existing.find((l) => l.name === wanted.name);
    if (!live || live.color.toLowerCase() !== wanted.color || live.description !== wanted.description)
      drift.push(`label ${wanted.name}`);
  }
  for (const name of workflowsOn)
    if (!project.workflows.nodes.some((w) => w.name === name && w.enabled)) drift.push(`workflow ${name} off`);
  if (project.workflows.nodes.some((w) => w.name === "Auto-close issue" && w.enabled))
    drift.push("workflow Auto-close issue on");
  return {
    state: !drift.length
      ? "ok"
      : drift.length === 1 && drift[0] === "workflow Auto-add to project off"
        ? "needs clicks"
        : "drifted",
    drift,
    url: project.url,
  };
}
