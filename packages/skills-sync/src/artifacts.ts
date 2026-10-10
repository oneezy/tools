// build --artifacts: the upload archives. One ZIP per built plugin under artifacts/, holding the package under a folder
// named after the plugin; releases.json, which says what each archive is and what was last uploaded; and
// <id>.changes.md when the recorded upload holds a file the new archive lacks. artifacts/ is generated and ignored by
// git: it is never part of a check, and a build owns only the files of these three shapes inside it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDir, isLink } from "./fs.js";
import { Library } from "./library.js";
import { Report } from "./plan.js";
import { cmp, type Config, type Release } from "./sources.js";
import { zip } from "./zip.js";

/** One package as build computed it: what its archive is made from. */
export interface Built {
  id: string;
  /** the version its manifests carry, and its archive's name with them */
  version: string | null;
  versionScheme: "authored" | "upstream";
  /** where its files came from: the upstream commit for a source, the library commit it was built at for an own group; null without git */
  commit: string | null;
  /** relative path (/ separators) -> bytes, every file of the package, in the package's line endings (LF), never the checkout's */
  files: Map<string, Buffer>;
}

/** What releases.json says about one plugin. */
interface ArchiveRecord {
  /** the archive, relative to the library */
  archive: string;
  sha256: string;
  version: string | null;
  versionScheme: "authored" | "upstream";
  commit: string | null;
  /** the archive's entries: what to record as `files` of the release once it is uploaded */
  files: string[];
  /** the last upload the config records for this plugin; null when there is none */
  release: Release | null;
}

/** An archive of a plugin at any version of the rule, and a changes note: the files a build may remove from artifacts/; group 1 is the plugin id. */
const ARCHIVE_RE = /^(.+)-(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|unversioned)\.zip$/;
const CHANGES_RE = /^(.+)\.changes\.md$/;

/**
 * The actions that make artifacts/ hold this build's archives, record and notes: a write for each file that differs
 * or is missing, a delete for an older archive or a note that no longer applies, a skip for the rest. A plugin of the
 * config that could not be built this run keeps what it has there, as its package is kept under plugins/.
 */
export function archives(lib: Library, config: Config, built: Built[], report: Report): void {
  const dir = lib.artifacts;
  if (isLink(dir)) {
    report.add({ kind: "conflict", path: dir, note: "a link; build never writes through one; no archive written" });
    return;
  }
  const expected = new Map<string, Buffer>();
  const plugins: Record<string, ArchiveRecord> = {};
  for (const b of built) {
    // one folder named after the plugin: what the ChatGPT upload expects an archive to hold
    const entries = new Map([...b.files].map(([rel, bytes]) => [`${b.id}/${rel}`, bytes]));
    const bytes = zip(entries);
    const name = `${b.id}-${b.version ?? "unversioned"}.zip`;
    const release = config.releases?.[b.id] ?? null;
    const names = [...entries.keys()].sort(cmp);
    expected.set(name, bytes);
    plugins[b.id] = {
      archive: `${path.basename(dir)}/${name}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      version: b.version,
      versionScheme: b.versionScheme,
      commit: b.commit,
      files: names,
      release,
    };
    const gone = release ? lacking(b.id, release, names) : [];
    if (gone.length)
      expected.set(`${b.id}.changes.md`, Buffer.from(changesText(b.id, release!, plugins[b.id], gone), "utf8"));
  }
  expected.set("releases.json", Buffer.from(JSON.stringify({ plugins }, null, 2) + "\n", "utf8"));

  for (const [name, bytes] of expected) {
    const file = path.join(dir, name);
    const have = fs.existsSync(file) && !isDir(file) ? fs.readFileSync(file) : null;
    if (have?.equals(bytes)) report.add({ kind: "skip", path: file, note: "ok" });
    else report.add({ kind: "write", path: file, payload: bytes, note: have ? "changed" : "new" });
  }
  if (!isDir(dir)) return;
  const unbuilt = new Set(Object.keys(config.plugins).filter((id) => !built.some((b) => b.id === id)));
  for (const n of fs.readdirSync(dir).sort(cmp)) {
    if (expected.has(n) || isDir(path.join(dir, n))) continue;
    const archive = ARCHIVE_RE.exec(n);
    const note = CHANGES_RE.exec(n);
    if (unbuilt.has((archive ?? note)?.[1] ?? "")) continue;
    if (archive)
      report.add({ kind: "delete", path: path.join(dir, n), note: "an archive this build does not produce" });
    else if (note)
      report.add({
        kind: "delete",
        path: path.join(dir, n),
        note: "the recorded release holds no file the archive lacks",
      });
  }
}

/**
 * The files the recorded release names that the new archive does not hold: removed since, or renamed (the old name is
 * gone). A recorded path counts with or without the leading <id>/ folder, so a list copied from releases.json and one
 * written relative to the package both work.
 */
function lacking(id: string, release: Release, names: string[]): string[] {
  const inside = (p: string) => (p.startsWith(`${id}/`) ? p.slice(id.length + 1) : p);
  const have = new Set(names.map(inside));
  return (release.files ?? []).filter((f) => !have.has(inside(f.split("\\").join("/")))).sort(cmp);
}

/** <id>.changes.md: removed files requiring an explicitly authorized, guarded cloud update. */
function changesText(id: string, release: Release, record: ArchiveRecord, gone: string[]): string {
  return [
    `# ${id}: review removed files before updating`,
    "",
    `The recorded release \`${release.release_id}\` of plugin \`${release.plugin_id}\` (${release.date}, sha256 \`${release.sha256}\`) holds ${gone.length === 1 ? "a file" : "files"} that \`${record.archive}\` no longer has, removed or renamed since:`,
    "",
    ...gone.map((f) => `- \`${f}\``),
    "",
    "A ChatGPT plugin update overlays uploaded files. Omitted files remain unless explicitly listed in the current API’s delete_paths; omission is not deletion.",
    "",
    `Read the current files of \`${release.plugin_id}\` through Plugin Creator and retain its current release. After explicit deletion authorization, update with \`${record.archive}\`, guarded by expected_release_id, and pass only verified exact plugin-root-relative paths in delete_paths. Strip a leading \`${id}/\` archive folder where present; directories and globs are not accepted. Reconcile a changed release before retrying.`,
    "",
    "Verify the updated release and affected file inventory. If this host’s API lacks deletion, report that exact unsupported operation; do not automatically create a replacement or uninstall the existing plugin.",
    "",
    `After verified delivery, record the returned release id, sha256 and files under \`releases.${id}\` in the config, preserving plugin identity and scope.`,
    "",
  ].join("\n");
}
