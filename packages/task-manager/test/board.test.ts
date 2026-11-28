import { expect, it, describe } from "vite-plus/test";
import {
  backfill,
  backfillStatus,
  bodyIssues,
  branchIssue,
  runEvent,
  transition,
  type Pull,
  type Ticket,
} from "../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/board.ts";
import { FakeGitHub } from "./fixtures/github.js";
import { GitHubError } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/github.ts";
import { run } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/main.ts";
import type { Context } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/types.ts";

describe("status rules", () => {
  it.each([
    [{ state: "CLOSED", status: "Complete", labels: [], assignees: 0 }, false, "Complete"],
    [{ state: "closed", status: "Review", labels: [], assignees: 1 }, false, "Done"],
    [{ state: "OPEN", status: "Todo", labels: [], assignees: 1 }, false, "Next Up"],
    [{ state: "OPEN", status: "Review", labels: [], assignees: 1 }, false, undefined],
    [{ state: "OPEN", status: "Next Up", labels: [], assignees: 0 }, false, undefined],
    [{ state: "OPEN", status: "Next Up", labels: [], assignees: 0 }, true, "Todo"],
    [{ state: "OPEN", labels: [], assignees: 0 }, false, "Todo"],
    [{ state: "CLOSED", labels: ["phase"], assignees: 0 }, false, undefined],
    [{ state: "CLOSED", labels: ["wayfinder:map"], assignees: 0 }, false, undefined],
  ] as [Ticket, boolean, string | undefined][])("backfill %j (bootstrap %s)", (ticket, bootstrap, expected) => {
    expect(backfillStatus(ticket, bootstrap)).toBe(expected);
  });
  it("protects closed tickets, maps, phases and more advanced states", () => {
    const ticket = { state: "CLOSED", labels: [], assignees: 0, status: "Done" };
    expect(transition(ticket, "Review")).toBe(false);
    expect(transition(ticket, "Complete")).toBe(true);
    expect(transition({ ...ticket, labels: ["phase"] }, "Complete")).toBe(false);
    expect(transition({ ...ticket, state: "OPEN", status: "Review" }, "In Progress", ["", "Todo", "Next Up"])).toBe(
      false,
    );
    expect(branchIssue("feature/42-name")).toBe(42);
    expect(branchIssue("42-name")).toBeUndefined();
    expect(branchIssue("feature/no-number")).toBeUndefined();
    expect(bodyIssues("Fixes: #3 and closes #4. RESOLVED #5, prefix#6, Closes other/repo#7")).toEqual([3, 4, 5]);
  });
});
async function fixture() {
  const api = new FakeGitHub();
  const ctx: Context = { api, repo: api.repo, plan: false, log: () => {}, sleep: async () => {} };
  await run(ctx, { command: "setup", automation: false });
  api.calls = [];
  return { api, ctx };
}
it.each([
  ["Todo", { EVENT: "issues", ACTION: "assigned", ISSUE: "1" }, "Next Up"],
  ["Review", { EVENT: "issues", ACTION: "assigned", ISSUE: "1" }, "Review"],
  ["Next Up", { EVENT: "issues", ACTION: "unassigned", ISSUE: "1" }, "Todo"],
  ["Todo", { EVENT: "create", REF_TYPE: "branch", REF: "feature/1-work" }, "In Progress"],
  ["Review", { EVENT: "create", REF_TYPE: "branch", REF: "feature/1-work" }, "Review"],
  ["Todo", { EVENT: "start", ISSUE: "1" }, "In Progress"],
  ["Todo", { EVENT: "workflow_dispatch", START: "1" }, "In Progress"],
  ["Todo", { EVENT: "pull_request", ACTION: "opened", PR: "5", PR_DRAFT: "true" }, "In Progress"],
  ["In Progress", { EVENT: "pull_request", ACTION: "ready_for_review", PR: "5" }, "Review"],
  ["Review", { EVENT: "pull_request", ACTION: "converted_to_draft", PR: "5" }, "In Progress"],
  [
    "Review",
    { EVENT: "pull_request_review", ACTION: "submitted", PR: "5", REVIEW_STATE: "changes_requested" },
    "In Progress",
  ],
  ["Review", { EVENT: "pull_request_review", ACTION: "submitted", PR: "5", REVIEW_STATE: "approved" }, "Review"],
  ["Done", { EVENT: "push", PUSH_REF: "refs/heads/main" }, "Complete"],
  ["Done", { EVENT: "push", PUSH_REF: "refs/heads/staging" }, "Done"],
] as [string, Record<string, string>, string][])("event from %s: %j -> %s", async (from, event, expected) => {
  const { api, ctx } = await fixture();
  api.items[0].status = { name: from };
  await runEvent(ctx, api.project, event);
  expect(api.items[0].status?.name).toBe(expected);
});
it("merge closes only local tickets, comments before close and preserves protected issues", async () => {
  const { api, ctx } = await fixture();
  api.issues[0].labels = [{ name: "needs-changes" }];
  api.pull.closingIssuesReferences.nodes.push({ number: 99, repository: { nameWithOwner: "other/widgets" } });
  await runEvent(ctx, api.project, {
    EVENT: "pull_request",
    ACTION: "closed",
    PR: "5",
    PR_BASE: "dev",
    PR_MERGED: "true",
  });
  expect(api.issues[0].state).toBe("closed");
  expect(api.issues[0].labels).toEqual([]);
  expect(api.items[0].status?.name).toBe("Done");
  const comment = api.calls.findIndex((c) => c.path?.endsWith("/comments"));
  const close = api.calls.findIndex((c) => c.method === "PATCH" && c.body?.state === "closed");
  expect(comment).toBeLessThan(close);
  expect(api.calls.some((c) => c.path?.endsWith("/99"))).toBe(false);
  api.issues[0].state = "open";
  api.issues[0].labels = [{ name: "phase" }];
  api.calls = [];
  await runEvent(ctx, api.project, {
    EVENT: "pull_request",
    ACTION: "closed",
    PR: "5",
    PR_BASE: "dev",
    PR_MERGED: "true",
  });
  expect(api.calls.some((c) => c.method === "PATCH")).toBe(false);
});
it("research never enters Review; maps/phases stay untouched in promotion and backfill", async () => {
  const { api, ctx } = await fixture();
  api.issues[0].labels = [{ name: "wayfinder:research" }];
  await runEvent(ctx, api.project, { EVENT: "pull_request", ACTION: "opened", PR: "5" });
  expect(api.items[0].status?.name).toBe("Todo");
  api.issues[0].labels = [{ name: "phase" }];
  api.items[0].status = { name: "Done" };
  await runEvent(ctx, api.project, { EVENT: "push", PUSH_REF: "refs/heads/main" });
  api.items[0].status = { name: "Todo" };
  api.issues[0].state = "closed";
  await backfill(ctx, api.project);
  expect(api.items[0].status?.name).toBe("Todo");
});

