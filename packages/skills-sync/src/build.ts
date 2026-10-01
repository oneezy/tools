// build: the plugin form, written into the library from skills-sync.json. One package per plugin under plugins/<id>/
// (an own group's skills, or a source's working-set copies), with the three host manifests, LICENSE and NOTICE.md; and
// the two root catalogs that point at ./plugins/<id>. Every output is computed in memory first and compared with disk,
// so a build with nothing new is silent and --check is the same computation that writes nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cmp, githubSlug, lockSource, readConfig, selection, type Config, type Plugin, type Source } from "./sources.js";

export interface BuildOptions {
  /** write plugins/<id>/ for every plugin in the config */
  plugins: boolean;
  /** write the two root marketplace catalogs */
  catalogs: boolean;
  /** compute every output, report what differs from disk, write nothing */
  check: boolean;
  plan: boolean;
  log: (s: string) => void;
}

export interface BuildResult {
  report: Report;
  /** 0.<commit count>.0+<sha12> of the library's HEAD, what every package built this run carries */
  version: string;
  /** --check: every path that differs from what the build would write, relative to the library, / separators */
  drift: string[];
  /** generate.plugins is false: nothing built, nothing checked */
  off: boolean;
}

/** The library's HEAD: its version by the rule 0.<commit count>.0+<sha12>, and the commit itself for the NOTICE of an own package. */
export interface Head {
  version: string;
  commit: string | null;
  date: string | null;
}

/** The Agent Plugins 1.0 schema the portable manifest declares. */
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** What the ChatGPT interface and the Codex catalog say every package is; the hosts enumerate neither value in their docs. */
const CATEGORY = "Developer Tools";
const CAPABILITIES = ["Interactive"];
const VERSION_RE = /^0\.\d+\.0\+(?:[0-9a-f]{12,}|nogit)$/;

