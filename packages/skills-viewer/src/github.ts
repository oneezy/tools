// GitHub as a source, without git: a web app cannot clone. Browser-safe (fetch, DecompressionStream).
//
// Two ways in, each one GitHub API request (60/hour unauthenticated):
// - "tree": git/trees/<ref>?recursive=1, then raw.githubusercontent.com for only the files the
//   analyzer reads. Both hosts send Access-Control-Allow-Origin: *, so this works from a browser.
// - "tarball": repos/<o>/<r>/tarball/<ref>. The redirect target, codeload.github.com, only allows
//   render.githubusercontent.com as an origin, so use this from Node or a server function.

import { analyze, filesToRead } from "./analyze.js";
import type { Graph, Source } from "./types.js";
import { dirname, memoryFileSet, scopeFileSet, trimSlashes, type FileSet } from "./vfs.js";

export interface RepoRef {
  owner: string;
  repo: string;
  /** branch, tag or sha; undefined means the default branch */
  ref?: string;
  /** folder inside the repo */
  subpath?: string;
  /** segments after /tree/ or /blob/: the ref and the path, not yet split (a branch name can hold slashes) */
  refPath?: string[];
}

export type Via = "tree" | "tarball";

export interface LoadOptions {
  /** default "tree" */
  via?: Via;
  /** a GitHub token, for private repos and 5000 requests/hour; keep it server-side */
  token?: string;
  /** injectable for tests and proxies */
  fetch?: typeof fetch;
  /** parallel raw file downloads in tree mode (default 16) */
  concurrency?: number;
  /** API origin (default https://api.github.com) */
  apiBase?: string;
  /** raw file origin (default https://raw.githubusercontent.com) */
  rawBase?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** set when the API rate limit is spent; unix seconds when it resets */
    readonly rateLimitReset?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REPO = /^[A-Za-z0-9_.-]+$/;

/**
 * Read `owner/repo` or a GitHub URL: https://github.com/o/r, github.com/o/r.git, git@github.com:o/r.git,
 * https://github.com/o/r/tree/<ref>/<path>, https://github.com/o/r/blob/<ref>/<path>/SKILL.md.
 * Returns null for anything else (a local path, another host).
 */
export function parseRepoInput(input: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  const ssh = /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) return valid({ owner: ssh[1], repo: ssh[2] });
  s = s.replace(/[?#].*$/, "");
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(s);
  if (url) {
    const segs = url[1].split("/").filter(Boolean);
    if (segs.length < 2) return null;
    const [owner, rawRepo, kind, ...rest] = segs;
    const repo = rawRepo.replace(/\.git$/, "");
    if ((kind === "tree" || kind === "blob") && rest.length)
      return valid({ owner, repo, refPath: rest.map(decodeURIComponent) });
    return valid({ owner, repo });
  }
  // owner/repo, optionally owner/repo@ref
  const short = /^([^/\s@]+)\/([^/\s@]+?)(?:\.git)?(?:@([^\s]+))?$/.exec(s);
  if (short) return valid({ owner: short[1], repo: short[2], ...(short[3] ? { ref: short[3] } : {}) });
  return null;
}

function valid(r: RepoRef): RepoRef | null {
  return OWNER.test(r.owner) && REPO.test(r.repo) && r.repo !== "." && r.repo !== ".." ? r : null;
}

/** Fetch a repo's files and map it. `input` is anything parseRepoInput accepts, or a RepoRef. */
export async function loadGitHub(input: string | RepoRef, opts: LoadOptions = {}): Promise<Graph> {
  const { files, source, warnings } = await fetchGitHubFiles(input, opts);
  const graph = analyze(files, { source });
  graph.meta.warnings.unshift(...warnings);
  return graph;
}

export interface FetchedRepo {
  /** already scoped to the subpath */
  files: FileSet;
  source: Extract<Source, { kind: "github" }>;
  warnings: string[];
}

export async function fetchGitHubFiles(input: string | RepoRef, opts: LoadOptions = {}): Promise<FetchedRepo> {
  const ref = typeof input === "string" ? parseRepoInput(input) : input;
  if (!ref) throw new GitHubError(`not a GitHub repo: ${String(input)} (use owner/repo or a github.com URL)`, 400);
  const via = opts.via ?? "tree";
  const candidates = refCandidates(ref);
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      const got = via === "tarball" ? await viaTarball(ref, c.ref, opts) : await viaTree(ref, c.ref, c.subpath, opts);
      const subpath = resolveSubpath(got.files.paths, c.subpath);
      if (subpath && !got.files.paths.some((p) => p.startsWith(subpath + "/")))
        throw new GitHubError(`no folder ${subpath} in ${ref.owner}/${ref.repo}@${c.ref}`, 404);
      const at = got.sha ?? c.ref;
      const source: FetchedRepo["source"] = {
        kind: "github",
        owner: ref.owner,
        repo: ref.repo,
        ref: c.ref,
        ...(got.sha ? { sha: got.sha } : {}),
        ...(subpath ? { subpath } : {}),
        url: `https://github.com/${ref.owner}/${ref.repo}`,
        blobBase: `https://github.com/${ref.owner}/${ref.repo}/blob/${encodePath(at)}/`,
        via,
      };
      return { files: scopeFileSet(got.files, subpath), source, warnings: got.warnings };
    } catch (e) {
      lastErr = e;
      // only a missing ref is worth retrying with a longer branch name
      if (!(e instanceof GitHubError && e.status === 404 && candidates.length > 1)) throw e;
    }
  }
  throw lastErr;
}

