// Browser-safe entry: everything here runs in a browser, a server function or Node.
// Local folders need node:fs; import those from "skills-viewer/node".

export { analyze, filesToRead, VERSION, type AnalyzeOptions } from "./analyze.js";
export {
  fetchGitHubFiles,
  GitHubError,
  gunzip,
  loadGitHub,
  parseRepoInput,
  untar,
  type FetchedRepo,
  type LoadOptions,
  type RepoRef,
  type Via,
} from "./github.js";
export { toMermaid } from "./mermaid.js";
export { memoryFileSet, scopeFileSet, type FileSet } from "./vfs.js";
export type * from "./types.js";