/** A library without git gets 0.0.0+nogit and no commit. */
export function libraryHead(root: string): Head {
  const git = (...args: string[]): string | null => {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const count = git("rev-list", "--count", "HEAD");
  const short = git("rev-parse", "--short=12", "HEAD");
  if (!count || !short) return { version: "0.0.0+nogit", commit: null, date: null };
  return { version: `0.${count}.0+${short}`, commit: git("rev-parse", "HEAD"), date: git("log", "-1", "--format=%cI") };
}

/** Where a package's skills came from, for its NOTICE. */
type Origin = { kind: "own"; group: string } | { kind: "source"; id: string; src: Source; commit: string; date: string; perSkill: Record<string, string> };

/** One package, resolved: its skills with every transform applied, its license, its origin. */
interface Package {
  id: string;
  plugin: Plugin;
  /** skill name -> relative path -> bytes */
  skills: Map<string, Map<string, Buffer>>;
  license: Buffer | null;
  spdx: string | null;
  origin: Origin;
}

export function build(lib: Library, opts: BuildOptions): BuildResult {
  const config = readConfig(lib.configFile);
  const report = new Report();
  const head = libraryHead(lib.root);
  const result: BuildResult = { report, version: head.version, drift: [], off: !config.generate.plugins };
  if (result.off) return result;
  const changes = new Report(); // what differs from disk, applied unless checking
  if (opts.plugins) {
    const ids = Object.keys(config.plugins);
    for (const id of ids) {
      const pkg = resolvePackage(lib, config, id, report);
      if (!pkg) continue;
      const dir = path.join(lib.plugins, id);
      const disk = diskFiles(dir);
      // a package whose files are unchanged keeps the version and commit it was built with: the HEAD moves with every
      // commit of the library, and a rebuild after one must not rewrite packages whose inputs did not change
      const prior = priorHead(disk, head);
      const unchanged = sameFiles(disk, render(pkg, config, prior));
      reconcile(changes, dir, disk, unchanged ? render(pkg, config, prior) : render(pkg, config, head), opts.check);
    }
    // packages for ids no longer in the config
    if (isDir(lib.plugins)) {
      for (const n of fs.readdirSync(lib.plugins).sort(cmp)) if (!n.startsWith(".") && !ids.includes(n) && isDir(path.join(lib.plugins, n))) changes.add({ kind: "delete", path: path.join(lib.plugins, n), note: "no longer in skills-sync.json" });
    }
  }
  if (opts.catalogs) {
    const files = catalogs(config, lib);
    for (const [file, bytes] of files) {
      const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (have && have.equals(bytes)) changes.add({ kind: "skip", path: file, note: "ok" });
      else changes.add({ kind: "write", path: file, payload: bytes, note: have ? "changed" : "new" });
    }
  }
  report.merge(changes);
  if (opts.check) result.drift = changes.changes().map((a) => path.relative(lib.root, a.path).split("\\").join("/"));
  else apply(changes, opts.plan);
  return result;
}

/** The plugin's skills, license and origin; null (reported) when the config names a group or source that yields nothing. */
function resolvePackage(lib: Library, config: Config, id: string, report: Report): Package | null {
  const plugin = config.plugins[id];
  const where = path.join(lib.plugins, id);
  if (plugin.group) {
    const own = lib.scanOwn().skills.filter((s) => s.plugin === plugin.group);
    if (!own.length) {
      report.add({ kind: "conflict", path: where, note: `no own skills under skills/${plugin.group}; package not built` });
      return null;
    }
    const skills = new Map<string, Map<string, Buffer>>();
    for (const s of own) skills.set(s.name, internalCopy(folderFiles(s.dir)));
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((n) => path.join(lib.root, n)).find((f) => fs.existsSync(f));
    if (!licenseFile) report.add({ kind: "note", path: where, note: "no LICENSE in the library; the package carries none" });
    const license = licenseFile ? fs.readFileSync(licenseFile) : null;
    return { id, plugin, skills, license, spdx: license ? spdx(license.toString("utf8")) : null, origin: { kind: "own", group: plugin.group } };
  }
  const src = config.sources[plugin.source!];
  if (!src) {
    report.add({ kind: "conflict", path: where, note: `source ${plugin.source} is not in skills-sync.json; package not built` });
    return null;
  }
  const snapDir = path.join(lib.upstream, plugin.source!);
  const meta = readSnapshot(snapDir);
  if (!meta) {
    report.add({ kind: "conflict", path: where, note: `no snapshot under upstream/${plugin.source}; run refresh first; package not built` });
    return null;
  }
  // the working-set copies of this source's selected skills, renames applied; the lock says which copy is this source's
  const lock = lib.lockEntries();
  const skills = new Map<string, Map<string, Buffer>>();
  const perSkill: Record<string, string> = {};
  for (const s of selection(src)) {
    const copy = path.join(lib.agents, s.name);
    const entry = lock[s.name];
    if (!entry || entry.source !== lockSource(src) || isLink(copy) || !isSkillDir(copy)) {
      report.add({ kind: "note", path: path.join(where, "skills", s.name), note: `${s.name} is not in the working set from ${plugin.source}; run refresh; left out` });
      continue;
    }
    skills.set(s.name, internalCopy(folderFiles(copy)));
    if (entry.commit && entry.commit !== meta.commit) perSkill[s.name] = entry.commit;
  }
  if (!skills.size) {
    report.add({ kind: "conflict", path: where, note: `none of ${plugin.source}'s skills is in the working set; run refresh; package not built` });
    return null;
  }
  const licenseRel = (meta.attribution ?? []).find((f) => /^LICENSE(\.|$)/i.test(path.posix.basename(f)));
  const licenseFile = licenseRel ? path.join(snapDir, licenseRel) : null;
  if (!licenseFile || !fs.existsSync(licenseFile)) report.add({ kind: "note", path: where, note: `no LICENSE among the attribution files of ${plugin.source}; the package carries none` });
  const license = licenseFile && fs.existsSync(licenseFile) ? fs.readFileSync(licenseFile) : null;
  return { id, plugin, skills, license, spdx: license ? spdx(license.toString("utf8")) : null, origin: { kind: "source", id: plugin.source!, src, commit: meta.commit, date: meta.date, perSkill } };
}

/** Every file of the package, relative path (/ separators) -> bytes, for the given version and library commit. */
function render(pkg: Package, config: Config, head: Head): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const text = (s: string) => Buffer.from(s, "utf8");
  const { portable, legacy, claude } = manifests(pkg, config, head.version);
  out.set("plugin.json", text(jsonText(portable)));
  out.set(".codex-plugin/plugin.json", text(jsonText(legacy)));
  out.set(".claude-plugin/plugin.json", text(jsonText(claude)));
  if (pkg.license) out.set("LICENSE", pkg.license);
  out.set("NOTICE.md", text(notice(pkg, config, head)));
  for (const [name, files] of pkg.skills) for (const [rel, bytes] of files) out.set(`skills/${name}/${rel}`, bytes);
  return out;
}