/** A blob URL to a file maps the folder holding it. */
function resolveSubpath(paths: string[], subpath?: string): string {
  const s = trimSlashes(subpath ?? "");
  return s && paths.includes(s) ? dirname(s) : s;
}

/** "/tree/feat/x/skills" may be branch "feat" + path "x/skills" or branch "feat/x" + path "skills". */
function refCandidates(r: RepoRef): Array<{ ref: string; subpath?: string }> {
  if (!r.refPath) return [{ ref: r.ref ?? "HEAD", subpath: r.subpath }];
  const out: Array<{ ref: string; subpath?: string }> = [];
  for (let i = 1; i <= Math.min(r.refPath.length, 4); i++)
    out.push({ ref: r.refPath.slice(0, i).join("/"), subpath: r.refPath.slice(i).join("/") });
  return out;
}

interface Got {
  files: FileSet;
  sha?: string;
  warnings: string[];
}

async function viaTree(r: RepoRef, ref: string, subpath: string | undefined, opts: LoadOptions): Promise<Got> {
  const f = opts.fetch ?? fetch;
  const api = opts.apiBase ?? "https://api.github.com";
  const raw = opts.rawBase ?? "https://raw.githubusercontent.com";
  const res = await f(`${api}/repos/${r.owner}/${r.repo}/git/trees/${encodePath(ref)}?recursive=1`, {
    headers: apiHeaders(opts.token),
  });
  await check(res, r, ref);
  const json = (await res.json()) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
  const paths = (json.tree ?? []).filter((e) => e.type === "blob").map((e) => e.path);
  const warnings = json.truncated
    ? [
        `GitHub truncated the file list of ${r.owner}/${r.repo} (over 100,000 entries or 7 MB); some skills may be missing`,
      ]
    : [];
  const files = new Map<string, string>();
  const failed = new Set<string>();
  // a file that would not load reads as empty while planning, so the next round does not ask for it again
  const planRead = (p: string) => files.get(p) ?? (failed.has(p) ? "" : undefined);
  // only download what the scoped map will read
  const scoped = scopeFileSet({ paths, read: planRead }, resolveSubpath(paths, subpath)).paths;
  const rawUrl = (p: string) => `${raw}/${r.owner}/${r.repo}/${encodePath(ref)}/${encodePath(p)}`;
  for (let round = 0; round < 4; round++) {
    const want = filesToRead(scoped, planRead);
    if (!want.length) break;
    await pool(want, opts.concurrency ?? 16, async (p) => {
      let rr = await f(rawUrl(p), opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined);
      // raw answers 404 to a token it does not accept, even for a public repo
      if (!rr.ok && opts.token) rr = await f(rawUrl(p));
      if (rr.ok) files.set(p, await rr.text());
      else {
        failed.add(p);
        warnings.push(`${p}: raw download failed (${rr.status})`);
      }
    });
  }
  return { files: memoryFileSet(files, paths), warnings };
}

