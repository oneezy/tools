import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Api } from "./types.ts";

const exec = promisify(execFile);
export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export type Command = (file: string, args: string[]) => Promise<string>;
export const command: Command = async (file, args) =>
  (await exec(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

// No auth switch, shell, token on argv, or process-global environment changes.
// Explicit CI tokens win; locally, verify gh did not fall back to the active account.
export async function authenticate(
  owner: string,
  env = process.env,
  run: Command = command,
  request = fetch,
): Promise<string> {
  const explicit = env.GH_TOKEN || env.GITHUB_TOKEN || env.PROJECT_PAT;
  let token = explicit;
  if (!token) {
    try {
      token = await run("gh", ["auth", "token", "--user", owner]);
    } catch {
      throw new Error(`Login needed: gh auth login --user ${owner} --scopes project,repo,workflow`);
    }
  }
  const api = new GitHub(token, true, request);
  const user = await api.rest<{ login: string }>("GET", "user");
  if (!explicit && user.login.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`gh returned another account's token; log in as ${owner} or supply GH_TOKEN explicitly.`);
  }
  return token;
}

export class GitHub implements Api {
  private readonly token: string;
  private readonly readOnly: boolean;
  private readonly request: typeof fetch;
  constructor(token: string, readOnly = false, request = fetch) {
    this.token = token;
    this.readOnly = readOnly;
    this.request = request;
  }
  private async send<T>(method: string, path: string, body?: unknown): Promise<{ data: T; next?: string }> {
    const response = await this.request(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "oneezy-task-manager",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // Never include authorization headers or retry uncertain mutations.
      const error = (await response.json().catch(() => ({}))) as { message?: string };
      throw new GitHubError(
        `GitHub ${method} ${path}: ${response.status} ${error.message ?? response.statusText}`,
        response.status,
      );
    }
    if (response.status === 204) return { data: undefined as T };
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    return { data: (await response.json()) as T, next };
  }
  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.readOnly && method !== "GET") throw new Error(`Read-only mode refused ${method} ${path}`);
    if (/^(?:https?:|\/)/.test(path) || path === "graphql") throw new Error("Expected a relative REST endpoint");
    return (await this.send<T>(method, path, body)).data;
  }
  async pages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let route: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    const seen = new Set<string>();
    while (route) {
      if (seen.has(route)) throw new Error(`Repeated pagination link from ${path}`);
      seen.add(route);
      const page: { data: T[]; next?: string } = await this.send<T[]>("GET", route);
      const batch: T[] = page.data;
      if (!Array.isArray(batch)) throw new Error(`Expected a list from ${path}`);
      results.push(...batch);
      if (page.next) {
        const url: URL = new URL(page.next);
        if (url.origin !== "https://api.github.com") throw new Error("Unexpected pagination host");
        route = url.pathname.slice(1) + url.search;
      } else route = undefined;
    }
    return results;
  }
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (this.readOnly && !/^\s*query\b/.test(query)) throw new Error("Read-only mode refused GraphQL mutation");
    const { data: response } = await this.send<{ data: T; errors?: { message: string }[] }>("POST", "graphql", {
      query,
      variables,
    });
    if (response.errors?.length)
      throw new Error(`GitHub Projects: ${response.errors.map((e) => e.message).join("; ")}`);
    return response.data;
  }
}

export async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}
