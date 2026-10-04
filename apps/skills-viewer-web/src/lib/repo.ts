import { parseRepoInput, type RepoRef } from "skills-viewer";

export { parseRepoInput, type RepoRef };

/**
 * The canonical short form for the `?repo=` query: `owner/repo`, `owner/repo@ref`, or
 * `github.com/owner/repo/tree/<ref and path>` when the input was a tree or blob link (the engine splits
 * ref from path itself, since a branch name can hold slashes).
 */
export function formatRepo(r: RepoRef): string {
  const base = `${r.owner}/${r.repo}`;
  if (r.refPath?.length) return `github.com/${base}/tree/${r.refPath.join("/")}`;
  return r.ref ? `${base}@${r.ref}` : base;
}