// A staging branch (next): pull requests merge into it, and it reaches dev by a fast-forward push (#251).
function staged(api: FakeGitHub, compare: string[] | undefined) {
  const list = api.pages.bind(api);
  const read = api.rest.bind(api);
  api.pages = async <T>(path: string): Promise<T[]> => {
    if (path.includes("/pulls?state=closed&base=next"))
      return [
        { number: 5, merge_commit_sha: "c5", merged_at: "2026-11-27T12:00:00Z" },
        { number: 6, merge_commit_sha: "c6", merged_at: "2026-11-27T12:00:00Z" },
        { number: 7, merge_commit_sha: "c7", merged_at: null },
      ] as T[];
    return list(path);
  };
  api.rest = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    if (path.includes("/compare/bbbb...aaaa")) {
      api.calls.push({ kind: "rest", method, path });
      if (!compare) throw new GitHubError("Not Found", 404);
      const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
      return { total_commits: compare.length, commits: compare.slice(page - 1, page).map((sha) => ({ sha })) } as T;
    }
    return read(method, path, body);
  };
}
const land = {
  EVENT: "push",
  PUSH_REF: "refs/heads/dev",
  STAGING_BRANCH: "next",
  PUSH_BEFORE: "bbbb",
  PUSH_AFTER: "aaaa",
};
it("a push to dev closes the issues of PRs into next whose merge commits it brings, reading every compare page", async () => {
  const { api, ctx } = await fixture();
  staged(api, ["c1", "c5", "c7"]);
  api.items[0].status = { name: "Review" };
  await runEvent(ctx, api.project, land);
  expect(api.issues[0].state).toBe("closed");
  expect(api.items[0].status?.name).toBe("Done");
  expect(api.calls.filter((c) => c.path?.includes("/compare/"))).toHaveLength(3);
  const comment = api.calls.find((c) => c.path?.endsWith("/issues/1/comments"));
  expect(comment?.body).toEqual({ body: "Merged into `dev` by #5." });
});
it("a merge commit already in dev, an unmerged PR, a new branch or no staging branch close nothing", async () => {
  for (const [compare, event] of [
    [["c9"], land],
    [["c7"], land],
    [undefined, land],
    [["c5"], { ...land, PUSH_BEFORE: "0000000000000000000000000000000000000000" }],
    [["c5"], { ...land, STAGING_BRANCH: "" }],
  ] as [string[] | undefined, Record<string, string>][]) {
    const { api, ctx } = await fixture();
    staged(api, compare);
    api.pull.headRefName = "feature/1-task";
    await runEvent(ctx, api.project, event);
    // PR 6 and PR 7 link the same issue 1, so a close here would mean a wrong rule fired.
    expect(api.issues[0].state).toBe("open");
  }
});
it("a PR with no closing references links the issues its body closes", async () => {
  const { api, ctx } = await fixture();
  api.pull.headRefName = "chore/tidy";
  api.pull.closingIssuesReferences.nodes = [];
  api.pull.body = "Tidy up. Fixes: #1, closes #99";
  api.items[0].status = { name: "In Progress" };
  await runEvent(ctx, api.project, { EVENT: "pull_request", ACTION: "opened", PR: "5" });
  expect(api.items[0].status?.name).toBe("Review");
  api.items[0].status = { name: "In Progress" };
  api.pull.closingIssuesReferences.nodes = [{ number: 2, repository: { nameWithOwner: "other/widgets" } }];
  await runEvent(ctx, api.project, { EVENT: "pull_request", ACTION: "opened", PR: "5" });
  expect(api.items[0].status?.name).toBe("In Progress");
});

