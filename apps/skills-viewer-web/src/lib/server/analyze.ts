import { GitHubError, loadGitHub, type RepoRef } from "skills-viewer";
import type { AnalyzeResult } from "../types.ts";

export class AnalyzeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimitReset?: number,
  ) {
    super(message);
  }
}

/**
 * One GitHub REST call (the tarball endpoint, which a browser cannot read) unpacked in
 * memory and mapped by the skills-viewer engine. Paths in the result are repo-relative.
 */
export async function analyzeRepo(r: RepoRef, token?: string): Promise<AnalyzeResult> {
  try {
    const graph = await loadGitHub(r, { via: "tarball", token });
    return { graph };
  } catch (err) {
    if (err instanceof GitHubError) {
      if (err.rateLimitReset !== undefined) {
        throw new AnalyzeError(
          "GitHub's hourly limit for this server is used up. Try again later.",
          429,
          err.rateLimitReset,
        );
      }
      if (err.status === 404) {
        const ref = r.ref ?? r.refPath?.[0];
        const what = ref ? `${r.owner}/${r.repo} at "${ref}"` : `${r.owner}/${r.repo}`;
        throw new AnalyzeError(
          /^no folder/.test(err.message) ? capitalize(err.message) : `Could not find ${what}. Is it public?`,
          404,
        );
      }
      throw new AnalyzeError(
        `GitHub answered ${err.status} for ${r.owner}/${r.repo}.`,
        err.status >= 500 ? 502 : err.status,
      );
    }
    throw err;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + ".";
