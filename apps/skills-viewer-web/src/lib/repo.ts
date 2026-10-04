/** A GitHub location the app can fetch: a repo, optionally a ref and a folder inside it. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** branch, tag or commit; the repo's default branch when absent */
  ref?: string;
  /** folder inside the repo to scan, without leading or trailing slashes */
  subpath?: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const isName = (s: string) => NAME.test(s) && s !== "." && s !== "..";

/**
 * Read what someone pasted: `owner/repo`, `github.com/owner/repo`, a full URL with
 * `.git`, `/tree/<ref>/<path>` or `/blob/<ref>/<path>`, or `git@github.com:owner/repo`.
 * A ref containing slashes cannot be told apart from a path, so the first segment
 * after `tree/` is the ref. Returns null when the text is not a GitHub repo.
 */
export function parseRepoInput(input: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^git@github\.com:/i, "");
  s = s.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
  if (/^[a-z]+:\/\//i.test(s)) return null; // another host
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");

  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!isName(owner) || !isName(repo)) return null;

  const out: RepoRef = { owner, repo };
  if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
    out.ref = decodeURIComponent(parts[3]);
    let rest = parts.slice(4).map(decodeURIComponent);
    // a blob link points at a file; scan the folder that holds it
    if (parts[2] === "blob" && rest.length) rest = rest.slice(0, -1);
    if (rest.some((p) => p === "." || p === "..")) return null;
    if (rest.length) out.subpath = rest.join("/");
  }
  return out;
}

/** The canonical short form, used for the `?repo=` query and cache keys. */
export function formatRepo(r: RepoRef): string {
  const base = `${r.owner}/${r.repo}`;
  if (!r.ref) return base;
  return `${base}/tree/${r.ref}${r.subpath ? `/${r.subpath}` : ""}`;
}