/**
 * The three manifests. The portable one is Agent Plugins 1.0 with the ChatGPT interface under extensions; the legacy
 * .codex-plugin one is its flat form; the Claude one carries no version, so Claude Code tracks the library's commits.
 */
function manifests(pkg: Package, config: Config, version: string): { portable: Record<string, unknown>; legacy: Record<string, unknown>; claude: Record<string, unknown> } {
  const lib = config.library ?? {};
  const homepage = lib.homepage && /^https?:\/\//.test(lib.homepage) ? lib.homepage : undefined;
  const ownerUrl = homepage && lib.owner && new RegExp(`^(https?://github\\.com/${lib.owner})(/|$)`).exec(homepage)?.[1];
  const o = pkg.origin;
  const slug = o.kind === "source" ? githubSlug(o.src.repo) : null;
  const description = pkg.plugin.description ?? (o.kind === "own" ? `Skills from skills/${o.group} of ${lib.owner ? `${lib.owner}/` : ""}${lib.name ?? path.basename(pkg.id)}.` : `Skills from ${slug ?? o.src.repo}, following ${o.src.ref}.`);
  const author = o.kind === "own" ? compact({ name: lib.owner ?? pkg.id, url: ownerUrl }) : slug ? { name: slug.split("/")[0], url: `https://github.com/${slug.split("/")[0]}` } : { name: o.id };
  const repository = o.kind === "own" ? homepage : slug ? `https://github.com/${slug}` : o.src.repo;
  const keywords = [...new Set(["skills", pkg.id, o.kind === "own" ? o.group : o.id])];
  const iface = {
    displayName: pkg.plugin.displayName,
    shortDescription: short(description, 30),
    longDescription: description.slice(0, 4000),
    developerName: lib.owner ?? pkg.id,
    category: CATEGORY,
    capabilities: CAPABILITIES,
  };
  const common = compact({ description, author, homepage, repository, license: pkg.spdx ?? undefined, keywords });
  return {
    portable: { $schema: PLUGIN_SCHEMA, name: pkg.id, version, ...common, extensions: { "com.openai": { interface: iface } } },
    legacy: { name: pkg.id, version, ...common, skills: "./skills/", interface: iface },
    claude: compact({ name: pkg.id, displayName: pkg.plugin.displayName, description, author, license: pkg.spdx ?? undefined, homepage, repository, keywords }),
  };
}

/** NOTICE.md: where the files came from, at which commit, under which license, and why every copy is marked internal. */
function notice(pkg: Package, config: Config, head: Head): string {
  const lib = config.library ?? {};
  const o = pkg.origin;
  const libraryName = lib.owner && lib.name ? `${lib.owner}/${lib.name}` : lib.name ?? "the skills library";
  const commitLine = o.kind === "source" ? `${o.commit} (${o.date})` : head.commit ? `${head.commit} (${head.date})` : "not a git checkout";
  const source = o.kind === "own" ? `\`skills/${o.group}\` of ${libraryName}${lib.homepage ? ` (${lib.homepage})` : ""}` : `${o.src.repo} (ref \`${o.src.ref}\`${o.src.root ? `, skills under \`${o.src.root}\`` : ""})`;
  const license = pkg.license ? `${pkg.spdx ?? "see LICENSE"}${pkg.spdx ? ", see LICENSE" : ""}` : o.kind === "own" ? "no LICENSE file in the library" : "no LICENSE among the source's attribution files";
  const renamed = o.kind === "source" ? new Map(selection(o.src).filter((s) => s.upstream !== s.name).map((s) => [s.name, s.upstream])) : new Map<string, string>();
  const skills = [...pkg.skills.keys()].map((n) => {
    const notes = [renamed.has(n) ? `renamed from ${renamed.get(n)}` : "", o.kind === "source" && o.perSkill[n] ? `at ${o.perSkill[n]}` : ""].filter(Boolean);
    return notes.length ? `${n} (${notes.join(", ")})` : n;
  });
  return [
    "# NOTICE",
    "",
    `\`${pkg.id}\` is a plugin package built by @oneezy/skills-sync; its files are copies, not the place to edit.`,
    "",
    `- Source: ${source}`,
    `- Commit: ${commitLine}`,
    `- License: ${license}`,
    `- Skills: ${skills.join(", ")}`,
    "",
    "Every `SKILL.md` under `skills/` carries `metadata.internal: true`: the library's own copies are the ones `npx skills` installs and updates, and these are skipped (`INSTALL_INTERNAL_SKILLS=1` re-exposes them).",
    "",
  ].join("\n");
}

