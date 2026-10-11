// The one GitHub REST client the machine commands use. Every network call goes through it, so a test stands a fake
// GitHub in with one environment variable: SKILLS_SYNC_GITHUB_API names the base URL (default https://api.github.com).
// A token comes from GITHUB_TOKEN, else GH_TOKEN, and is sent as a bearer token when present; without one the public
// release endpoints still answer, at GitHub's anonymous rate limit. Node's global fetch does the work.
import { VERSION } from "./version.js";

export const DEFAULT_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    /** the HTTP status, or 0 when no response came back */
    public status: number,
    public url: string,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHub {
  /** the base URL in use, without a trailing slash */
  readonly baseUrl: string;
  /** GET a JSON resource under the base URL (`/repos/o/r/releases/latest`) */
  getJson<T = unknown>(path: string): Promise<T>;
  /** GET a binary resource as GitHub serves release assets: octet-stream, redirects followed */
  download(path: string): Promise<Buffer>;
}

/** How long one request may take before it counts as unreachable. */
const TIMEOUT_MS = 30_000;

export function github(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): GitHub {
  const baseUrl = (env.SKILLS_SYNC_GITHUB_API?.trim() || DEFAULT_API).replace(/\/+$/, "");
  const token = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || "";
  const headers = (accept: string): Record<string, string> => ({
    accept,
    "user-agent": `skills-sync/${VERSION}`,
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  const request = async (path: string, accept: string): Promise<Response> => {
    const url = baseUrl + path;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: headers(accept),
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const why = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
      throw new GitHubError(0, url, `${url}: ${why}`);
    }
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`.trim();
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body?.message === "string") detail = `${res.status} ${body.message}`;
      } catch {
        /* no JSON body: the status line is the message */
      }
      throw new GitHubError(res.status, url, `${url}: ${detail}`);
    }
    return res;
  };
  return {
    baseUrl,
    async getJson<T>(path: string): Promise<T> {
      const res = await request(path, "application/vnd.github+json");
      return (await res.json()) as T;
    },
    async download(path: string): Promise<Buffer> {
      const res = await request(path, "application/octet-stream");
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
