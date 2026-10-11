// The one GitHub REST client the machine commands use. Every network call goes through it, so a test stands a fake
// GitHub in with one environment variable: SKILLS_SYNC_GITHUB_API names the base URL (default https://api.github.com).
// A token comes from GITHUB_TOKEN, else GH_TOKEN, and is sent as a bearer token when present; without one the public
// release endpoints still answer, at GitHub's anonymous rate limit. Node's global fetch does the work, through
// proxy.ts's tunnel when HTTPS_PROXY (or HTTP_PROXY) applies: Node's fetch alone ignores those variables.
import { proxyFetch } from "./proxy.js";
import { VERSION } from "./version.js";

export const DEFAULT_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    /** the HTTP status, or 0 when no response came back */
    public status: number,
    public url: string,
    /** what went wrong, without the URL: "404 Not Found", "ECONNREFUSED", "not JSON" */
    public detail: string,
  ) {
    super(`${url}: ${detail}`);
    this.name = "GitHubError";
  }
}

export interface GitHub {
  /** the base URL in use, without a trailing slash */
  readonly baseUrl: string;
  /** whether a token was found in the environment (GITHUB_TOKEN, else GH_TOKEN) */
  readonly hasToken: boolean;
  /** GET a JSON resource under the base URL (`/repos/o/r/releases/latest`) */
  getJson<T = unknown>(path: string): Promise<T>;
  /**
   * GET every page of a list (`/repos/o/r/branches?per_page=100`), following the Link header's rel="next"; `signal`
   * gives up sooner than the request timeout (the hook's deadline)
   */
  getList<T = unknown>(path: string, signal?: AbortSignal): Promise<T[]>;
  /** GET a binary resource as GitHub serves release assets: octet-stream, redirects followed */
  download(path: string): Promise<Buffer>;
  /** POST a JSON body (`/repos/o/r/git/refs`) and return the JSON answer */
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  /** DELETE a resource (`/repos/o/r/git/refs/heads/<branch>`); GitHub answers 204 with no body */
  del(path: string): Promise<void>;
}

/** How long one request may take before it counts as unreachable. */
const TIMEOUT_MS = 30_000;

const JSON_ACCEPT = "application/vnd.github+json";

/** The URL GitHub's Link header names as the next page, when there is one. */
function nextPage(link: string | null): string | null {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  return m ? m[1] : null;
}

export function github(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = proxyFetch(env)): GitHub {
  const baseUrl = (env.SKILLS_SYNC_GITHUB_API?.trim() || DEFAULT_API).replace(/\/+$/, "");
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
  const headers = (accept: string, body?: string): Record<string, string> => ({
    accept,
    "user-agent": `skills-sync/${VERSION}`,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  });
  // the one place a request is made, so headers, the timeout and the error shape are the same for every call
  const request = async (
    path: string,
    accept: string,
    method = "GET",
    body?: string,
    signal?: AbortSignal,
  ): Promise<Response> => {
    const url = baseUrl + path;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: headers(accept, body),
        body,
        redirect: "follow",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
      throw new GitHubError(0, url, why);
    }
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`.trim();
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body?.message === "string") detail = `${res.status} ${body.message}`;
      } catch {
        /* no JSON body: the status line is the message */
      }
      throw new GitHubError(res.status, url, detail);
    }
    return res;
  };
  /** The body of a successful answer as JSON; anything else (an HTML page from a proxy, say) is an error, not a crash. */
  const json = async <T>(res: Response, path: string): Promise<T> => {
    try {
      return (await res.json()) as T;
    } catch {
      throw new GitHubError(res.status, baseUrl + path, "not JSON");
    }
  };
  return {
    baseUrl,
    hasToken: token !== "",
    async getJson<T>(path: string): Promise<T> {
      return json<T>(await request(path, JSON_ACCEPT), path);
    },
    async getList<T>(path: string, signal?: AbortSignal): Promise<T[]> {
      const items: T[] = [];
      let next: string | null = path;
      while (next) {
        const res = await request(next, JSON_ACCEPT, "GET", undefined, signal);
        items.push(...(await json<T[]>(res, next)));
        const link = nextPage(res.headers.get("link"));
        if (!link) break;
        // GitHub's next-page links stay on the API host; one elsewhere would carry the token to a stranger
        if (!link.startsWith(baseUrl + "/")) throw new GitHubError(0, link, `next page is not under ${baseUrl}`);
        next = link.slice(baseUrl.length);
      }
      return items;
    },
    async download(path: string): Promise<Buffer> {
      const res = await request(path, "application/octet-stream");
      return Buffer.from(await res.arrayBuffer());
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return json<T>(await request(path, JSON_ACCEPT, "POST", JSON.stringify(body)), path);
    },
    async del(path: string): Promise<void> {
      await request(path, JSON_ACCEPT, "DELETE");
    },
  };
}