/** The two root catalogs, file -> bytes: Claude Code's and Codex's, each entry pointing at ./plugins/<id>. */
function catalogs(config: Config, lib: Library): Map<string, Buffer> {
  const l = config.library ?? {};
  const name = l.name ?? path.basename(lib.root);
  const marketplace = l.owner ? `${l.owner}-${name}` : name;
  const ids = Object.keys(config.plugins);
  const description = (id: string) => config.plugins[id].description;
  const claude = {
    name: marketplace,
    owner: { name: l.owner ?? name },
    description: `Plugins built from ${l.homepage ?? name} by @oneezy/skills-sync.`,
    plugins: ids.map((id) => compact({ name: id, source: `./plugins/${id}`, description: description(id) })),
  };
  const codex = {
    name: marketplace,
    interface: { displayName: l.owner ? `${l.owner}/${name}` : name },
    plugins: ids.map((id) => compact({ name: id, source: `./plugins/${id}`, description: description(id), policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: CATEGORY })),
  };
  return new Map([
    [lib.claudeCatalog, Buffer.from(jsonText(claude), "utf8")],
    [lib.codexCatalog, Buffer.from(jsonText(codex), "utf8")],
  ]);
}

/**
 * SKILL.md with `metadata.internal: true` in its frontmatter (fix d1, duplicate-listing probe): into an existing
 * `metadata:` map as its first entry, or a new map at the end of the frontmatter; every other byte as it was.
 * Applying it twice gives the same text, which is what lets --check compare the source after the transform with disk.
 */
export function withInternal(md: string): string {
  const fm = /^---(\r?\n)([\s\S]*?)(\r?\n)---/.exec(md);
  if (!fm) return `---\nmetadata:\n  internal: true\n---\n${md}`;
  const [whole, open, body, close] = fm;
  const lines = body.split(open);
  const i = lines.findIndex((l) => /^metadata:/.test(l));
  let next: string[];
  if (i < 0) next = [...lines, "metadata:", "  internal: true"];
  else {
    const rest = lines[i].slice("metadata:".length).trim();
    if (rest && !rest.startsWith("#") && rest !== "{}") {
      // a flow map on one line: {a: b} -> {a: b, internal: true}
      const flow = /internal:/.test(rest) ? rest.replace(/internal:\s*[^,}]*/, "internal: true") : rest.replace(/\s*}$/, (m) => `, internal: true${m}`);
      next = [...lines.slice(0, i), `metadata: ${flow}`, ...lines.slice(i + 1)];
    } else {
      let j = i + 1;
      while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
      const children = lines.slice(i + 1, j);
      const indent = children.length ? /^\s*/.exec(children[0])![0] : "  ";
      const k = children.findIndex((l) => l.startsWith(`${indent}internal:`));
      if (k >= 0) children[k] = `${indent}internal: true`;
      else children.unshift(`${indent}internal: true`);
      next = [...lines.slice(0, i), "metadata:", ...children, ...lines.slice(j)];
    }
  }
  return `---${open}${next.join(open)}${close}---` + md.slice(whole.length);
}

/** The copy of a skill folder that goes into a package: its root SKILL.md transformed, everything else as it is. */
function internalCopy(files: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map(files);
  const md = out.get("SKILL.md");
  if (md) out.set("SKILL.md", Buffer.from(withInternal(md.toString("utf8")), "utf8"));
  return out;
}

