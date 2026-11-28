import { expect, it } from "vite-plus/test";
import {
  dispatchBackfill,
  ensureCaller,
  waitAutoAdd,
} from "../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/board.ts";
import { GitHubError } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/github.ts";
import { FakeGitHub } from "./fixtures/github.js";
import type { Context } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/types.ts";

function fixture() {
  const api = new FakeGitHub();
  const logs: string[] = [];
  const ctx: Context = { api, repo: api.repo, plan: false, log: (line) => logs.push(line) };
  return { api, ctx, logs };
}
it("leaves the host workflow intact and dispatches to dev when registered", async () => {
  const { api, ctx } = fixture();
  expect(await ensureCaller(ctx, "template")).toBe(true);
  await dispatchBackfill(ctx);
  expect(api.calls.filter((c) => c.method !== "GET" && c.kind === "rest")).toEqual([
    expect.objectContaining({
      method: "POST",
      path: "repos/acme/widgets/actions/workflows/task-manager.yml/dispatches",
      body: { ref: "dev", inputs: { backfill: "true" } },
    }),
  ]);
});
it("opens a caller PR on a dedicated branch, never commits directly to dev/main", async () => {
  const { api, ctx } = fixture();
  const read = api.rest.bind(api);
  api.rest = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    if (method === "GET" && (route.includes("/contents/") || route.includes("heads/chore%2F")))
      throw new GitHubError("missing", 404);
    if (method !== "GET") {
      api.calls.push({ kind: "rest", method, path: route, body: body as Record<string, unknown> });
      return { html_url: "https://github.com/acme/widgets/pull/8" } as T;
    }
    return read(method, route, body);
  };
  expect(await ensureCaller(ctx, "name: caller\non: push\n")).toBe(false);
  const writes = api.calls.filter((c) => c.method && c.method !== "GET");
  expect(writes.map((c) => c.method)).toEqual(["POST", "PUT", "POST"]);
  expect(writes[0].body?.ref).toBe("refs/heads/chore/task-manager-caller");
  expect(writes[1].body?.branch).toBe("chore/task-manager-caller");
  expect(writes[2].body).toMatchObject({ head: "chore/task-manager-caller", base: "dev" });
});
it("a caller that names its own staging branch matches the template, and an update keeps that branch", async () => {
  const { api, ctx } = fixture();
  const template = "on:\n  push:\n    with:\n      staging-branch: ''\n";
  api.caller = "on:\n  push:\n    with:\n      staging-branch: next\n";
  expect(await ensureCaller(ctx, template)).toBe(true);
  expect(api.calls.some((c) => c.method !== "GET")).toBe(false);
  api.caller = "on:\n  pull:\n    with:\n      staging-branch: next\n";
  const read = api.rest.bind(api);
  api.rest = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    if (method === "GET" && route.includes("heads/chore%2F")) throw new GitHubError("missing", 404);
    if (method !== "GET") {
      api.calls.push({ kind: "rest", method, path: route, body: body as Record<string, unknown> });
      return { html_url: "https://github.com/acme/widgets/pull/8" } as T;
    }
    return read(method, route, body);
  };
  expect(await ensureCaller(ctx, template)).toBe(false);
  const put = api.calls.find((c) => c.method === "PUT");
  expect(Buffer.from(String(put?.body?.content), "base64").toString("utf8")).toBe(
    "on:\n  push:\n    with:\n      staging-branch: next\n",
  );
});
it("reuses a pending PR and never treats forbidden reads as missing files", async () => {
  const { api, ctx, logs } = fixture();
  api.caller = "old template";
  api.pages = async <T>() => [{ number: 8, html_url: "https://github.com/acme/widgets/pull/8" }] as T[];
  expect(await ensureCaller(ctx, "new template")).toBe(false);
  expect(logs.join()).toContain("merge caller PR");
  expect(api.calls.some((c) => c.method !== "GET")).toBe(false);
  api.rest = async () => {
    throw new GitHubError("forbidden", 403);
  };
  await expect(ensureCaller(ctx, "new template")).rejects.toThrow("forbidden");
});
it("does not dispatch before the default branch registers the caller", async () => {
  const { api, ctx, logs } = fixture();
  const read = api.rest.bind(api);
  api.rest = async (method, route, body) => {
    if (route.includes("/contents/") && route.endsWith("ref=main")) throw new GitHubError("missing", 404);
    return read(method, route, body);
  };
  await dispatchBackfill(ctx);
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  expect(logs.join()).toContain("promote caller to main");
});
it("prints Auto-add without browser/poll in plan mode, verifies bounded polling otherwise", async () => {
  const { api, ctx } = fixture();
  const live = api.project.workflows.nodes.find((w) => w.name === "Auto-add to project")!;
  live.enabled = false;
  let now = 0;
  let opened = 0;
  const dependencies = {
    now: () => now,
    browser: async () => {
      opened++;
    },
    sleep: async (ms: number) => {
      now += ms;
      live.enabled = true;
    },
  };
  ctx.plan = true;
  expect(await waitAutoAdd(ctx, api.project, 10, true, dependencies)).toBe(false);
  expect(opened).toBe(0);
  expect(now).toBe(0);
  ctx.plan = false;
  expect(await waitAutoAdd(ctx, api.project, 10, true, dependencies)).toBe(true);
  expect(opened).toBe(1);
  expect(now).toBe(5000);
});
