// build: the plugin form, written into the library from skills-sync.json. One package per plugin under plugins/<id>/
// (an own group's skills, or a source's working-set copies), with the three host manifests, LICENSE and NOTICE.md; and
// the two root catalogs that point at ./plugins/<id>; and, on request, the upload archives under artifacts/. Every output
// is computed in memory first and compared with disk, so a build with nothing new is silent and --check is the same
// computation that writes nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { archives, type Built } from "./artifacts.js";
import { isDir, isLink, isSkillDir, lexists } from "./fs.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cmp, githubSlug, lockSource, readConfig, selection, type Config, type Plugin, type Source } from "./sources.js";

export interface BuildOptions {
  /** write plugins/<id>/ for every plugin in the config */
  plugins: boolean;
  /** write the two root marketplace catalogs */
  catalogs: boolean;
  /** write the upload archives under artifacts/; never part of a check */
  artifacts: boolean;
  /** compute every output, report what differs from disk, write nothing */
  check: boolean;
  plan: boolean;
  log: (s: string) => void;
}

export interface BuildResult {
  report: Report;
  /** plugin id -> the version its manifests carry after this run (kept, or bumped because its files changed) */
  versions: Record<string, string>;
  /** --check: every path that differs from what the build would write, and every package that cannot be built, relative to the library, / separators */
  drift: string[];
  /** generate.plugins is false: nothing built, nothing checked */
  off: boolean;
  /** plugin ids of an own group holding no skill yet: neither built nor cataloged, one note (or removal) each */
  skipped: string[];
}

/**
 * The library's HEAD, for the NOTICE of an own package and the build metadata of a changed one. `version` is what a
 * package new at this HEAD carries (0.1.0+<sha12>); a changed package takes the next minor after its own (see bump).
 */
export interface Head {
  version: string;
  commit: string | null;
  date: string | null;
  /** the library is a git checkout, with or without a commit yet */
  checkout: boolean;
  /** a shallow clone: it holds only the commits it fetched, so a commit a version names may be missing */
  shallow: boolean;
}

/** The Agent Plugins 1.0 schema the portable manifest declares. */
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/** What the ChatGPT interface and the Codex catalog say every package is; the hosts enumerate neither value in their docs. */
const CATEGORY = "Developer Tools";
const CAPABILITIES = ["Interactive"];
/**
 * 0.<n>.0+<sha12>: what a package built in a checkout with a commit carries. n starts at 1 and goes up by one each time
 * the package's files change; the sha is the library's HEAD at that build. n never comes from git history: a commit
 * count shrinks across a squash merge or a promotion, and a version must never move backwards.
 */
const VERSION_RE = /^0\.(\d+)\.0\+([0-9a-f]{12,40})$/;
const NOGIT = "0.0.0+nogit";

/**
 * The trimmed stdout of a git command run in the library; null when it fails. Never a fetch: asking a partial clone
 * for a commit it does not hold would otherwise go to its remote for it.
 */