/** The SPDX id a LICENSE text declares, for the manifests; null when the text is not one of the common licenses. */
export function spdx(text: string): string | null {
  const t = text.replace(/\s+/g, " ").toLowerCase();
  if (/apache license.{0,40}version 2\.0/.test(t)) return "Apache-2.0";
  if (/mozilla public license.{0,20}2\.0/.test(t)) return "MPL-2.0";
  if (/gnu affero general public license.{0,40}version 3/.test(t)) return "AGPL-3.0-only";
  if (/gnu lesser general public license.{0,40}version 3/.test(t)) return "LGPL-3.0-only";
  if (/gnu general public license.{0,40}version 3/.test(t)) return "GPL-3.0-only";
  if (/gnu general public license.{0,40}version 2/.test(t)) return "GPL-2.0-only";
  if (/mit license|permission is hereby granted, free of charge/.test(t)) return "MIT";
  if (/isc license|permission to use, copy, modify, and\/or distribute/.test(t)) return "ISC";
  if (/bsd 3-clause|neither the name of/.test(t)) return "BSD-3-Clause";
  if (/bsd 2-clause|redistribution and use in source and binary forms/.test(t)) return "BSD-2-Clause";
  if (/cc0 1\.0|creative commons zero/.test(t)) return "CC0-1.0";
  if (/the unlicense|free and unencumbered software/.test(t)) return "Unlicense";
  return null;
}

/** The version and commit a package on disk was built with, when its files hold well-formed ones; else the current HEAD. */
function priorHead(disk: Map<string, Buffer>, head: Head): Head {
  let version = head.version;
  try {
    const v = (JSON.parse(disk.get("plugin.json")?.toString("utf8") ?? "{}") as { version?: unknown }).version;
    if (typeof v === "string" && VERSION_RE.test(v)) version = v;
  } catch {
    /* not a manifest: the current version */
  }
  const m = /^- Commit: (?:([0-9a-f]{40}) \(([^)]+)\)|(not a git checkout))$/m.exec(disk.get("NOTICE.md")?.toString("utf8") ?? "");
  if (!m) return { ...head, version };
  return m[3] ? { version, commit: null, date: null } : { version, commit: m[1], date: m[2] };
}

/** Writes for files that differ or are missing, deletes for files no longer part of the package (a whole skill folder as one), skips for the rest. */
function reconcile(report: Report, dir: string, disk: Map<string, Buffer>, expected: Map<string, Buffer>, check: boolean): void {
  for (const rel of [...expected.keys()].sort(cmp)) {
    const file = path.join(dir, rel);
    const have = disk.get(rel);
    if (have && have.equals(expected.get(rel)!)) report.add({ kind: "skip", path: file, note: "ok" });
    else report.add({ kind: "write", path: file, payload: expected.get(rel), note: have ? (check ? "differs" : "changed") : check ? "missing" : "new" });
  }
  const gone = new Set<string>();
  for (const rel of [...disk.keys()].sort(cmp)) {
    if (expected.has(rel)) continue;
    const m = /^skills\/([^/]+)\//.exec(rel);
    const folder = m && ![...expected.keys()].some((k) => k.startsWith(`skills/${m[1]}/`)) ? `skills/${m[1]}` : rel;
    if (gone.has(folder)) continue;
    gone.add(folder);
    report.add({ kind: "delete", path: path.join(dir, folder), note: folder === rel ? "not part of the package" : "skill no longer in the package" });
  }
}

interface Snapshot {
  commit: string;
  date: string;
  attribution?: string[];
}

function readSnapshot(snapDir: string): Snapshot | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(snapDir, ".snapshot.json"), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

/** Every file under a folder (links followed), relative path with / separators -> bytes. */
function folderFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) out.set(path.relative(dir, full).split("\\").join("/"), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** The package as it is on disk; empty when there is none. */
function diskFiles(dir: string): Map<string, Buffer> {
  return isDir(dir) ? folderFiles(dir) : new Map();
}

function sameFiles(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || !v.equals(w)) return false;
  }
  return true;
}

/**
 * The description's first clause (up to a comma, colon, semicolon, period or parenthesis) when it fits in `max`
 * characters; else the description cut at a word boundary. Never a trailing stop.
 */
function short(s: string, max: number): string {
  const clause = /^(.*?)\s*(?:[,;:.]|\s\()/.exec(s)?.[1];
  if (clause && clause.length <= max) return clause;
  if (s.length <= max) return s.replace(/[.,;:]+$/, "");
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 3 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s.,;:]+$/, "");
}

/** The object without its undefined values, so a missing field is absent rather than null. */
function compact<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function jsonText(o: unknown): string {
  return JSON.stringify(o, null, 2) + "\n";
}
