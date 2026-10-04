import { GITHUB_TOKEN } from "$app/env/private";
import { json } from "@sveltejs/kit";
import { parseRepoInput } from "#lib/repo.ts";
import { AnalyzeError, analyzeRepo } from "#lib/server/analyze.ts";
import type { ApiError } from "#lib/types.ts";
import type { Config } from "@sveltejs/adapter-vercel";
import type { RequestHandler } from "./$types";

export const config: Config = { maxDuration: 60 };

/** GET /api/graph?repo=<owner/repo or GitHub URL> → AnalyzeResult */
export const GET: RequestHandler = async ({ url }) => {
  const input = url.searchParams.get("repo") ?? "";
  const repo = parseRepoInput(input);
  if (!repo) return fail({ error: `"${input}" is not a GitHub repo. Try owner/repo or a github.com URL.` }, 400);

  try {
    const result = await analyzeRepo(repo, GITHUB_TOKEN);
    return json(result, {
      // the CDN keeps each repo+ref for an hour, so repeat visits cost no GitHub requests
      headers: { "cache-control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (err: unknown) {
    if (err instanceof AnalyzeError) {
      return fail({ error: err.message, rateLimitReset: err.rateLimitReset }, err.status);
    }
    console.error(err);
    return fail({ error: "Something went wrong reading that repo." }, 500);
  }
};

function fail(body: ApiError, status: number) {
  return json(body, { status, headers: { "cache-control": "no-store" } });
}
