// What a "library copy" is (ADR-0007): the only link a form removes from a user skills folder is one the tool made, and
// what the tool linked points into a copy of the library: a checkout or clone of the release repository (a
// skills-sync.json whose library.owner and library.name name that repository, at some ancestor of the target), or
// ~/.skills-sync, the link the old tool left to one. A link whose target is gone is the tool's leftover too. A link to
// anywhere else was made by someone else and stays, reported.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { real, under } from "../fs.js";
import { homeLibrary } from "../library.js";

/** Is `target` (a link's target, resolved absolute) inside a copy of the library `repo` (owner/repo)? */
export function isLibraryCopy(target: string, repo: string, home = os.homedir()): boolean {
  const old = homeLibrary(home);
  if (under(target, old) || under(real(target), real(old))) return true;
  for (const start of [path.resolve(target), real(target)]) {
    let dir = start;
    for (;;) {
      if (namesLibrary(path.join(dir, "skills-sync.json"), repo)) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return false;
}

/** A link whose target no longer exists: nothing it could still serve. */
export function dangling(target: string): boolean {
  return !fs.existsSync(target);
}

/** Does this skills-sync.json declare the library `repo`? */
function namesLibrary(file: string, repo: string): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as { library?: { owner?: unknown; name?: unknown } };
    const lib = v?.library;
    return (
      typeof lib?.owner === "string" &&
      typeof lib?.name === "string" &&
      `${lib.owner}/${lib.name}`.toLowerCase() === repo.toLowerCase()
    );
  } catch {
    return false;
  }
}
