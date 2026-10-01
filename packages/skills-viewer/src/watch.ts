import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Graph } from "./types.js";

export interface WatchOptions {
  roots: string[];
  port: number;
  host: boolean;
  regenerate: () => { graph: Graph; html: string };
  log: (msg: string) => void;
}

/** Serve graph.html, watch the skill roots, regenerate on change, and let the page poll /__version. */
export function serveAndWatch(o: WatchOptions): http.Server {
  let version = 1;
  let current = o.regenerate();
  let timer: NodeJS.Timeout | null = null;

  const rebuild = (why: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        current = o.regenerate();
        version++;
        o.log(`re-analyzed (${why}): ${current.graph.meta.skillCount} skills, ${current.graph.meta.edgeCount} edges, ${current.graph.meta.flowCount} flows`);
      } catch (e) {
        o.log(`re-analyze failed: ${(e as Error).message}`);
      }
    }, 300);
  };

  for (const root of o.roots) {
    try {
      fs.watch(root, { recursive: true }, (_ev, file) => {
        if (file && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(file))) return;
        rebuild(String(file ?? root));
      });
    } catch (e) {
      o.log(`cannot watch ${root}: ${(e as Error).message}`);
    }
  }

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/__version") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(String(version));
    } else if (url === "/graph.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(current.graph, null, 2));
    } else if (url === "/" || url === "/graph.html" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(current.html);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(o.port, o.host ? "0.0.0.0" : "127.0.0.1", () => {
    o.log(`  Local:   http://localhost:${o.port}/`);
    if (o.host) for (const ip of lanAddresses()) o.log(`  Network: http://${ip}:${o.port}/`);
  });
  return server;
}

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

export function relative(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
}
