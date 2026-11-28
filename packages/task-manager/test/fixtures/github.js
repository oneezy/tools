// In-memory GitHub for integration and isolated-skill tests. Unknown requests fail;
// no fetch, subprocess, or live credential is used here.
export class FakeGitHub {
  constructor() {
    this.calls = [];
    this.repo = {
      full_name: "acme/widgets",
      name: "widgets",
      node_id: "R_1",
      private: true,
      default_branch: "main",
      owner: { login: "acme", type: "User", node_id: "U_1" },
    };
    const field = (name, dataType, options) => ({ id: `F_${name}`, name, dataType, options });
    this.project = {
      id: "P_1",
      number: 1,
      title: "widgets",
      closed: false,
      public: false,
      url: "https://github.com/users/acme/projects/1",
      owner: { login: "acme" },
      fields: {
        nodes: [
          field("Title", "TITLE"),
          field("Status", "SINGLE_SELECT", [
            { id: "todo", name: "Todo", color: "GRAY", description: "Opened, unassigned" },
          ]),
          ...["Labels", "Assignees", "Linked pull requests"].map((name) => field(name, "TEXT")),
        ],
      },
      views: { nodes: [] },
      workflows: {
        nodes: [
          "Item added to project",
          "Item closed",
          "Pull request merged",
          "Pull request linked to issue",
          "Auto-add sub-issues to project",
          "Auto-add to project",
        ].map((name) => ({ id: name, name, enabled: true })),
      },
    };
    this.labels = [];
    this.issues = [
      {
        number: 1,
        node_id: "I_1",
        title: "A task",
        body: "Do work",
        state: "open",
        html_url: "https://github.com/acme/widgets/issues/1",
        labels: [],
        assignees: [],
        milestone: null,
      },
    ];
    this.items = [];
    this.milestones = [];
    this.pull = {
      headRefName: "feature/1-task",
      body: "",
      closingIssuesReferences: {
        nodes: [{ number: 1, repository: { nameWithOwner: "acme/widgets" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    this.caller = "name: host\non:\n  workflow_call:\n";
  }
  clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  async pages(path) {
    this.calls.push({ kind: "rest", method: "GET", path });
    if (path.includes("/issues?"))
      return this.clone(this.issues.filter((i) => !path.includes("state=open") || i.state === "open"));
    if (path.endsWith("/labels")) return this.clone(this.labels);
    if (path.includes("/milestones?")) return this.clone(this.milestones);
    if (path.includes("/pulls?")) return [];
    if (path.endsWith("/fields")) return this.project.fields.nodes.map((f, i) => ({ name: f.name, id: i + 1 }));
    throw new Error(`Unmocked list ${path}`);
  }
  async rest(method, path, body) {
    this.calls.push({ kind: "rest", method, path, body: this.clone(body) });
    const root = "repos/acme/widgets";
    if (method === "GET") {
      if (path === "user") return { login: "acme" };
      if (path === root) return this.clone(this.repo);
      if (path.includes("/git/ref/heads/")) return { object: { sha: "abc" } };
      if (path.includes("/contents/")) return { content: Buffer.from(this.caller).toString("base64"), sha: "file" };
      if (/\/issues\/\d+$/.test(path))
        return this.clone(this.issues.find((i) => i.number === Number(path.split("/").at(-1))));
      // The real transport paginates, the test model's lists fit on one page.
      return this.pages(path.replace(/[?&]per_page=100(?:&page=\d+)?/, ""));
    }
    if (path.endsWith("/views")) {
      const nameOf = (id) => this.project.fields.nodes[id - 1].name;
      this.project.views.nodes.push({
        id: `V_${this.calls.length}`,
        name: body.name,
        layout: `${body.layout.toUpperCase()}_LAYOUT`,
        filter: body.filter,
        fields: { nodes: (body.visible_fields ?? []).map((id) => ({ name: nameOf(id) })) },
        sortByFields: {
          nodes: (body.sort_by ?? []).map(([id, direction]) => ({
            direction: direction.toUpperCase(),
            field: { name: nameOf(id) },
          })),
        },
        verticalGroupByFields: { nodes: (body.vertical_group_by ?? []).map((id) => ({ name: nameOf(id) })) },
      });
      return {};
    }
    if (path === `${root}/labels` || path.startsWith(`${root}/labels/`)) {
      const existing = this.labels.find((l) => l.name === body.name);
      if (existing) Object.assign(existing, body);
      else this.labels.push(this.clone(body));
      return body;
    }
    if (path === `${root}/milestones`) {
      const milestone = { number: this.milestones.length + 1, ...body };
      this.milestones.push(milestone);
      return this.clone(milestone);
    }
    if (path.includes("/milestones/")) {
      Object.assign(
        this.milestones.find((m) => m.number === Number(path.split("/").at(-1))),
        body,
      );
      return {};
    }
    if (path === `${root}/issues`) {
      const number = this.issues.length + 1;
      const issue = {
        number,
        node_id: `I_${number}`,
        html_url: `https://github.com/acme/widgets/issues/${number}`,
        state: "open",
        assignees: [],
        ...body,
        labels: body.labels.map((name) => ({ name })),
        milestone: this.milestones.find((m) => m.number === body.milestone) ?? null,
      };
      this.issues.push(issue);
      return this.clone(issue);
    }
    const number = /\/issues\/(\d+)/.exec(path)?.[1];
    if (number) {
      const issue = this.issues.find((i) => i.number === Number(number));
      if (path.endsWith("/comments")) return {};
      if (path.endsWith("/labels/needs-changes") && method === "DELETE") {
        issue.labels = issue.labels.filter((l) => l.name !== "needs-changes");
        return;
      }
      if (path.endsWith("/labels")) {
        issue.labels.push(...body.labels.map((name) => ({ name })));
        return {};
      }
      Object.assign(
        issue,
        body,
        body.labels ? { labels: body.labels.map((name) => ({ name })) } : {},
        body.milestone ? { milestone: this.milestones.find((m) => m.number === body.milestone) } : {},
      );
      return this.clone(issue);
    }
    if (path.includes("/dispatches")) return;
    throw new Error(`Unmocked ${method} ${path}`);
  }
  async graphql(query, variables = {}) {
    this.calls.push({ kind: "graphql", query, variables: this.clone(variables) });
    if (query.trim().startsWith("query")) {
      if (query.includes("pullRequest(number:")) return { repository: { pullRequest: this.clone(this.pull) } };
      if (query.includes("projectsV2(first:"))
        return {
          repository: {
            projectsV2: { nodes: this.project ? [this.clone(this.project)] : [], pageInfo: { hasNextPage: false } },
          },
        };
      if (query.includes("items(first:")) {
        // Reflect issue state changes while retaining board fields.
        for (const item of this.items) {
          const issue = this.issues.find((i) => i.html_url === item.content?.url);
          if (issue)
            Object.assign(item.content, {
              state: issue.state.toUpperCase(),
              labels: { nodes: issue.labels },
              assignees: { totalCount: issue.assignees.length, nodes: issue.assignees },
            });
        }
        return { node: { items: { nodes: this.clone(this.items), pageInfo: { hasNextPage: false } } } };
      }
      return { node: this.clone(this.project) };
    }
    if (query.includes("createProjectV2Field")) {
      this.project.fields.nodes.push({
        id: `F_${variables.name}`,
        name: variables.name,
        dataType: variables.type,
        options: variables.options?.map((o, i) => ({ ...o, id: `${variables.name}_${i}` })),
      });
    } else if (query.includes("updateProjectV2Field(")) {
      const field = this.project.fields.nodes.find((f) => f.id === variables.id);
      field.options = variables.options.map((o, i) => ({ ...o, id: o.id ?? `${field.name}_${i}` }));
    } else if (query.includes("updateProjectV2(input:")) this.project.public = variables.public;
    else if (query.includes("deleteProjectV2View"))
      this.project.views.nodes = this.project.views.nodes.filter((v) => v.id !== variables.id);
    else if (query.includes("deleteProjectV2Workflow"))
      this.project.workflows.nodes = this.project.workflows.nodes.filter((w) => w.id !== variables.id);
    else if (query.includes("addProjectV2ItemById")) {
      const issue = this.issues.find((i) => i.node_id === variables.c);
      const item = {
        id: `IT_${issue.number}`,
        status: null,
        fieldValues: { nodes: [] },
        content: {
          __typename: "Issue",
          number: issue.number,
          url: issue.html_url,
          title: issue.title,
          body: issue.body,
          state: issue.state.toUpperCase(),
          repository: { nameWithOwner: "acme/widgets" },
          labels: { nodes: issue.labels },
          assignees: { totalCount: issue.assignees.length, nodes: issue.assignees },
          deps: { blockedBy: 0, blocking: 0 },
        },
      };
      this.items.push(item);
      return { addProjectV2ItemById: { item: { id: item.id } } };
    } else if (query.includes("updateProjectV2ItemFieldValue")) {
      const item = this.items.find((i) => i.id === variables.i);
      const field = this.project.fields.nodes.find((f) => f.id === variables.f);
      const optionId = variables.o ?? variables.v?.singleSelectOptionId;
      const value = optionId
        ? { name: field.options.find((o) => o.id === optionId).name }
        : { number: variables.v.number };
      if (field.name === "Status") item.status = value;
      item.fieldValues.nodes = item.fieldValues.nodes.filter((v) => v.field.name !== field.name);
      item.fieldValues.nodes.push({ ...value, field: { name: field.name } });
    } else throw new Error(`Unmocked mutation ${query}`);
    return {};
  }
}
