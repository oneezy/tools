import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { buildGraph } from "skills-viewer/src/graph.ts";
import * as tar from "tar";
import type { RepoRef } from "../repo.ts";
import type { AnalyzeResult } from "../types.ts";

/** Largest tarball we will read; big monorepos are refused rather than half-parsed. */
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
/** Files above this are skipped: SKILL.md and its neighbours are small. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIR = /(^|\/)(node_modules|\.git)\//;

export class AnalyzeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimitRemaining?: number,
    readonly rateLimitReset?: number,
  ) {
    super(message);
  }
}

/**
 * Fetch a repo with one GitHub REST call (the tarball endpoint), extract it to a temp
 * dir and run the skills-viewer engine over it. Paths in the result are repo-relative.
 */
export async function analyzeRepo(r: RepoRef, token?: string): Promise<AnalyzeResult> {
  const res = await fetchTarball(r, token);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "skills-viewer-"));
  try {
    await extract(res.body as unknown as WebReadableStream<Uint8Array>, tmp);

    // GitHub wraps the tree in one folder named <owner>-<repo>-<short sha>
    const [top] = await fs.readdir(tmp);
    if (!top) throw new AnalyzeError("The repo is empty.", 404);
    const repoRoot = path.join(tmp, top);
    const sha = top.slice(top.lastIndexOf("-") + 1);
    const scanRoot = path.join(repoRoot, r.subpath ?? "");
    if (!(await isDir(scanRoot))) throw new AnalyzeError(`No folder "${r.subpath}" in ${r.owner}/${r.repo}.`, 404);

    const graph = buildGraph([scanRoot]);
    const rel = (p: string) => path.relative(repoRoot, p).split(path.sep).join("/");
    for (const n of graph.nodes) {
      n.dir = rel(n.dir);
      n.file = rel(n.file);
    }
    graph.meta.roots = [`${r.owner}/${r.repo}${r.subpath ? `/${r.subpath}` : ""}`];

    return {
      source: { ...r, sha, blobBase: `https://github.com/${r.owner}/${r.repo}/blob/${sha}` },
      graph,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function fetchTarball(r: RepoRef, token?: string): Promise<Response> {
  const ref = r.ref ? `/${encodeURIComponent(r.ref)}` : "";
  const url = `https://api.github.com/repos/${r.owner}/${r.repo}/tarball${ref}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "skills-viewer-web",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (res.ok && res.body) return res;

  const remaining = num(res.headers.get("x-ratelimit-remaining"));
  const reset = num(res.headers.get("x-ratelimit-reset"));
  if ((res.status === 403 || res.status === 429) && remaining === 0) {
    throw new AnalyzeError("GitHub's hourly limit for this server is used up. Try again later.", 429, remaining, reset);
  }
  if (res.status === 404) {
    const what = r.ref ? `${r.owner}/${r.repo} at "${r.ref}"` : `${r.owner}/${r.repo}`;
    throw new AnalyzeError(`Could not find ${what}. Is it public?`, 404, remaining, reset);
  }
  throw new AnalyzeError(`GitHub answered ${res.status} for ${r.owner}/${r.repo}.`, 502, remaining, reset);
}

async function extract(body: WebReadableStream<Uint8Array>, cwd: string): Promise<void> {
  let total = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_TARBALL_BYTES) cb(new AnalyzeError("This repo is too big to read here (over 100 MB).", 413));
      else cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(body),
    limit,
    tar.x({
      cwd,
      // regular files and folders only: no symlinks, so nothing can point outside cwd
      filter: (p, entry) => {
        const e = entry as tar.ReadEntry;
        if (e.type !== "File" && e.type !== "Directory") return false;
        if ((e.size ?? 0) > MAX_FILE_BYTES) return false;
        return !SKIP_DIR.test(p);
      },
    }),
  );
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function num(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
