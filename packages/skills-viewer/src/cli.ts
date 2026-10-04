#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultRoots } from "./discover.js";
import { buildGraph, VERSION } from "./graph.js";
import { loadGitHub, parseRepoInput, type Via } from "./github.js";
import type { Graph } from "./types.js";
import { renderHtml } from "./html.js";
import { toMermaid } from "./mermaid.js";
import { relative, serveAndWatch } from "./watch.js";

const HELP = `skills-viewer ${VERSION}
Statically map a folder of agent skills (SKILL.md) into graph.json, graph.mmd and a self-contained graph.html.

Usage: skills-viewer [paths...] [options]
       skills-viewer <owner/repo | github URL> [options]

  paths            skill roots, single skill folders, or a plugin / library repo checkout (default:
                   .claude/skills, .agents/skills, ~/.claude/skills, ~/.codex/skills, ~/.agents/skills,
                   and .claude-plugin skills)
  owner/repo       a GitHub repo instead, fetched without git: owner/repo, owner/repo@ref,
                   https://github.com/o/r, .../tree/<ref>/<folder>. Uses GITHUB_TOKEN or GH_TOKEN if set.
  --via <how>      GitHub fetch: tarball (default, one download) or tree (what the web app uses)
  --out <dir>      output folder (default: ./skills-graph)
  --title <text>   page title (default: folder name)
  --no-open        do not open graph.html in the browser
  --watch          serve the page, watch the roots, re-analyze on change, auto-refresh
  --host           with --watch: bind 0.0.0.0 and print network URLs
  --port <n>       with --watch: port (default 4173)
  --json           print graph.json to stdout instead of writing files
  -h, --help       this help
`;

interface Args {
  paths: string[];
  out: string;
  title?: string;
  open: boolean;
  watch: boolean;
  host: boolean;
  port: number;
  json: boolean;
  via: Via;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { paths: [], out: "skills-graph", open: true, watch: false, host: false, port: 4173, json: false, via: "tarball" };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-h" || x === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (x === "--out") a.out = argv[++i];
    else if (x === "--title") a.title = argv[++i];
    else if (x === "--no-open") a.open = false;
    else if (x === "--open") a.open = true;
    else if (x === "--watch") a.watch = true;
    else if (x === "--host") a.host = true;
    else if (x === "--port") a.port = Number(argv[++i]);
    else if (x === "--json") a.json = true;
    else if (x === "--via") a.via = argv[++i] === "tree" ? "tree" : "tarball";
    else if (x.startsWith("-")) {
      process.stderr.write(`unknown option ${x}\n${HELP}`);
      process.exit(2);
    } else a.paths.push(x);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const remote = args.paths.length === 1 && !fs.existsSync(args.paths[0]) ? parseRepoInput(args.paths[0]) : null;
  if (remote) return mainGitHub(args, remote);
  const roots = args.paths.length ? args.paths.map((p) => path.resolve(p)) : defaultRoots();
  if (!roots.length) {
    process.stderr.write("no skill folders found; pass a path\n");
    process.exit(1);
  }
  const title = args.title ?? (args.paths.length === 1 ? path.basename(roots[0]) : "Skills map");
  const log = (m: string) => process.stderr.write(m + "\n");

  const regenerate = () => {
    const graph = buildGraph(roots);
    const html = renderHtml(graph, { title, watch: args.watch });
    return { graph, html };
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(buildGraph(roots), null, 2) + "\n");
    return;
  }

  const { graph, html } = regenerate();
  const out = writeOutputs(args, graph, html, roots.map(relative).join(", "));

  if (args.watch) {
    serveAndWatch({ roots, port: args.port, host: args.host, regenerate, log });
    if (args.open) openInBrowser(`http://localhost:${args.port}/`);
    return;
  }
  if (args.open) openInBrowser(path.join(out, "graph.html"));
}

async function mainGitHub(args: Args, remote: NonNullable<ReturnType<typeof parseRepoInput>>) {
  if (args.watch) {
    process.stderr.write("--watch needs a local folder\n");
    process.exit(2);
  }
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined;
  const graph = await loadGitHub(remote, { via: args.via, token });
  if (args.json) {
    process.stdout.write(JSON.stringify(graph, null, 2) + "\n");
    return;
  }
  const html = renderHtml(graph, { title: args.title ?? `${remote.owner}/${remote.repo}` });
  const src = graph.meta.source;
  const label = src.kind === "github" ? `${src.owner}/${src.repo}@${src.sha?.slice(0, 7) ?? src.ref}${src.subpath ? "/" + src.subpath : ""}` : "";
  const out = writeOutputs(args, graph, html, label);
  if (args.open) openInBrowser(path.join(out, "graph.html"));
}

function writeOutputs(args: Args, graph: Graph, html: string, from: string): string {
  const log = (m: string) => process.stderr.write(m + "\n");
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph, null, 2));
  fs.writeFileSync(path.join(out, "graph.mmd"), toMermaid(graph, { html: false, flows: true }));
  fs.writeFileSync(path.join(out, "graph.html"), html);
  const entries = graph.nodes.filter((n) => n.entry).map((n) => n.name);
  const warnings = graph.edges.filter((e) => e.warning).length;
  const plugins = graph.meta.pluginCount ? `, ${graph.meta.pluginCount} plugins, ${graph.meta.partCount} parts` : graph.meta.partCount ? `, ${graph.meta.partCount} parts` : "";
  log(`${graph.meta.skillCount} skills, ${graph.meta.edgeCount} edges, ${graph.meta.flowCount} flows${plugins} from ${from}`);
  log(`entry points: ${entries.join(", ") || "none"}${warnings ? ` · ${warnings} edge(s) call a manual-only skill ⚠` : ""}`);
  for (const w of graph.meta.warnings) log(`warning: ${w}`);
  log(`wrote ${relative(path.join(out, "graph.json"))}, ${relative(path.join(out, "graph.mmd"))}, ${relative(path.join(out, "graph.html"))}`);
  return out;
}

function openInBrowser(target: string) {
  const [cmd, cmdArgs] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  try {
    spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* opening is best-effort */
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
