// The latest release of the skills library, read from GitHub: what every machine should have. The release's
// release.json asset (schema 3, written by .github/scripts/release.mjs in oneezy/skills) names each plugin with its
// version and the sha256 of every file it carries; the skills are the files matching skills/<name>/SKILL.md. Read once
// per run, passed down, never written to disk: there is no library on a machine.
import type { GitHub } from "./github.js";

export const DEFAULT_REPO = "oneezy/skills";

export interface ReleasePlugin {
  id: string;
  /** the plugin's version; null for an unversioned source */
  version: string | null;
  /** the skill folder names the plugin carries, sorted */
  skills: string[];
  /** path -> sha256, every file in the plugin */
  files: Record<string, string>;
}

export interface Release {
  repo: string;
  /** release-17 */
  tag: string;
  number: number;
  /** the library commit the release was cut from */
  commit: string;
  /** the @oneezy/skills-sync version the release was built with (release-18 on); null before, or when unversioned */
  tool: string | null;
  plugins: Record<string, ReleasePlugin>;
}

interface GitHubRelease {
  tag_name?: unknown;
  target_commitish?: unknown;
  assets?: unknown;
}

interface ReleaseJson {
  schema?: unknown;
  release?: unknown;
  number?: unknown;
  source?: { commit?: unknown };
  /** release-17 and before: { repo, package, commit }; release-18 on: { repo, package, version } */
  tool?: { version?: unknown };
  plugins?: unknown;
}

const SKILL_FILE = /^skills\/([^/]+)\/SKILL\.md$/;

/** `owner/repo`, the only form a release repo takes. */
export function isRepoName(value: string): boolean {
  return /^[\w.-]+\/[\w.-]+$/.test(value);
}

export async function latestRelease(gh: GitHub, repo = DEFAULT_REPO): Promise<Release> {
  const latest = await gh.getJson<GitHubRelease>(`/repos/${repo}/releases/latest`);
  const tag = typeof latest.tag_name === "string" ? latest.tag_name : "";
  const assets = Array.isArray(latest.assets) ? (latest.assets as Array<{ id?: unknown; name?: unknown }>) : [];
  const asset = assets.find((a) => a?.name === "release.json");
  if (!asset || typeof asset.id !== "number")
    throw new Error(`${repo} ${tag || "latest release"}: no release.json asset`);
  const bytes = await gh.download(`/repos/${repo}/releases/assets/${asset.id}`);
  return parseRelease(repo, tag, typeof latest.target_commitish === "string" ? latest.target_commitish : "", bytes);
}

/** release.json as the library's release script writes it, into the plugins a machine is compared with. */
export function parseRelease(repo: string, tag: string, fallbackCommit: string, bytes: Buffer): Release {
  let json: ReleaseJson;
  try {
    json = JSON.parse(bytes.toString("utf8")) as ReleaseJson;
  } catch {
    throw new Error(`${repo} ${tag}: release.json is not JSON`);
  }
  if (!json || typeof json !== "object" || !json.plugins || typeof json.plugins !== "object") {
    const schema = typeof json?.schema === "number" || typeof json?.schema === "string" ? json.schema : "?";
    throw new Error(`${repo} ${tag}: release.json has no plugins (schema ${schema})`);
  }
  const release = typeof json.release === "string" && json.release ? json.release : tag;
  const number =
    typeof json.number === "number" ? json.number : Number(/^release-(\d+)$/.exec(release)?.[1] ?? Number.NaN);
  const commit = typeof json.source?.commit === "string" ? json.source.commit : fallbackCommit;
  const plugins: Record<string, ReleasePlugin> = {};
  for (const [id, p] of Object.entries(json.plugins as Record<string, { version?: unknown; files?: unknown }>)) {
    const files: Record<string, string> = {};
    if (p?.files && typeof p.files === "object")
      for (const [file, sha] of Object.entries(p.files as Record<string, unknown>))
        if (typeof sha === "string") files[file] = sha;
    plugins[id] = {
      id,
      version: typeof p?.version === "string" && p.version ? p.version : null,
      skills: Object.keys(files)
        .map((f) => SKILL_FILE.exec(f)?.[1])
        .filter((s): s is string => !!s)
        .sort(),
      files,
    };
  }
  const tool = typeof json.tool?.version === "string" && json.tool.version ? json.tool.version : null;
  return { repo, tag: release, number, commit, tool, plugins };
}
