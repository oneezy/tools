// What a source's upstream CHANGELOG.md says about a move between two versions: the whole sections whose version
// heading (`## 1.3.0`, `## [1.3.0] - date`, `## v1.3.0`, matched as plain semver) lies above the lower version and at or
// below the higher one, read at the higher side's commit from the nearest CHANGELOG.md at or above the source's root.
// A downgrade gets the same range, as the one it undoes. Null with the reason when there is nothing honest to show.
import { git } from "./stage.js";
import { compareVersions, manifestDirs, plainVersion } from "./versions.js";

/** A source's place upstream: its version (null when it has none), its commit, and how many commits past that version it is (null when not known). */
export interface Position {
  version: string | null;
  commit: string;
  ahead: number | null;
}

/** One source an update moved, as the report gives it: the changelog range it brings (upgrade) or undoes (downgrade), or null and why. */
export interface Moved {
  id: string;
  from: Position | null;
  to: Position;
  direction: "upgrade" | "downgrade";
  changelog: string | null;
  changelogReason?: string;
}

export const CHANGELOG = "CHANGELOG.md";

/** The report entry for a source moved from `from` to `to`, its changelog read in `dir` (a checkout with the history of both sides; null when there is none). */
export function moved(id: string, from: Position | null, to: Position, dir: string | null, root: string | undefined): Moved {
  const direction = directionOf(from, to, dir);
  const none = (changelogReason: string): Moved => ({ id, from, to, direction, changelog: null, changelogReason });
  if (!from) return none("new to the lock: no version to compare with");
  if (from.version === null || to.version === null) return none(`no upstream version for ${(from.version === null ? from : to).commit.slice(0, 7)}`);
  if (from.version === to.version) return none(`no release between them (both ${to.version})`);
  const [low, high] = direction === "upgrade" ? [from, to] : [to, from];
  if (!dir || !git(["cat-file", "-e", `${high.commit}^{commit}`], dir).ok) return none(`${high.commit.slice(0, 7)} is not in the checkout`);
  let text: string | null = null;
  for (const d of manifestDirs(root)) {
    const r = git(["show", `${high.commit}:${d ? `${d}/` : ""}${CHANGELOG}`], dir);
    if (r.ok) {
      text = r.out;
      break;
    }
  }
  if (text === null) return none(`no ${CHANGELOG} upstream`);
  const sections = sectionsOf(text);
  for (const v of [high.version!, low.version!]) if (!sections.some((s) => s.version === v)) return none(`${CHANGELOG} has no heading for ${v}`);
  const range = sections.filter((s) => compareVersions(s.version, low.version!) > 0 && compareVersions(s.version, high.version!) <= 0);
  return { id, from, to, direction, changelog: range.map((s) => s.text).join("\n") };
}

/** A downgrade when the new version is lower, or, with no versions to tell, when the new commit is behind the old one; else an upgrade. */
function directionOf(from: Position | null, to: Position, dir: string | null): Moved["direction"] {
  if (!from) return "upgrade";
  if (from.version !== null && to.version !== null && from.version !== to.version) return compareVersions(to.version, from.version) < 0 ? "downgrade" : "upgrade";
  return dir && git(["merge-base", "--is-ancestor", to.commit, from.commit], dir).ok ? "downgrade" : "upgrade";
}

/** The version sections of a changelog in file order: each from its heading up to the next heading of its level or above, trailing blank lines dropped. */
function sectionsOf(text: string): Array<{ version: string; text: string }> {
  const out: Array<{ version: string; text: string }> = [];
  let open: { version: string; level: number; lines: string[] } | null = null;
  const close = () => {
    if (!open) return;
    while (open.lines.length && !open.lines[open.lines.length - 1].trim()) open.lines.pop();
    out.push({ version: open.version, text: open.lines.join("\n") + "\n" });
    open = null;
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h && open && h[1].length <= open.level) close();
    const version: string | null = h && !open ? headingVersion(h[2]) : null;
    if (version) open = { version, level: h![1].length, lines: [line] };
    else if (open) open.lines.push(line);
  }
  close();
  return out;
}

/** The version a heading names by its first word: `1.3.0`, `v1.3.0`, `[1.3.0] - date`, `[1.3.0](link)`, `name@1.3.0`; null for any other heading. */
function headingVersion(title: string): string | null {
  const m = /^\[?([^\]\s()]+)/.exec(title.trim());
  return m ? plainVersion(m[1]) : null;
}
