import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, writeFile, cp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FakeGitHub } from "./fixtures/github.js";
import { run } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/main.ts";
import type { Context } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/types.ts";
import { parsePhases, syncRoadmap } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/roadmap.ts";
import { setEstimate } from "../../skills/skills/oneezy/oneezy-task-manager/scripts/steps/backlog.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = () => {
  const api = new FakeGitHub();
  const lines: string[] = [];
  const ctx: Context = { api, repo: api.repo, plan: false, log: (line) => lines.push(line), sleep: async () => {} };
  return { api, ctx, lines };
};
const writes = (api: FakeGitHub) =>
  api.calls.filter((c) => (c.kind === "rest" ? c.method !== "GET" : c.query?.trim().startsWith("mutation")));

describe("sequential workflow", () => {
  it("creates and links a missing project before preparing its fields and views", async () => {
    const { api, ctx } = fixture();
    const call = api.graphql.bind(api);
    let created = false;
    api.graphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      if (!created && query.includes("projectsV2(first:"))
        return { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } } } as T;
      if (query.includes("createProjectV2(input:")) {
        expect(variables).toEqual({ owner: "U_1", title: "widgets", repo: "R_1" });
        created = true;
        return { createProjectV2: { projectV2: { id: "P_1" } } } as T;
      }
      if (query.startsWith("mutation")) expect(created).toBe(true);
      return call(query, variables);
    };
    await expect(run(ctx, { command: "run", automation: false })).resolves.toMatchObject({ state: "ok" });
    expect(created).toBe(true);
  });
  it("repairs the three views in order and reruns without duplicate data writes", async () => {
    const { api, ctx } = fixture();
    await expect(run(ctx, { command: "run", automation: false })).resolves.toMatchObject({ state: "ok" });
    const creates = api.calls.filter((c) => c.method === "POST" && c.path?.endsWith("/views"));
    expect(creates.map((c) => c.body?.name)).toEqual(["Backlog", "Board", "Roadmap"]);
    expect(api.items[0].status?.name).toBe("Todo");
    api.calls = [];
    await run(ctx, { command: "run", automation: false });
    expect(writes(api)).toEqual([]);
  });
  it("plans every stage with no writes, browser launch or dispatch", async () => {
    const { api, ctx, lines } = fixture();
    ctx.plan = true;
    await run(ctx, { command: "run", openBrowser: true, waitSeconds: 20 });
    expect(writes(api)).toEqual([]);
    expect(lines.join("\n")).toContain("create view Roadmap");
  });
  it("stops on a failed prerequisite before starting Board or Roadmap", async () => {
    const { api, ctx } = fixture();
    const rest = api.rest.bind(api);
    api.rest = async (method, route, body) => {
      if (method === "POST" && route.endsWith("/views")) throw new Error("view creation failed");
      return rest(method, route, body);
    };
    await expect(run(ctx, { command: "run" })).rejects.toThrow("view creation failed");
    expect(api.calls.some((c) => c.variables?.name === "Start")).toBe(false);
    expect(api.calls.some((c) => c.path?.includes("dispatches"))).toBe(false);
  });
});

describe("roadmap", () => {
  it("parses dashes, preserves suffixes and nested content, ignores fenced headings and non-phase sections", () => {
    const phases = parsePhases(
      "## Phase 1 - Start (Milestone 2)\r\n\r\nText.\r\n\r\n### Child\r\n- [ ] todo\r\n```md\r\n## Phase 99 — example\r\n```\r\n## Cross-cutting\r\nOther\r\n## Phase 2 – End\r\nLast",
    );
    expect(phases.map((p) => p.title)).toEqual(["Phase 1 — Start (Milestone 2)", "Phase 2 — End"]);
    expect(phases[0].text).toContain("### Child");
    expect(phases[0].first).toBe("Text.");
    expect(() => parsePhases("## Phase 1 - A\n## Phase 1 - B")).toThrow("Duplicate");
  });
  it("creates once, keeps human dates/milestones and updates changed source bodies", async () => {
    const { api, ctx } = fixture();
    const source = { text: "## Phase 1 — Start\n\nFirst paragraph.\n\n- [ ] task", where: "roadmap.md at abc" };
    await syncRoadmap(ctx, api.project, source);
    const issue = api.issues.at(-1)!;
    expect(issue.milestone?.number).toBe(1);
    api.calls = [];
    await syncRoadmap(ctx, api.project, source);
    expect(writes(api)).toEqual([]);
    issue.milestone = { number: 99, title: "Human choice" };
    await syncRoadmap(ctx, api.project, { ...source, text: source.text.replace("task", "changed") });
    expect(issue.milestone.number).toBe(99);
    expect(issue.body).toContain("changed");
    expect(JSON.stringify(writes(api))).not.toMatch(/due_on|singleSelectOptionId|Start|Due/);
  });
  it("reports a missing issue milestone in plan mode even when its milestone must be created", async () => {
    const { api, ctx, lines } = fixture();
    api.issues[0].title = "Phase 1 — Start";
    ctx.plan = true;
    await syncRoadmap(ctx, api.project, { text: "## Phase 1 - Start\nText", where: "source" });
    expect(lines.join("\n")).toContain("issue milestone");
    expect(writes(api)).toEqual([]);
  });
});

