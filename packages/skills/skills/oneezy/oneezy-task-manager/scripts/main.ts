#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Context, Project, Repo } from "./types.ts";
import { authenticate, command, GitHub } from "./github.ts";
import { ensureProject, findProject, getProject, pruneViews, status } from "./project.ts";
import {
  importIssues,
  prepareBacklog,
  readBacklog,
  setEstimate,
  EstimateRefusal,
  type EstimateInput,
} from "./steps/backlog.ts";
import {
  backfill,
  prepareBoard,
  runEvent,
  dispatchBackfill,
  ensureCaller,
  waitAutoAdd,
  type Event,
} from "./steps/board.ts";
import { parsePhases, prepareRoadmap, readRoadmap, syncRoadmap } from "./steps/roadmap.ts";

export interface RunOptions {
  command: string;
  source?: string;
  event?: Event;
  estimate?: EstimateInput;
  openBrowser?: boolean;
  waitSeconds?: number;
  automation?: boolean;
}

// Dependency order is explicit: project -> backlog -> board -> roadmap -> import/
// backfill -> caller/dispatch. Each await completes before the next module runs.
export async function run(ctx: Context, options: RunOptions): Promise<unknown> {
  const source = options.source ? await readRoadmap(options.source) : undefined;
  if (source) parsePhases(source.text); // Validate before the first possible write.
  if (["run", "setup", "bootstrap", "repair"].includes(options.command)) {
    let project = await ensureProject(ctx);
    if (!project) {
      ctx.log(
        "plan: after project creation, prepare Backlog -> Board -> Roadmap; import issues -> backfill statuses -> caller PR/dispatch -> report manual settings",
      );
      if (source) await syncRoadmap(ctx, undefined, source);
      return { state: "planned", newProject: true };
    }
    const refresh = async () => {
      if (!ctx.plan) project = await getProject(ctx, project!.id);
    };
    await prepareBacklog(ctx, project);
    await refresh();
    await prepareBoard(ctx, project);
    await refresh();
    await prepareRoadmap(ctx, project);
    await refresh();
    await pruneViews(ctx, project);
    await importIssues(ctx, project);
    await backfill(ctx, project, true, options.event);
    if (source) await syncRoadmap(ctx, project, source);
    if (options.automation !== false) {
      const ready = await ensureCaller(ctx);
      if (ready) await dispatchBackfill(ctx);
    }
    await refresh();
    await waitAutoAdd(ctx, project, options.waitSeconds ?? 0, options.openBrowser ?? false);
    await refresh();
    return { ...(await status(ctx, project)), planned: ctx.plan };
  }
  const project = await findProject(ctx);
  if (options.command === "status") return status(ctx, project);
  if (options.command === "roadmap") {
    if (!source) throw new Error("roadmap requires --source <path or URL>");
    await syncRoadmap(ctx, project, source);
    return { state: ctx.plan ? "planned" : "synced" };
  }
  if (!project) throw new Error("No linked open project; run setup first");
  return runOnProject(ctx, project, options);
}
async function runOnProject(ctx: Context, project: Project, options: RunOptions): Promise<unknown> {
  switch (options.command) {
    case "backlog":
      return readBacklog(ctx, project);
    case "backfill":
      await backfill(ctx, project, false, options.event);
      break;
    case "event":
      await runEvent(ctx, project, options.event ?? {});
      break;
    case "estimate":
      if (!options.estimate) throw new Error("estimate requires --issue and a decision with --comment");
      await setEstimate(ctx, project, options.estimate);
      break;
    default:
      throw new Error(`Unknown command: ${options.command}`);
  }
  return { state: ctx.plan ? "planned" : "done" };
}

export const help = `Task Manager — portable Node runtime (Node 24.12+)

  node scripts/main.ts run --repo owner/name [--source roadmap.md] [--plan]

Commands:
  run / setup / bootstrap / repair  Backlog -> Board -> Roadmap, import/backfill, automation
  status                           Read project drift
  backlog                          Read project + issue JSONL (estimate context)
  roadmap --source <path or URL>    Sync phases and milestones, preserving dates
  backfill                         Recompute board status from issue facts
  event                            Apply one event from environment variables
  estimate --issue N --comment why  Guarded --estimate N / --priority P / --type T writes

Options:
  --repo owner/name      Explicit target; otherwise REPO or origin of current clone
  --plan / --dry-run     Reads only; enforced at the HTTP transport
  --source path-or-url   Optional roadmap markdown
  --no-automation       Skip caller PR creation and workflow dispatch during setup
  --open-browser        Open Auto-add settings (default: print link)
  --wait-seconds N       Poll Auto-add for at most N seconds (default: 0)
  --json                JSON result (backlog always prints JSONL)
  --help                Show help without GitHub or git access

Auth: GH_TOKEN, GITHUB_TOKEN, PROJECT_PAT, or gh auth token --user <owner>.
Local gh tokens are identity-checked. The active gh account is never switched.
Projects operations need GitHub GraphQL access; REST-only hosts cannot run setup.
No npm/pnpm, Bash, PowerShell, or Tools checkout is required for the skill runtime.
`;

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      source: { type: "string" },
      plan: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      "no-automation": { type: "boolean" },
      "open-browser": { type: "boolean" },
      "wait-seconds": { type: "string" },
      issue: { type: "string" },
      estimate: { type: "string" },
      priority: { type: "string" },
      type: { type: "string" },
      comment: { type: "string" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const action = positionals[0] ?? "status";
  if (
    positionals.length > 1 ||
    !["run", "setup", "bootstrap", "repair", "status", "backlog", "roadmap", "backfill", "event", "estimate"].includes(
      action,
    )
  )
    throw new Error("Invalid command; use --help");
  const waitSeconds = Number(values["wait-seconds"] ?? 0);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error("--wait-seconds must be nonnegative");
  if (action === "roadmap" && !values.source) throw new Error("roadmap requires --source");
  let full = values.repo || env.REPO;
  if (!full) {
    const remote = await command("git", ["remote", "get-url", "origin"]).catch(() => "");
    full = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  }
  if (!full || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(full))
    throw new Error("Use --repo owner/name (or set REPO)");
  const plan = !!(values.plan || values["dry-run"] || (action === "event" && env.DRY_RUN));
  const readOnly = plan || ["status", "backlog"].includes(action);
  const token = await authenticate(full.split("/")[0], env);
  const api = new GitHub(token, readOnly);
  const repo = await api.rest<Repo>("GET", `repos/${full}`);
  const result = await run(
    { api, repo, plan, log: (line) => console.error(line) },
    {
      command: action,
      source: values.source,
      event: env,
      estimate:
        action === "estimate"
          ? {
              number: Number(values.issue),
              estimate: values.estimate === undefined ? undefined : Number(values.estimate),
              priority: values.priority,
              type: values.type,
              comment: values.comment ?? "",
            }
          : undefined,
      openBrowser: values["open-browser"],
      waitSeconds,
      automation: !values["no-automation"],
    },
  );
  if (action === "backlog") for (const row of result as unknown[]) console.log(JSON.stringify(row));
  else console.log(JSON.stringify(result, null, values.json ? 2 : undefined));
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(`task-manager: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof EstimateRefusal ? 2 : 1;
  });
}
