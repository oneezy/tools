import { expect, it, describe } from "vite-plus/test";
import {
  backfill,
  backfillStatus,
  branchIssue,
  runEvent,
  transition,
  type Ticket,
} from "../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/board.ts";
import { FakeGitHub } from "./fixtures/github.js";
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
