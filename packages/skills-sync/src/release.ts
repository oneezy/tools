// The latest release of the skills library, read from GitHub: what every machine should have. The release's
// release.json asset (schema 3, written by .github/scripts/release.mjs in oneezy/skills) names each plugin with its
// version and the sha256 of every file it carries; the skills are the files matching skills/<name>/SKILL.md. The
// library's committed skills-sync.json at the release's commit is read beside it (ADR-0012): the settings a machine
// takes from the release, which harnesses to serve and which plugins each gets, and the catalog name the library's
// build gives its marketplaces; and the library's SHARED.md at the same commit, the global block's text. Read once per
// run, passed down, never written to disk: there is no library on a machine.
import { GitHubError, type GitHub } from "./github.js";

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

/** What a machine takes from the library's skills-sync.json at the release's commit. */
export interface ReleaseConfig {
  /** the catalog name the library's build gives its two marketplaces, <owner>-<name>; null when the config names no library */
  catalog: string | null;
  /** machines.harnesses: the harness ids the machine commands serve; null for every detected one */
  harnesses: string[] | null;
  /** machines.plugins: per harness id, or "*" for the rest, the plugin ids a machine installs; a harness named nowhere gets every one */
  plugins: Record<string, string[]>;
  /**
   * the config's renderings opt-in (sources.ts's Config.renderings, the same shape): hermes is the library folder that
   * holds the Hermes rendering of every package, which Hermes's form installs from; absent when the config has none
   */
  renderings?: { hermes?: string };
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
  /** the library's skills-sync.json at `commit`; null when the commit has none (or the commit is unknown) */
  config: ReleaseConfig | null;
  /**
   * the library's SHARED.md at `commit`, the text of the global block (block.ts); null when the commit has none (an
   * older release) or the commit is unknown
   */
  shared: string | null;
  /** why SHARED.md could not be read, when GitHub failed on it (the release itself was read) */
  sharedError: string | null;
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
  const release = parseRelease(
    repo,
    tag,
    typeof latest.target_commitish === "string" ? latest.target_commitish : "",
    bytes,
  );
  release.config = await releaseConfig(gh, repo, release.commit);
  // the block's text: a failure here is the block's alone (it stays as it is); the plugins still have their release
  try {
    release.shared = await releaseFile(gh, repo, release.commit, "SHARED.md");
  } catch (error) {
    release.sharedError = `SHARED.md not read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return release;
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
  return { repo, tag: release, number, commit, tool, plugins, config: null, shared: null, sharedError: null };
}

/**
 * The library's skills-sync.json at `commit`, through the contents API (base64 in a JSON envelope); null when the
 * commit has no such file, or no commit is known. Any other failure is the release's: it propagates.
 */
export async function releaseConfig(gh: GitHub, repo: string, commit: string): Promise<ReleaseConfig | null> {
  const text = await releaseFile(gh, repo, commit, "skills-sync.json");
  return text === null ? null : parseConfig(text);
}

/**
 * A file of the library at `commit`, through the contents API (base64 in a JSON envelope), as text; null when the
 * commit has no such file, or no commit is known. Any other failure propagates.
 */
export async function releaseFile(gh: GitHub, repo: string, commit: string, file: string): Promise<string | null> {
  if (!commit) return null;
  let answer: { content?: unknown; encoding?: unknown };
  try {
    answer = await gh.getJson(`/repos/${repo}/contents/${file}?ref=${encodeURIComponent(commit)}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
  if (typeof answer?.content !== "string") return null;
  return Buffer.from(answer.content, answer.encoding === "base64" ? "base64" : "utf8").toString("utf8");
}

/**
 * The machine settings in a skills-sync.json, read leniently: a key that is not the shape expected counts as absent,
 * so an older or newer library config never stops a sync. Null when the text is not a JSON object at all.
 */
export function parseConfig(text: string): ReleaseConfig | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const c = json as {
    library?: { owner?: unknown; name?: unknown };
    machines?: { harnesses?: unknown; plugins?: unknown };
    renderings?: unknown;
  };
  const owner = typeof c.library?.owner === "string" ? c.library.owner : "";
  const name = typeof c.library?.name === "string" ? c.library.name : "";
  const ids = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : null;
  const plugins: Record<string, string[]> = {};
  if (c.machines?.plugins && typeof c.machines.plugins === "object" && !Array.isArray(c.machines.plugins))
    for (const [harness, list] of Object.entries(c.machines.plugins as Record<string, unknown>)) {
      const l = ids(list);
      if (l) plugins[harness] = l;
    }
  const config: ReleaseConfig = {
    catalog: owner && name ? `${owner}-${name}` : null,
    harnesses: ids(c.machines?.harnesses),
    plugins,
  };
  if (c.renderings && typeof c.renderings === "object" && !Array.isArray(c.renderings)) {
    const hermes = (c.renderings as { hermes?: unknown }).hermes;
    if (typeof hermes === "string" && hermes) config.renderings = { hermes };
  }
  return config;
}
