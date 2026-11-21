import { readFile } from "node:fs/promises";
import path from "node:path";
import { command, type Command } from "../github.ts";
import type { Context, Issue, Project } from "../types.ts";
import { addItem, ensureField, ensureView, getItems, views } from "../project.ts";
import { ensureLabels, listIssues } from "./backlog.ts";

export interface Roadmap {
  text: string;
  where: string;
}
export interface Phase {
  number: number;
  title: string;
  text: string;
  first: string;
}
export const formatText = (text: string | null | undefined): string =>
  (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+(?=\n|$)/g, "")
    .replace(/^\n+|\n+$/g, "");
export function parsePhases(markdown: string): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | undefined;
  let fence: string | undefined;
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const insideFence = !!fence;
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length)))
      fence = fence ? undefined : marker;
    if (!insideFence && !marker && /^##\s/.test(line)) {
      current = undefined;
      const match = /^## Phase\s+(\d+)\s+[-–—]\s+(\S.*?)\s*$/.exec(line);
      if (match) {
        current = { number: Number(match[1]), title: `Phase ${match[1]} — ${match[2]}`, text: "", first: "" };
        if (phases.some((p) => p.number === current!.number))
          throw new Error(`Duplicate phase number ${current.number}`);
        phases.push(current);
      }
    } else if (current) current.text += `${line}\n`;
  }
  for (const phase of phases) {
    phase.text = formatText(phase.text);
    phase.first = phase.text.split(/\n\s*\n/, 1)[0];
  }
  if (!phases.length) throw new Error('No "## Phase <n> — <title>" sections found');
  return phases;
}
export async function readRoadmap(source: string, run: Command = command, request = fetch): Promise<Roadmap> {
  if (/^https?:\/\//.test(source)) {
    const url = source.replace(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//,
      "https://raw.githubusercontent.com/$1/",
    );
    // No GitHub credential is sent to user-provided URLs.
    const response = await request(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Roadmap source returned HTTP ${response.status}`);
    return { text: await response.text(), where: source };
  }
  const absolute = path.resolve(source);
  const text = await readFile(absolute, "utf8");
  const git = (...args: string[]) => run("git", ["-C", path.dirname(absolute), ...args]);
  let prefix: string;
  try {
    prefix = await git("rev-parse", "--show-prefix");
  } catch {
    return { text, where: absolute };
  }
  let where = `\`${prefix}${path.basename(absolute)}\``;
  const commit = await git("log", "-1", "--format=%h", "--", absolute);
  if (commit) where += ` at \`${commit}\``;
  if (await git("status", "--porcelain", "--", absolute)) where += " with uncommitted edits";
  const remote = await git("remote", "get-url", "origin").catch(() => "");
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  if (repo) where += ` in ${repo}`;
  return { text, where };
}
export async function prepareRoadmap(ctx: Context, project: Project): Promise<void> {
  await ensureField(ctx, project, "Start", "DATE");
  await ensureField(ctx, project, "Due", "DATE");
  await ensureView(ctx, project, views[2]);
}
export function issueText(body: string | null): string {
  const text = formatText(body);
  const footer = text.lastIndexOf("\n---\nSource: ");
  return formatText(footer < 0 ? text : text.slice(0, footer));
}
interface Milestone {
  number: number;
  title: string;
  description: string | null;
}
export async function syncRoadmap(ctx: Context, project: Project | undefined, source: Roadmap): Promise<void> {
  const phases = parsePhases(source.text);
  const issues = await listIssues(ctx);
  const milestones = await ctx.api.pages<Milestone>(`repos/${ctx.repo.full_name}/milestones?state=all`);
  const have = new Set(project ? (await getItems(ctx, project)).map((i) => i.content?.url) : []);
  await ensureLabels(ctx, "phase");
  if (!project) ctx.log("manual: no linked project; setup is needed to add phases to the roadmap view");
  const footer = `---\nSource: ${source.where}. Written by task-manager (oneezy/tools, packages/task-manager): edit the roadmap file, not this issue.`;
  for (const phase of phases) {
    const changes: string[] = [];
    let milestone = milestones.find((m) => m.title === phase.title);
    if (!milestone) {
      changes.push("milestone");
      if (!ctx.plan)
        milestone = await ctx.api.rest<Milestone>("POST", `repos/${ctx.repo.full_name}/milestones`, {
          title: phase.title,
          description: phase.first,
        });
    } else if (formatText(milestone.description) !== phase.first) {
      changes.push("milestone description");
      if (!ctx.plan)
        await ctx.api.rest("PATCH", `repos/${ctx.repo.full_name}/milestones/${milestone.number}`, {
          description: phase.first,
        });
    }
    let issue = issues.filter((i) => i.title === phase.title).sort((a, b) => a.number - b.number)[0];
    const isNew = !issue;
    const body = `${phase.text}\n\n${footer}`;
    if (!issue) {
      changes.push("issue");
      if (!ctx.plan)
        issue = await ctx.api.rest<Issue>("POST", `repos/${ctx.repo.full_name}/issues`, {
          title: phase.title,
          body,
          labels: ["phase"],
          milestone: milestone!.number,
        });
    } else {
      const patch: Record<string, unknown> = {};
      if (issueText(issue.body) !== phase.text) {
        patch.body = body;
        changes.push("body");
      }
      if (!issue.labels.some((l) => l.name === "phase")) {
        patch.labels = [...issue.labels.map((l) => l.name), "phase"];
        changes.push("phase label");
      }
      // Existing milestone assignments (including a human's alternative) survive.
      if (!issue.milestone) {
        changes.push("issue milestone");
        if (milestone) patch.milestone = milestone.number;
      }
      if (!ctx.plan && Object.keys(patch).length)
        await ctx.api.rest("PATCH", `repos/${ctx.repo.full_name}/issues/${issue.number}`, patch);
    }
    if (project && (!issue || !have.has(issue.html_url))) {
      changes.push("project item");
      if (!ctx.plan) await addItem(ctx, project, issue!.node_id);
    }
    const verb = isNew
      ? ctx.plan
        ? "create"
        : "created"
      : changes.length
        ? ctx.plan
          ? "update"
          : "updated"
        : "kept";
    ctx.log(`${verb} ${phase.title}: ${changes.join(", ") || `issue #${issue!.number}`}`);
  }
}