function git(root: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A library without git, or a checkout without a commit yet, gets 0.0.0+nogit and no commit. */
export function libraryHead(root: string): Head {
  const checkout = git(root, "rev-parse", "--git-dir") !== null;
  const short = checkout ? git(root, "rev-parse", "--short=12", "HEAD") : null;
  const shallow = checkout && git(root, "rev-parse", "--is-shallow-repository") === "true";
  if (!short) return { version: NOGIT, commit: null, date: null, checkout, shallow };
  return { version: `0.1.0+${short}`, commit: git(root, "rev-parse", "HEAD"), date: isoDate(git(root, "log", "-1", "--format=%cI")), checkout, shallow };
}

/**
 * A commit date as git's %cI gives it, in one spelling: git 2.45 and later write UTC as `Z`, older git as `+00:00`.
 * The NOTICE must not depend on which git built it, so `+00:00` is written `Z`, what CI's git prints.
 */
export function isoDate<T extends string | null>(d: T): T {
  return (d === null ? d : d.replace(/[+-]00:?00$/, "Z")) as T;
}

/**
 * The version a package whose files changed takes: the next minor after the one on disk (1 for a new package, or one
 * whose version is not of the rule), with HEAD's sha. Monotonic whatever the branch history did.
 */
export function bump(diskVersion: unknown, head: Head): string {
  if (!head.commit) return NOGIT;
  const v = typeof diskVersion === "string" ? VERSION_RE.exec(diskVersion) : null;
  return `0.${v ? Number(v[1]) + 1 : 1}.0+${head.version.split("+")[1]}`;
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
  const result: BuildResult = { report, versions: {}, drift: [], off: !config.generate.plugins, skipped: [] };
  if (result.off) return result;
  const changes = new Report(); // what differs from disk, applied unless checking
  // a check never looks at artifacts/: the archives are upload material, generated and ignored by git
  const artifacts = opts.artifacts && !opts.check;
  const built: Built[] = [];
  const empty = emptyGroups(lib, config);
  result.skipped = [...empty.keys()];
  const ids = Object.keys(config.plugins).filter((id) => !empty.has(id));
  if (opts.plugins || artifacts) {
    // a declared group with no skills yet (a new playground) is skipped, not a conflict: one line, a removal when it once had a package
    for (const [id, note] of empty) {
      const dir = path.join(lib.plugins, id);
      if (!opts.plugins || !lexists(dir)) changes.add({ kind: "note", path: dir, note });
      else changes.add(isLink(dir) ? { kind: "conflict", path: dir, note: `${note}; a link, not a package built here; left alone` } : { kind: "delete", path: dir, note });
    }
    for (const id of ids) {
      const dir = path.join(lib.plugins, id);
      const pkg = resolvePackage(lib, config, id, changes);
      if (!pkg) continue;
      const disk = diskFiles(dir);
      if (disk.links.length) {
        // never followed, never written through: a link inside the package is a conflict and the package is left alone
        for (const l of disk.links) changes.add({ kind: "conflict", path: path.join(dir, l), note: `a link inside plugins/${id}; build never follows or writes through one; package left alone` });
        continue;
      }
      // a package whose files are unchanged keeps the version and commit it was built with: the HEAD moves with every
      // commit of the library, and a rebuild after one must not rewrite packages whose inputs did not change
      const prior = priorHead(lib.root, disk.files, head, pkg.origin.kind === "own");
      const atPrior = render(pkg, config, prior);
      const unchanged = sameFiles(disk.files, atPrior);
      const at = unchanged ? prior : { ...head, version: bump(diskVersion(disk.files), head) };
      const files = unchanged ? atPrior : render(pkg, config, at);
      result.versions[id] = at.version;
      if (opts.plugins) reconcile(changes, dir, disk.files, files, opts.check);
      // the archive is made from the same files, so it is the package build writes, at the version its manifests carry
      built.push({ id, version: at.version, commit: pkg.origin.kind === "source" ? pkg.origin.commit : at.commit, files });
    }
  }
  if (opts.plugins) {
    // packages for ids no longer in the config; a link there was not built here and is left alone
    if (isDir(lib.plugins)) {
      for (const n of fs.readdirSync(lib.plugins).sort(cmp)) {
        const p = path.join(lib.plugins, n);
        if (n.startsWith(".") || ids.includes(n) || empty.has(n) || !isDir(p)) continue;
        if (isLink(p)) changes.add({ kind: "conflict", path: p, note: "a link, not a package built here; left alone" });
        else changes.add({ kind: "delete", path: p, note: "no longer in skills-sync.json" });
      }
    }
  }
  if (opts.catalogs) {
    const files = catalogs(config, lib, ids);
    for (const [file, bytes] of files) {
      const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (have && asBuilt(have, bytes)) changes.add({ kind: "skip", path: file, note: "ok" });
      else changes.add({ kind: "write", path: file, payload: bytes, note: have ? (opts.check ? "differs" : "changed") : opts.check ? "missing" : "new" });
    }
  }
  if (artifacts) archives(lib, config, built, changes);
  report.merge(changes);
  // --check: every write and delete is drift, and so is every package that cannot be built (a conflict)
  if (opts.check) result.drift = changes.actions.filter((a) => a.kind !== "skip" && a.kind !== "note").map((a) => path.relative(lib.root, a.path).split("\\").join("/"));
  else apply(changes, opts.plan);
  return result;
}

/** Plugin id -> its note, for every plugin of an own group that holds no skill yet: nothing to package or catalog. */
function emptyGroups(lib: Library, config: Config): Map<string, string> {
  const own = lib.scanOwn().skills;
  const out = new Map<string, string>();
  for (const [id, p] of Object.entries(config.plugins)) {
    if (p.group && !own.some((s) => s.plugin === p.group)) out.set(id, `no skills under skills/${p.group} yet; not built, not cataloged`);
  }
  return out;
}

/** The plugin's skills, license and origin; null (reported) when the config names a source that yields nothing (an empty group never gets here). */
function resolvePackage(lib: Library, config: Config, id: string, report: Report): Package | null {
  const plugin = config.plugins[id];
  const where = path.join(lib.plugins, id);
  if (plugin.group) {
    const own = lib.scanOwn().skills.filter((s) => s.plugin === plugin.group);
    const skills = new Map<string, Map<string, Buffer>>();
    for (const s of own) skills.set(s.name, skillCopy(s.dir, report));
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((n) => path.join(lib.root, n)).find((f) => fs.existsSync(f));
    if (!licenseFile) report.add({ kind: "note", path: where, note: "no LICENSE in the library; the package carries none" });
    const license = licenseFile ? lf(fs.readFileSync(licenseFile)) : null;
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
    skills.set(s.name, skillCopy(copy, report));
    if (entry.commit && entry.commit !== meta.commit) perSkill[s.name] = entry.commit;
  }
  if (!skills.size) {
    report.add({ kind: "conflict", path: where, note: `none of ${plugin.source}'s skills is in the working set; run refresh; package not built` });
    return null;
  }
  const licenseRel = (meta.attribution ?? []).find((f) => /^LICENSE(\.|$)/i.test(path.posix.basename(f)));
  const licenseFile = licenseRel ? path.join(snapDir, licenseRel) : null;
  if (!licenseFile || !fs.existsSync(licenseFile)) report.add({ kind: "note", path: where, note: `no LICENSE among the attribution files of ${plugin.source}; the package carries none` });
  const license = licenseFile && fs.existsSync(licenseFile) ? lf(fs.readFileSync(licenseFile)) : null;
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
  const commitLine = o.kind === "source" ? `${o.commit} (${isoDate(o.date)})` : head.commit ? `${head.commit} (${isoDate(head.date)})` : head.checkout ? "a git checkout without a commit yet" : "not a git checkout";
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

/** The two root catalogs, file -> bytes: Claude Code's and Codex's, each entry pointing at ./plugins/<id> for every plugin built. */
function catalogs(config: Config, lib: Library, ids: string[]): Map<string, Buffer> {
  const l = config.library ?? {};
  const name = l.name ?? path.basename(lib.root);
  const marketplace = l.owner ? `${l.owner}-${name}` : name;
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

/**
 * The copy of a skill folder that goes into a package: every file in the package's line endings (see `lf`), its root
 * SKILL.md marked internal, everything else as it is; a link inside is not copied, with a note.
 */
function skillCopy(dir: string, report: Report): Map<string, Buffer> {
  const { files, links } = folderFiles(dir);
  for (const l of links) report.add({ kind: "note", path: path.join(dir, l), note: "a link; not copied into the package" });
  const out = new Map([...files].map(([rel, bytes]) => [rel, lf(bytes)]));
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

/** The version a package's plugin.json on disk carries; undefined when there is none or it does not parse. */
function diskVersion(disk: Map<string, Buffer>): unknown {
  try {
    return (JSON.parse(disk.get("plugin.json")?.toString("utf8") ?? "{}") as { version?: unknown }).version;
  } catch {
    return undefined;
  }
}

/**
 * The version and commit a package on disk was built with. The package is the record of that: its commit need not be
 * in HEAD's history, or in the repository at all. A squash merge lands the package and leaves the branch commit it
 * was built at behind, and a shallow clone holds no commit but the newest, so on the branch a pull request merges
 * into, and in CI, the commit a version names is routinely one git cannot show. What is checked is what can be:
 * the version has the form of the rule; an own package's NOTICE names, in full and with a date, the commit the
 * version abbreviates; and when the repository does hold that commit, its date is the one recorded. A package that
 * fails any of these (a hand-set version, 0.0.0+nogit once there is a commit, a NOTICE naming another commit) is
 * treated as changed: it takes the next version at HEAD. Without a commit there is no prior, only 0.0.0+nogit.
 */
function priorHead(root: string, disk: Map<string, Buffer>, head: Head, own: boolean): Head {
  if (!head.commit) return head;
  const version = diskVersion(disk);
  const v = typeof version === "string" ? VERSION_RE.exec(version) : null;
  if (!v) return head;
  const n = own ? /^- Commit: ([0-9a-f]{40}) \(([^)]+)\)$/m.exec(disk.get("NOTICE.md")?.toString("utf8") ?? "") : null;
  if (own && (!n || !n[1].startsWith(v[2]))) return head;
  const held = n ? git(root, "rev-parse", "--verify", "--quiet", `${n[1]}^{commit}`) : null;
  if (held && n && isoDate(git(root, "log", "-1", "--format=%cI", held)) !== isoDate(n[2])) return head;
  return n ? { ...head, version: v[0], commit: n[1], date: n[2] } : { ...head, version: v[0] };
}

/** Writes for files that differ or are missing, deletes for files no longer part of the package (a whole skill folder as one), skips for the rest. */
function reconcile(report: Report, dir: string, disk: Map<string, Buffer>, expected: Map<string, Buffer>, check: boolean): void {
  for (const rel of [...expected.keys()].sort(cmp)) {
    const file = path.join(dir, rel);
    const have = disk.get(rel);
    if (have && asBuilt(have, expected.get(rel)!)) report.add({ kind: "skip", path: file, note: "ok" });
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

/** The files under a folder, relative path with / separators -> bytes, and the links at any depth: listed, never followed. */
function folderFiles(dir: string): { files: Map<string, Buffer>; links: string[] } {
  const files = new Map<string, Buffer>();
  const links: string[] = [];
  const rel = (p: string) => path.relative(dir, p).split("\\").join("/");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (isLink(full)) links.push(rel(full));
      else if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.set(rel(full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return { files, links };
}

/** The package as it is on disk; empty when there is none; the folder itself as the one link when it is a link. */
function diskFiles(dir: string): { files: Map<string, Buffer>; links: string[] } {
  if (isLink(dir)) return { files: new Map(), links: [""] };
  return isDir(dir) ? folderFiles(dir) : { files: new Map(), links: [] };
}

/** Disk holds every expected file as built, and nothing else. */
function sameFiles(disk: Map<string, Buffer>, expected: Map<string, Buffer>): boolean {
  if (disk.size !== expected.size) return false;
  for (const [k, have] of disk) {
    const want = expected.get(k);
    if (!want || !asBuilt(have, want)) return false;
  }
  return true;
}

/**
 * Disk holds the expected bytes, or their CRLF form: what a checkout with core.autocrlf=true makes of a committed LF
 * file. build writes LF; a clone that git converts on checkout is as built, and git itself sees nothing to commit there.
 */
export function asBuilt(have: Buffer, expected: Buffer): boolean {
  return have.equals(expected) || (have.length > expected.length && have.equals(crlf(expected)));
}

/** The bytes as such a checkout holds them: git converts only a text file whose line endings are all bare LF. */
function crlf(b: Buffer): Buffer {
  if (b.includes(0) || b.includes(0x0d)) return b;
  return Buffer.from(b.toString("latin1").replace(/\n/g, "\r\n"), "latin1");
}

/**
 * A source file in the line endings a package holds: a text file whose line endings are all CRLF gets LF, anything
 * else stays as it is. The files of a package are read from a checkout, and a checkout that converts on the way out
 * (core.autocrlf=true) hands a committed LF file over as CRLF; copied as read, the same commit would give another
 * package there, another archive with another sha256, and a shell script that fails on Linux. A file with a bare LF
 * (LF or mixed endings) is not a converted one; text is what git takes for it: no NUL, and at most one control
 * character in 128 bytes.
 */
function lf(b: Buffer): Buffer {
  if (!b.includes("\r\n") || b.includes(0)) return b;
  let control = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x0a && b[i - 1] !== 0x0d) return b;
    // every C0 control but BS, HT, LF, FF, CR and ESC, and DEL
    if (c === 0x7f || (c < 0x20 && ![0x08, 0x09, 0x0a, 0x0c, 0x0d, 0x1b].includes(c))) control++;
  }
  if (control > (b.length - control) >> 7) return b;
  return Buffer.from(b.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
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
