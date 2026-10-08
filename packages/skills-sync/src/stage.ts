// Staging a source in a temp clone: the tip of a branch or tag, or one commit, with its history and tags (blobs fetched
// as read) so versions.ts can tell which release it is. Every clone is discarded by the caller.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommit, isoDate } from "./sources.js";

export interface Staged {
  dir: string;
  commit: string;
  date: string;
}

export type StageResult = { ok: true; staged: Staged } | { ok: false; error: string };

/**
 * Every git call checks files out byte for byte as upstream committed them (no line-ending conversion), whatever
 * this machine's core.autocrlf says: the hash recipe runs over those bytes and must give the same value on every
 * machine, or a lock written on one could never verify on another.
 */
export function git(args: string[], cwd?: string, input?: string): { ok: boolean; out: string; err: string } {
  // a whole history's patches of a manifest can pass the default 1 MB of output
  const r = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    encoding: "utf8",
    cwd,
    input,
    timeout: 120_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim().split("\n").filter(Boolean).pop() ?? "",
  };
}

/** The commit a branch or tag points at on the remote, without cloning; null when the remote or the ref is unreachable. */
export function remoteTip(url: string, ref: string): string | null {
  const r = git(["ls-remote", "--quiet", url, `refs/heads/${ref}`, `refs/tags/${ref}`]);
  if (!r.ok || !r.out) return null;
  // an annotated tag lists refs/tags/x and refs/tags/x^{}: the peeled one is the commit
  const lines = r.out.split("\n").map((l) => l.split(/\s+/));
  const peeled = lines.find((l) => l[1] === `refs/tags/${ref}^{}`);
  return (peeled ?? lines[0])[0] ?? null;
}

/** The remote's default branch (what its HEAD points at), or null. */
export function defaultBranch(url: string): string | null {
  const r = git(["ls-remote", "--symref", url, "HEAD"]);
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(r.out);
  return r.ok && m ? m[1] : null;
}

/**
 * A blobless clone at the tip of `ref` (a branch or tag), or a blobless fetch of one commit when `ref` is one, with the
 * history and tags behind it either way. A host that
 * refuses to serve a bare commit (GitHub and GitLab serve any reachable one) gets a clone of `tipOf` instead, taken
 * only when its HEAD is that commit: the tip observed a moment earlier, not whatever it has become since.
 */
export function stage(url: string, ref: string, log: (s: string) => void, tipOf?: string): StageResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-src-"));
  const fail = (error: string): StageResult => {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return { ok: false, error };
  };
  if (isCommit(ref)) {
    log(`fetching ${url} at ${ref.slice(0, 7)}`);
    for (const args of [
      ["init", "--quiet"],
      ["remote", "add", "origin", url],
      ["fetch", "--quiet", "--filter=blob:none", "--tags", "origin", ref],
      ["checkout", "--quiet", "FETCH_HEAD"],
    ]) {
      const r = git(args, dir);
      if (r.ok) continue;
      if (!tipOf) return fail(`${url}: ${r.err || `git ${args[0]} failed`}`);
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      const viaRef = stage(url, tipOf, log);
      if (!viaRef.ok) return viaRef;
      if (viaRef.staged.commit === ref) return viaRef;
      discard(viaRef.staged);
      return {
        ok: false,
        error: `${url}: ${tipOf} moved from ${ref.slice(0, 7)} to ${viaRef.staged.commit.slice(0, 7)} while refreshing; run again`,
      };
    }
  } else {
    log(`cloning ${url}@${ref}`);
    const r = git(["clone", "--quiet", "--filter=blob:none", "--single-branch", "--branch", ref, url, dir]);
    if (!r.ok) return fail(`${url}: ${r.err || "clone failed"}`);
  }
  const commit = git(["rev-parse", "HEAD"], dir);
  const date = git(["log", "-1", "--format=%cI"], dir);
  if (!commit.ok || !date.ok) return fail(`${url}: not a git checkout after staging`);
  return { ok: true, staged: { dir, commit: commit.out, date: isoDate(date.out) } };
}

/** The same checkout moved to another commit of its history (a release below the tip); null when git cannot check it out. */
export function moveTo(staged: Staged, commit: string): Staged | null {
  if (staged.commit === commit) return staged;
  if (!git(["checkout", "--quiet", commit], staged.dir).ok) return null;
  const date = git(["log", "-1", "--format=%cI"], staged.dir);
  return date.ok ? { dir: staged.dir, commit, date: isoDate(date.out) } : null;
}

export function discard(staged: Staged): void {
  fs.rmSync(staged.dir, { recursive: true, force: true, maxRetries: 3 });
}
