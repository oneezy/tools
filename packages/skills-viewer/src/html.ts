import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Graph } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..", "..");

export function renderHtml(graph: Graph, opts: { title?: string; watch?: boolean } = {}): string {
  const template = fs.readFileSync(path.join(pkgRoot, "templates", "graph.html"), "utf8");
  // the compiled mermaid module, minus its `export` keywords so it can live inline in the page's module script
  const mermaidModule = fs
    .readFileSync(path.join(pkgRoot, "dist", "src", "mermaid.js"), "utf8")
    .replace(/^export\s+(?=(?:async\s+)?function|const|let|class)/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "")
    .replace(/^import[^\n]*\n/gm, "");
  const json = JSON.stringify(graph)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
  return template
    .replace(/__TITLE__/g, escapeHtml(opts.title ?? "Skills map"))
    .replace("__GRAPH_JSON__", () => json)
    .replace("__MERMAID_MODULE__", () => mermaidModule)
    .replace("__WATCH__", opts.watch ? "true" : "false");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