async function viaTarball(r: RepoRef, ref: string, opts: LoadOptions): Promise<Got> {
  const f = opts.fetch ?? fetch;
  const api = opts.apiBase ?? "https://api.github.com";
  const res = await f(`${api}/repos/${r.owner}/${r.repo}/tarball/${encodePath(ref)}`, {
    headers: apiHeaders(opts.token),
    redirect: "follow",
  });
  await check(res, r, ref);
  const gz = new Uint8Array(await res.arrayBuffer());
  const entries = untar(await gunzip(gz));
  const bytes = new Map<string, Uint8Array>();
  let top: string | undefined;
  let sha = entries.globalComment && /^[0-9a-f]{40}$/.test(entries.globalComment) ? entries.globalComment : undefined;
  for (const e of entries.files) {
    const i = e.path.indexOf("/");
    if (i < 0) continue;
    top ??= e.path.slice(0, i);
    bytes.set(e.path.slice(i + 1), e.data);
  }
  if (!sha && top) sha = /-([0-9a-f]{7,40})$/.exec(top)?.[1];
  const decoder = new TextDecoder();
  const cache = new Map<string, string>();
  const files: FileSet = {
    paths: [...bytes.keys()].sort(),
    read(p) {
      if (!cache.has(p)) {
        const b = bytes.get(p);
        if (!b) return undefined;
        cache.set(p, decoder.decode(b));
      }
      return cache.get(p);
    },
  };
  return { files, sha, warnings: [] };
}

function apiHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function check(res: Response, r: RepoRef, ref: string): Promise<void> {
  if (res.ok) return;
  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = Number(res.headers.get("x-ratelimit-reset")) || undefined;
  if ((res.status === 403 || res.status === 429) && remaining === "0") {
    const when = reset ? new Date(reset * 1000).toISOString() : "later";
    throw new GitHubError(
      `GitHub rate limit reached (60 requests/hour without a token); resets at ${when}`,
      res.status,
      reset,
    );
  }
  if (res.status === 404 || res.status === 422)
    throw new GitHubError(`${r.owner}/${r.repo}@${ref} not found (or private)`, 404);
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    /* no body */
  }
  throw new GitHubError(
    `GitHub answered ${res.status} for ${r.owner}/${r.repo}@${ref}${detail ? `: ${detail}` : ""}`,
    res.status,
  );
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/* ---------- tar.gz ---------- */

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface TarEntries {
  files: Array<{ path: string; data: Uint8Array }>;
  /** the pax global header comment; git archive puts the commit sha there */
  globalComment?: string;
}

/** Regular files from a ustar/pax/GNU tar. Directories, links and devices are skipped. */
export function untar(buf: Uint8Array): TarEntries {
  const out: TarEntries = { files: [] };
  const dec = new TextDecoder();
  const cstr = (b: Uint8Array) => {
    const z = b.indexOf(0);
    return dec.decode(z < 0 ? b : b.subarray(0, z));
  };
  let pax: Record<string, string> = {};
  let longName: string | undefined;
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const name = cstr(h.subarray(0, 100));
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const ustar = cstr(h.subarray(257, 263)).startsWith("ustar");
    const prefix = ustar ? cstr(h.subarray(345, 500)) : "";
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = parsePax(dec.decode(data));
      continue;
    }
    if (type === "g") {
      const g = parsePax(dec.decode(data));
      if (g.comment) out.globalComment = g.comment.trim();
      continue;
    }
    if (type === "L") {
      longName = cstr(data);
      continue;
    }
    const path = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    pax = {};
    longName = undefined;
    if (type === "0" || type === "7") out.files.push({ path, data });
  }
  return out;
}

function parsePax(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\d+ ([^=]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
