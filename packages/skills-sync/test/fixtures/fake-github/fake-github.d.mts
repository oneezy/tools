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

export interface Fixture {
  repo: string;
  releases: FixtureRelease[];
  /** GET /repos/:o/:r/contents/:path?ref=<ref>: ref -> path -> text */
  contents?: Record<string, Record<string, string>>;
  /** when set, the only bearer token accepted */
  token?: string;
}

export interface RecordedRequest {
  method: string;
  /** the path with its query string, as the client sent it */
  path: string;
  headers: { accept?: string; authorization?: string; "user-agent"?: string };
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

export function startFakeGithub(fixture?: Fixture): Promise<FakeGithub>;