describe("estimate guard", () => {
  it("validates all rules before writing; first values can size a closed issue", async () => {
    const { api, ctx } = fixture();
    await run(ctx, { command: "setup", automation: false });
    api.issues[0].state = "closed";
    api.calls = [];
    await expect(
      setEstimate(ctx, api.project, { number: 1, estimate: 3, type: "bug", comment: "why" }),
    ).rejects.toThrow("Type is only");
    expect(writes(api)).toEqual([]);
    await setEstimate(ctx, api.project, { number: 1, estimate: 3, priority: "High", comment: "Completed work" });
    api.calls = [];
    await expect(setEstimate(ctx, api.project, { number: 1, estimate: 5, comment: "why" })).rejects.toThrow(
      "write-once",
    );
    expect(writes(api)).toEqual([]);
  });
});

it("discovers a working TypeScript project when a developer opens the skill scripts directly", () => {
  const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  execFileSync(process.execPath, [compiler, "--noEmit"], {
    cwd: path.resolve(root, "../skills/skills/oneezy/oneezy-task-manager/scripts"),
    windowsHide: true,
  });
});

it("runs the skill alone outside the checkout: help and a complete mocked CLI workflow", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "task-manager-portable-"));
  try {
    await writeFile(path.join(temp, "package.json"), JSON.stringify({ type: "module" }));
    await cp(
      process.env.TASK_MANAGER_TEST_SKILL ?? path.resolve(root, "../skills/skills/oneezy/oneezy-task-manager"),
      path.join(temp, "skill"),
      {
        recursive: true,
        dereference: true,
      },
    );
    const files = (await readdir(path.join(temp, "skill"), { recursive: true, withFileTypes: true }))
      .filter((file) => file.isFile())
      .map((file) => path.join(file.parentPath, file.name));
    expect(files.some((file) => file.endsWith(".mjs"))).toBe(false);
    expect(files.filter((file) => file.endsWith(".ts"))).toHaveLength(7);
    expect(files.some((file) => file.includes("capabilities"))).toBe(false);
    await cp(path.join(root, "test/fixtures/github.js"), path.join(temp, "fake.js"));
    const entry = path.join(temp, "skill/scripts/main.ts");
    const env = { ...process.env, GH_TOKEN: "fixture-token", GITHUB_TOKEN: "", PROJECT_PAT: "", PATH: "" };
    const help = execFileSync(process.execPath, [entry, "--help"], {
      cwd: temp,
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(help).toContain("Backlog -> Board -> Roadmap");
    const preload = `import { FakeGitHub } from './fake.js';
const fake = new FakeGitHub();
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.github.com/')) throw new Error('Network refused');
  const route = String(url).slice('https://api.github.com/'.length);
  const body = options.body ? JSON.parse(options.body) : undefined;
  const value = route === 'graphql' ? { data: await fake.graphql(body.query, body.variables) } : await fake.rest(options.method || 'GET', route, body);
  return value === undefined ? new Response(null, {status: 204}) : Response.json(value);
};
`;
    await writeFile(path.join(temp, "preload.js"), preload);
    const output = execFileSync(
      process.execPath,
      ["--import", pathToFileURL(path.join(temp, "preload.js")).href, entry, "run", "--repo", "acme/widgets"],
      { cwd: temp, env, encoding: "utf8", windowsHide: true },
    );
    expect(JSON.parse(output)).toMatchObject({ state: "ok", planned: false });
    for (const name of ["backlog", "board", "roadmap"])
      expect(await readFile(path.join(temp, `skill/scripts/steps/${name}.ts`), "utf8")).toBeTruthy();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