// Backfill from pull requests and branches (#253): every rule, strongest first.
const pull = (number: number, head: string, base: string, extra: Partial<Pull> = {}): Pull => ({
  number,
  state: "closed",
  draft: false,
  merged_at: "2026-11-27T12:00:00Z",
  merge_commit_sha: `m${number}`,
  body: "",
  head: { ref: head },
  base: { ref: base },
  ...extra,
});
async function board(setup: (api: FakeGitHub) => void, env: Record<string, string> = {}, plan = false) {
  const { api, ctx } = await fixture();
  const lines: string[] = [];
  ctx.log = (line) => lines.push(line);
  ctx.plan = plan;
  api.items[0].status = { name: "Todo" };
  setup(api);
  await backfill(ctx, api.project, false, env);
  return { api, lines };
}
describe("backfill reads pull requests and branches", () => {
  it("closes a ticket whose merged pull request is in dev, then Done", async () => {
    const { api } = await board((api) => {
      api.pulls = [pull(5, "feat/1-task", "dev")];
      api.inDev.add("m5");
    });
    expect(api.issues[0].state).toBe("closed");
    expect(api.items[0].status?.name).toBe("Done");
    const comment = api.calls.find((c) => c.path?.endsWith("/issues/1/comments"));
    expect(comment?.body).toEqual({ body: "Merged into `dev` by #5." });
  });
  it("links a pull request by a body Closes line when its branch names no ticket", async () => {
    const { api } = await board((api) => {
      api.pulls = [pull(6, "chore/tidy", "next", { body: "Tidy.\n\nFixes: #1" })];
      api.inDev.add("m6");
    });
    expect(api.issues[0].state).toBe("closed");
  });
  it("a Refs-only pull request closes nothing", async () => {
    const { api } = await board((api) => {
      api.pulls = [pull(7, "chore/tidy", "dev", { body: "Refs #1" })];
      api.inDev.add("m7");
    });
    expect(api.issues[0].state).toBe("open");
    expect(api.items[0].status?.name).toBe("Todo");
  });
  it("a pull request merged into next but not in dev yet is Review", async () => {
    const { api } = await board((api) => (api.pulls = [pull(8, "feat/1-task", "next")]), { STAGING_BRANCH: "next" });
    expect(api.issues[0].state).toBe("open");
    expect(api.items[0].status?.name).toBe("Review");
  });
  it.each([
    [false, "Review"],
    [true, "In Progress"],
  ])("an open pull request (draft %s) is %s", async (draft, expected) => {
    const { api } = await board(
      (api) => (api.pulls = [pull(9, "feat/1-task", "next", { state: "open", draft, merged_at: null })]),
    );
    expect(api.items[0].status?.name).toBe(expected);
  });
  it("a closed, unmerged pull request counts for nothing", async () => {
    const { api } = await board((api) => (api.pulls = [pull(10, "feat/1-task", "dev", { merged_at: null })]));
    expect(api.items[0].status?.name).toBe("Todo");
  });
  it("a pushed numbered branch is In Progress from Todo, and never pulls Review back", async () => {
    const { api } = await board((api) => (api.branches = ["feature/1-work"]));
    expect(api.items[0].status?.name).toBe("In Progress");
    const again = await board((api) => {
      api.branches = ["feature/1-work"];
      api.items[0].status = { name: "Review" };
    });
    expect(again.api.items[0].status?.name).toBe("Review");
  });
  it("a reopened needs-changes ticket waits for new work, not the merged pull request", async () => {
    const { api } = await board((api) => {
      api.issues[0].labels = [{ name: "needs-changes" }];
      api.pulls = [pull(11, "feat/1-task", "dev")];
      api.inDev.add("m11");
    });
    expect(api.issues[0].state).toBe("open");
  });
  it("closed tickets keep today's rules", async () => {
    const { api } = await board((api) => {
      api.issues[0].state = "closed";
      api.items[0].status = { name: "Review" };
    });
    expect(api.items[0].status?.name).toBe("Done");
  });
  it("--plan prints the close and the move and writes nothing", async () => {
    const { api, lines } = await board(
      (api) => {
        api.pulls = [pull(5, "feat/1-task", "dev")];
        api.inDev.add("m5");
      },
      {},
      true,
    );
    expect(lines).toContain("would close #1 merged into dev by #5");
    expect(lines).toContain("would move #1: Todo -> Done");
    expect(api.issues[0].state).toBe("open");
    expect(api.calls.some((c) => (c.kind === "rest" ? c.method !== "GET" : c.query?.startsWith("mutation")))).toBe(
      false,
    );
  });
});
