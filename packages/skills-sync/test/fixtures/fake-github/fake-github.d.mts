// Types for fake-github.mjs, so the TypeScript tests import it with its shapes.

export interface FixturePlugin {
  /** a string, or null for an unversioned source */
  version?: string | null;
  skills: string[];
  /** extra files, path -> text */
  files?: Record<string, string>;
  versionScheme?: "authored" | "upstream";
}

export interface ReleaseJsonPlugin {
  version: string | null;
  versionScheme: string;
  commit: string;
  archive: string;
  sha256: string;
  content: string;
  files: Record<string, string>;
}

export interface ReleaseJson {
  schema: 3;
  release: string;
  number: number;
  previous: string | null;
  source: { repo: string; commit: string; tree: string };
  /** release-17 and before carry the tool's commit; release-18 on its npm version (or null) */
  tool: { repo: string; package: string; commit: string } | { repo: string; package: string; version: string | null };
  digests: Record<string, string>;
  content: string;
  changes: { added: string[]; changed: string[]; removed: string[] };
  plugins: Record<string, ReleaseJsonPlugin>;
}

export interface FixtureRelease {
  tag: string;
  number: number;
  commit: string;
  json: ReleaseJson;
  /** per plugin, the bytes of each file, so a test can lay the same plugin down on the pretend machine */
  plugins: Record<string, { files: Map<string, Buffer> }>;
  /** cut without a release.json asset */
  noReleaseJson?: boolean;
}

export interface FixtureBranch {
  sha: string;
  protected?: boolean;
  /** what compare dev...<branch> answers as ahead_by (default: 0 when the sha is dev's, else 1) */
  ahead?: number;
  /** the sha GET /git/ref/heads/<branch> answers while the listing still says `sha`: a push between the two */
  movedTo?: string;
}

export interface FixturePull {
  number: number;
  /** the head branch name */
  head: string;
  /** the base branch name (default: dev) */
  base?: string;
  /** default: "closed" when merged, else "open" */
  state?: "open" | "closed";
  merged?: boolean;
  /** the head sha the pull request records (default: the head branch's current sha) */
  sha?: string;
  title?: string;
}

/** A repository `branches` works on. The server mutates `branches` and `tags` as writes come in. */
export interface FixtureRepo {
  branches: Record<string, FixtureBranch>;
  pulls?: FixturePull[];
  /** "archive/<name>" -> sha */
  tags?: Record<string, string>;
  /** false: every write answers 403 */
  writable?: boolean;
  /** listed as archived by GET /user/repos and GET /repos/:o/:r */
  archived?: boolean;
  /** GET /repos/:o/:r default_branch (default: main) */
  defaultBranch?: string;
}

export interface Fixture {
  /** the one repository with releases */
  repo: string;
  releases: FixtureRelease[];
  /** GET /repos/:o/:r/contents/:path?ref=<ref>: ref -> path -> text */
  contents?: Record<string, Record<string, string>>;
  /** the repositories `branches` works on, "owner/name" -> state */
  repos?: Record<string, FixtureRepo>;
  /** when set, the only bearer token accepted */
  token?: string;
  /** when set, lists come in pages of at most this many items, so the client has to turn pages */
  pageSize?: number;
  /** path (without its query) -> the error status every request for it is answered with */
  failures?: Record<string, number>;
}

export interface RecordedRequest {
  method: string;
  /** the path with its query string, as the client sent it */
  path: string;
  headers: { accept?: string; authorization?: string; "user-agent"?: string };
  /** the JSON body of a write; null for a GET or a body that is not JSON */
  body: unknown;
}

export interface FakeGithub {
  /** the base URL for SKILLS_SYNC_GITHUB_API */
  url: string;
  requests: RecordedRequest[];
  fixture: Fixture;
  addRelease(release: FixtureRelease): void;
  close(): Promise<void>;
}

export function fixtureRelease(options: {
  repo?: string;
  number: number;
  previous?: string | null;
  commit: string;
  plugins: Record<string, FixturePlugin>;
  /** release-18 on: tool.version; undefined keeps the older tool.commit shape */
  toolVersion?: string | null;
}): FixtureRelease;

export function fixtureLibrary(repo?: string): Fixture;

/**
 * The library's committed skills-sync.json as the release's commit carries it, in the real file's shape, with
 * `version` as library.version and `extra` merged in (a `machines` key, say). Returns the file's text.
 */
export function fixtureConfig(repo?: string, version?: string, extra?: Record<string, unknown>): string;

/** A 40-character commit sha a test can read: the seed repeated. */
export function sha(seed: string): string;

export function startFakeGithub(fixture?: Fixture): Promise<FakeGithub>;
