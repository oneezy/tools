// build: the plugin form, written into the library from skills-sync.json. One package per plugin under plugins/<id>/
// (an own group's skills, or a source's working-set copies), with the three host manifests, LICENSE and NOTICE.md; when
// the config opts in (renderings.hermes), its Hermes rendering under dist/hermes/<id>/ (the same package without
// metadata.internal, which Hermes's portable loader rejects; `dist` is a folder the skills CLI never scans, so each
// skill is still listed once); and the two root catalogs that point at ./plugins/<id>; and, on request, the upload
// archives under artifacts/. Every output is computed in memory first and compared with disk, so a build with nothing
// new is silent and --check is the same computation that writes nothing. A new output ships behind a library opt-in so
// that the publish guard (ADR-0008: this build's --check against the library's main) stays strict for a library that
// has not opted in yet.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { adaptFiles, compileAdapt, forbiddenInFiles, type Compiled, type Hit } from "./adapt.js";
import { archives, type Built } from "./artifacts.js";
import { isDir, isLink, isSkillDir, lexists } from "./fs.js";
import { hermesNamespace } from "./hermes.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import {
  cmp,
  githubSlug,
  isoDate,
  lockedUpstream,
  readConfig,
  renamesOf,
  selection,
  type Config,
  type Plugin,
  type Source,
} from "./sources.js";
import { plainVersion } from "./versions.js";

export { isoDate };

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
  /** the config to build from instead of the file's: remove --plan builds from the config as it would write it */
  config?: Config;
}

export interface BuildResult {
  report: Report;
  /** plugin id -> its declared authored version or locked upstream version; null for unversioned sources */
  versions: Record<string, string | null>;
  /** --check: every path that differs from what the build would write, and every package that cannot be built, relative to the library, / separators */
  drift: string[];
  /** generate.plugins is false: nothing built, nothing checked */
  off: boolean;
  /** plugin ids of an own group holding no skill yet: neither built nor cataloged, one note (or removal) each */
  skipped: string[];
  /** every forbidden term a source's adapt rules left in a package file (path relative to the library, / separators) */
  forbidden: Forbidden[];
  /** every adapt rule that matched nothing in any file of its source's skills, by its index in the rules */
  unusedRules: UnusedRule[];
}

/** A forbidden term left in a package file after its source's adapt rules: the file, its line (from 1), the term. */
export interface Forbidden extends Hit {
  source: string;
  path: string;
}

/** An adapt rule that matched nothing in its source's skills. */
export interface UnusedRule {
  source: string;
  rule: number;
  find: string;
}

/**
 * The library's HEAD supplies provenance only. A package's version comes from its declaration or source lock.
 */
export interface Head {
  version: string | null;
  commit: string | null;
  date: string | null;
  /** the library is a git checkout, with or without a commit yet */
  checkout: boolean;
  /** a shallow clone: it holds only the commits it fetched, so a commit a version names may be missing */
  shallow: boolean;
}

/** The Agent Plugins 1.0 schema the portable manifest declares. */
export const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
/**
 * Where the Hermes rendering of every package lives in the library, / separators: dist/hermes/<id>, the value
 * `renderings.hermes` in skills-sync.json takes to opt in. `dist` is in the skills CLI's SKIP_DIRS, so `npx skills add
 * owner/repo` never lists these copies; Claude Code and Codex read plugins/ through the catalogs and never look here.
 * `hermes plugins install owner/repo/dist/hermes/<id>` is the install, and this is the folder the machine sync installs
 * from when the release's config names none (release.ts reads `renderings.hermes` from the release's skills-sync.json).
 */
export const HERMES_PATH = "dist/hermes";
const SKILL_MD = /^skills\/([^/]+)\/SKILL\.md$/;

/** The folder the config sends the Hermes rendering to, / separators; null when the library has not opted in. */
export function hermesPath(config: Config): string | null {
  return config.renderings?.hermes ?? null;
}

/** <rendering folder> under a library root. */
function hermesRoot(root: string, rendering: string): string {
  return path.join(root, ...rendering.split("/"));
}

/** <rendering folder>/<id> under a library root. */
export function hermesDir(root: string, rendering: string, id: string): string {
  return path.join(hermesRoot(root, rendering), id);
}
/** What the ChatGPT interface and the Codex catalog say every package is; the hosts enumerate neither value in their docs. */
const CATEGORY = "Developer Tools";
const CAPABILITIES = ["Interactive"];
/** Legacy generated versions are checked against NOTICE during migration, never assigned to new packages. */
const VERSION_RE = /^0\.(\d+)\.0\+([0-9a-f]{12,40})$/;

/**
 * The trimmed stdout of a git command run in the library; null when it fails. Never a fetch: asking a partial clone
 * for a commit it does not hold would otherwise go to its remote for it.
 */
function git(root: string, ...args: string[]): string | null {
  const r = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Read provenance without assigning a version, including libraries without git or a first commit. */
export function libraryHead(root: string): Head {
  const checkout = git(root, "rev-parse", "--git-dir") !== null;
  const short = checkout ? git(root, "rev-parse", "--short=12", "HEAD") : null;
  const shallow = checkout && git(root, "rev-parse", "--is-shallow-repository") === "true";
  if (!short) return { version: null, commit: null, date: null, checkout, shallow };
  return {
    version: null,
    commit: git(root, "rev-parse", "HEAD"),
    date: isoDate(git(root, "log", "-1", "--format=%cI")),
    checkout,
    shallow,
  };
}

/** Compatibility export: builds now use the declared version regardless of the package previously on disk. */
export function bump(_diskVersion: unknown, head: Head): string | null {
  return head.version;
}

/** Where a package's skills came from, for its NOTICE. */
type Origin =
  | { kind: "own"; group: string }
  | {
      kind: "source";
      id: string;
      src: Source;
      commit: string;
      date: string;
      version: string | null;
      perSkill: Record<string, string>;
      /** how many adapt rules matched in the text files, 0 when the source has none or none matched */
      adapted: number;
    };

/** One package, resolved: its skills with every transform applied, its license, its origin. */
interface Package {
  id: string;
  plugin: Plugin;
  /** skill name -> relative path -> bytes */
  skills: Map<string, Map<string, Buffer>>;
  license: Buffer | null;
  spdx: string | null;
  origin: Origin;
  /** forbidden terms left in the package's files, relative to the package */
  forbidden: Array<Hit & { rel: string }>;
  /** the source's adapt rules that matched nothing */
  unused: UnusedRule[];
}

export function build(lib: Library, opts: BuildOptions): BuildResult {
  const config = opts.config ?? readConfig(lib.configFile);
  const report = new Report();
  const head = libraryHead(lib.root);
  const result: BuildResult = {
    report,
    versions: {},
    drift: [],
    off: !config.generate.plugins,
    skipped: [],
    forbidden: [],
    unusedRules: [],
  };
  if (result.off) return result;
  const changes = new Report(); // what differs from disk, applied unless checking
  // a check never looks at artifacts/: the archives are upload material, generated and ignored by git
  const artifacts = opts.artifacts && !opts.check;
  const built: Built[] = [];
  const rendering = hermesPath(config);
  const empty = emptyGroups(lib, config);
  result.skipped = [...empty.keys()];
  const ids = Object.keys(config.plugins).filter((id) => !empty.has(id));
  if (opts.plugins || artifacts) {
    // a declared group with no skills yet (a new playground) is skipped, not a conflict: one line, a removal when it once had a package
    for (const [id, note] of empty) {
      const dir = path.join(lib.plugins, id);
      if (!opts.plugins || !lexists(dir)) changes.add({ kind: "note", path: dir, note });
      else
        changes.add(
          isLink(dir)
            ? { kind: "conflict", path: dir, note: `${note}; a link, not a package built here; left alone` }
            : { kind: "delete", path: dir, note },
        );
      const hermes = rendering ? hermesDir(lib.root, rendering, id) : null;
      if (opts.plugins && hermes && lexists(hermes))
        changes.add(
          isLink(hermes)
            ? { kind: "conflict", path: hermes, note: `${note}; a link, not a rendering built here; left alone` }
            : { kind: "delete", path: hermes, note },
        );
    }
    for (const id of ids) {
      const dir = path.join(lib.plugins, id);
      const pkg = resolvePackage(lib, config, id, changes);
      if (!pkg) continue;
      if (pkg.origin.kind === "source") {
        const source = pkg.origin.id;
        for (const { rel, ...h } of pkg.forbidden)
          result.forbidden.push({ source, path: `plugins/${id}/${rel}`, ...h });
        // two plugins packaging one source see the same skills: each unused rule is named once
        for (const u of pkg.unused)
          if (!result.unusedRules.some((x) => x.source === u.source && x.rule === u.rule)) result.unusedRules.push(u);
      }
      const disk = diskFiles(dir);
      if (disk.links.length) {
        // never followed, never written through: a link inside the package is a conflict and the package is left alone
        for (const l of disk.links)
          changes.add({
            kind: "conflict",
            path: path.join(dir, l),
            note: `a link inside plugins/${id}; build never follows or writes through one; package left alone`,
          });
        continue;
      }
      // a package whose files are unchanged keeps the version and commit it was built with: the HEAD moves with every
      // commit of the library, and a rebuild after one must not rewrite packages whose inputs did not change
      const version = pkg.origin.kind === "source" ? pkg.origin.version : (config.library?.version ?? null);
      if (pkg.origin.kind === "own" && version === null) {
        changes.add({
          kind: "conflict",
          path: dir,
          note: "set library.version to an explicit semantic version; build never assigns authored versions",
        });
        continue;
      }
      const target = { ...head, version };
      const prior = priorHead(lib.root, disk.files, target, pkg.origin.kind === "own");
      const atPrior = render(pkg, config, prior);
      const unchanged = sameFiles(disk.files, atPrior);
      const at = unchanged ? prior : target;
      const files = unchanged ? atPrior : render(pkg, config, at);
      result.versions[id] = at.version;
      if (opts.plugins) {
        reconcile(changes, dir, disk.files, files, opts.check);
        if (rendering) hermesRendering(lib, rendering, id, files, changes, opts.check);
      }
      // the archive is made from the same files, so it is the package build writes, at the version its manifests carry
      built.push({
        id,
        version: at.version,
        commit: pkg.origin.kind === "source" ? pkg.origin.commit : at.commit,
        versionScheme: pkg.origin.kind === "source" ? "upstream" : "authored",
        files,
      });
    }
  }
  if (opts.plugins) {
    // packages, and Hermes renderings, for ids no longer in the config; a link there was not built here and is left alone
    for (const root of [lib.plugins, ...(rendering ? [hermesRoot(lib.root, rendering)] : [])]) {
      if (!isDir(root)) continue;
      for (const n of fs.readdirSync(root).sort(cmp)) {
        const p = path.join(root, n);
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
      else
        changes.add({
          kind: "write",
          path: file,
          payload: bytes,
          note: have ? (opts.check ? "differs" : "changed") : opts.check ? "missing" : "new",
        });
    }
  }
  if (artifacts) archives(lib, config, built, changes);
  report.merge(changes);
  // --check: every write and delete is drift, and so is every package that cannot be built (a conflict)
  if (opts.check)
    result.drift = changes.actions
      .filter((a) => a.kind !== "skip" && a.kind !== "note")
      .map((a) => path.relative(lib.root, a.path).split("\\").join("/"));
  else apply(changes, opts.plan);
  return result;
}

/** One package rendered for a Development build: its files, or why it cannot be built. */
export type DevelopmentPackage =
  | { ok: true; id: string; own: boolean; files: Map<string, Buffer>; notes: string[] }
  | { ok: false; id: string; errors: string[]; notes: string[] };

/**
 * The files of one plugin as the release build renders them (same manifests, normal identity, same skill copies), from
 * the working Library and never from disk output: an own Group's NOTICE names the working tree instead of a library
 * commit, so a commit that changes no input changes no file. Writes nothing; a package the release build would refuse
 * (a missing snapshot, an unversioned own Group, an empty Group) comes back with its reasons.
 */
export function developmentPackage(lib: Library, config: Config, id: string): DevelopmentPackage {
  const report = new Report();
  // a note about the package as a whole names the plugin, never the release folder plugins/<id>
  const where = (p: string) =>
    p === path.join(lib.plugins, id) ? id : path.relative(lib.root, p).split("\\").join("/");
  const notes = () => report.actions.filter((a) => a.kind === "note").map((a) => `${where(a.path)}: ${a.note}`);
  const errors = () => report.conflicts().map((a) => a.note ?? "cannot be built");
  if (!config.plugins[id]) return { ok: false, id, errors: [`${id} is not a plugin in skills-sync.json`], notes: [] };
  const empty = emptyGroups(lib, config).get(id);
  if (empty) return { ok: false, id, errors: [empty], notes: [] };
  const pkg = resolvePackage(lib, config, id, report);
  if (!pkg) return { ok: false, id, errors: errors(), notes: notes() };
  const own = pkg.origin.kind === "own";
  const version = pkg.origin.kind === "source" ? pkg.origin.version : (config.library?.version ?? null);
  if (own && version === null)
    return { ok: false, id, errors: ["set library.version to an explicit semantic version"], notes: notes() };
  const head: Head = { version, commit: null, date: null, checkout: false, shallow: false };
  const files = render(pkg, config, head, "the working Library (a development build, not a release)");
  return { ok: true, id, own, files, notes: notes() };
}

/** Plugin id -> its note, for every plugin of an own group that holds no skill yet: nothing to package or catalog. */
function emptyGroups(lib: Library, config: Config): Map<string, string> {
  const own = lib.scanOwn().skills;
  const out = new Map<string, string>();
  for (const [id, p] of Object.entries(config.plugins)) {
    if (p.group && !own.some((s) => s.plugin === p.group))
      out.set(id, `no skills under skills/${p.group} yet; not built, not cataloged`);
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
    for (const s of own) skills.set(s.name, skillCopy(s.dir, report, null).files);
    const licenseFile = ["LICENSE", "LICENSE.md", "LICENSE.txt"]
      .map((n) => path.join(lib.root, n))
      .find((f) => fs.existsSync(f));
    if (!licenseFile)
      report.add({ kind: "note", path: where, note: "no LICENSE in the library; the package carries none" });
    const license = licenseFile ? lf(fs.readFileSync(licenseFile)) : null;
    return {
      id,
      plugin,
      skills,
      license,
      spdx: license ? spdx(license.toString("utf8")) : null,
      origin: { kind: "own", group: plugin.group },
      forbidden: [],
      unused: [],
    };
  }
  const src = config.sources[plugin.source!];
  if (!src) {
    report.add({
      kind: "conflict",
      path: where,
      note: `source ${plugin.source} is not in skills-sync.json; package not built`,
    });
    return null;
  }
  // the source's adapt rules, compiled once; a pattern that is not a regular expression stops the package
  const adapt = compileAdapt(src.adapt ?? {}, `sources.${plugin.source}.adapt`);
  if (!adapt.ok) {
    report.add({ kind: "conflict", path: where, note: `${adapt.errors.join("; ")}; package not built` });
    return null;
  }
  const rules = adapt.compiled.rules.length ? adapt.compiled : null;
  const counts = adapt.compiled.rules.map(() => 0);
  const forbidden: Array<Hit & { rel: string }> = [];
  const snapDir = path.join(lib.upstream, plugin.source!);
  const meta = readSnapshot(snapDir);
  if (!meta) {
    report.add({
      kind: "conflict",
      path: where,
      note: `no snapshot under upstream/${plugin.source}; run refresh first; package not built`,
    });
    return null;
  }
  // the working-set copies of this source's selected skills, renames applied; the lock says which copy is this source's
  const locked = lib.lock()?.sources[plugin.source!];
  const lock = locked?.repo === src.repo ? locked : undefined;
  if (!lock || lock.commit !== meta.commit) {
    report.add({
      kind: "conflict",
      path: where,
      note: "snapshot and locked source commit differ; run refresh --frozen before building",
    });
    return null;
  }
  const version = lock.version === null ? null : plainVersion(lock.version)?.split("+")[0];
  if (version === undefined) {
    report.add({
      kind: "conflict",
      path: where,
      note: "locked source version is not semantic; run refresh --frozen before building",
    });
    return null;
  }
  const skills = new Map<string, Map<string, Buffer>>();
  const perSkill: Record<string, string> = {};
  // a "*" source packages what the lock took from upstream
  for (const s of selection(src, lockedUpstream(lock.skills))) {
    const copy = path.join(lib.agents, s.name);
    const entry = lock?.skills[s.name];
    if (!entry || isLink(copy) || !isSkillDir(copy)) {
      report.add({
        kind: "note",
        path: path.join(where, "skills", s.name),
        note: `${s.name} is not in the working set from ${plugin.source}; run refresh; left out`,
      });
      continue;
    }
    const c = skillCopy(copy, report, rules);
    c.counts.forEach((n, i) => (counts[i] += n));
    for (const h of forbiddenInFiles(c.files, adapt.compiled))
      forbidden.push({ ...h, rel: `skills/${s.name}/${h.rel}` });
    skills.set(s.name, c.files);
    const at = entry.commit ?? lock!.commit;
    if (at !== meta.commit) perSkill[s.name] = at;
  }
  if (!skills.size) {
    report.add({
      kind: "conflict",
      path: where,
      note: `none of ${plugin.source}'s skills is in the working set; run refresh; package not built`,
    });
    return null;
  }
  const licenseRel = (meta.attribution ?? []).find((f) => /^LICENSE(\.|$)/i.test(path.posix.basename(f)));
  const licenseFile = licenseRel ? path.join(snapDir, licenseRel) : null;
  if (!licenseFile || !fs.existsSync(licenseFile))
    report.add({
      kind: "note",
      path: where,
      note: `no LICENSE among the attribution files of ${plugin.source}; the package carries none`,
    });
  const license = licenseFile && fs.existsSync(licenseFile) ? lf(fs.readFileSync(licenseFile)) : null;
  return {
    id,
    plugin,
    skills,
    license,
    spdx: license ? spdx(license.toString("utf8")) : null,
    origin: {
      kind: "source",
      id: plugin.source!,
      src,
      commit: meta.commit,
      date: meta.date,
      version,
      perSkill,
      adapted: counts.filter((n) => n > 0).length,
    },
    forbidden,
    unused: (src.adapt?.rules ?? [])
      .map((r, rule) => ({ source: plugin.source!, rule, find: r.find }))
      .filter((r) => counts[r.rule] === 0),
  };
}

/**
 * The Hermes rendering beside the package, <rendering>/<id>/, reconciled like plugins/<id>/ from the same files: a link
 * inside is a conflict and the rendering is left alone; a skill Hermes would still skip (a description over its limit, a
 * folder name that is not a valid skill name) is a note, the copy is written all the same so its siblings load.
 */
function hermesRendering(
  lib: Library,
  rendering: string,
  id: string,
  files: Map<string, Buffer>,
  changes: Report,
  check: boolean,
): void {
  const dir = hermesDir(lib.root, rendering, id);
  const disk = diskFiles(dir);
  if (disk.links.length) {
    for (const l of disk.links)
      changes.add({
        kind: "conflict",
        path: path.join(dir, l),
        note: `a link inside ${rendering}/${id}; build never follows or writes through one; rendering left alone`,
      });
    return;
  }
  const rendered = renderHermes(files);
  for (const [rel, bytes] of rendered) {
    const m = SKILL_MD.exec(rel);
    if (!m) continue;
    const problems = hermesSkillProblems(bytes.toString("utf8"), m[1]);
    if (problems.length)
      changes.add({
        kind: "note",
        path: path.join(dir, ...rel.split("/")),
        note: `Hermes would skip this skill: ${problems.join("; ")}`,
      });
  }
  reconcile(changes, dir, disk.files, rendered, check);
}

/**
 * The Hermes rendering of a package from the package's own files: the same plugin.json, LICENSE, NOTICE.md and skill
 * folders, each skill's root SKILL.md through forHermes(); the Claude and Codex manifests left out (Hermes skips those
 * folders as another harness's). Every file but the root SKILL.md files is byte for byte the package's, so the
 * release's sha256 of NOTICE.md says whether an installed Hermes copy is the release's package.
 */
export function renderHermes(files: Map<string, Buffer>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [rel, bytes] of files) {
    if (rel.startsWith(".claude-plugin/") || rel.startsWith(".codex-plugin/")) continue;
    const m = SKILL_MD.exec(rel);
    out.set(rel, m ? Buffer.from(forHermes(bytes.toString("utf8"), m[1]), "utf8") : bytes);
  }
  return out;
}

/** Every file of the package, relative path (/ separators) -> bytes, for the given version and library commit. */
function render(pkg: Package, config: Config, head: Head, commitLine?: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const text = (s: string) => Buffer.from(s, "utf8");
  const { portable, legacy, claude } = manifests(pkg, config, head.version);
  out.set("plugin.json", text(jsonText(portable)));
  out.set(".codex-plugin/plugin.json", text(jsonText(legacy)));
  out.set(".claude-plugin/plugin.json", text(jsonText(claude)));
  if (pkg.license) out.set("LICENSE", pkg.license);
  out.set("NOTICE.md", text(notice(pkg, config, head, commitLine)));
  for (const [name, files] of pkg.skills) for (const [rel, bytes] of files) out.set(`skills/${name}/${rel}`, bytes);
  return out;
}

/**
 * The three manifests. The portable one is Agent Plugins 1.0 with the ChatGPT interface under extensions; the legacy
 * .codex-plugin one is its flat form; the Claude one carries no version, so Claude Code tracks the library's commits.
 */
function manifests(
  pkg: Package,
  config: Config,
  version: string | null,
): { portable: Record<string, unknown>; legacy: Record<string, unknown>; claude: Record<string, unknown> } {
  const lib = config.library ?? {};
  const homepage = lib.homepage && /^https?:\/\//.test(lib.homepage) ? lib.homepage : undefined;
  const ownerUrl =
    homepage && lib.owner && new RegExp(`^(https?://github\\.com/${lib.owner})(/|$)`).exec(homepage)?.[1];
  const o = pkg.origin;
  const slug = o.kind === "source" ? githubSlug(o.src.repo) : null;
  const description =
    pkg.plugin.description ??
    (o.kind === "own"
      ? `Skills from skills/${o.group} of ${lib.owner ? `${lib.owner}/` : ""}${lib.name ?? path.basename(pkg.id)}.`
      : `Skills from ${slug ?? o.src.repo}, following ${o.src.ref}.`);
  const author =
    o.kind === "own"
      ? compact({ name: lib.owner ?? pkg.id, url: ownerUrl })
      : slug
        ? { name: slug.split("/")[0], url: `https://github.com/${slug.split("/")[0]}` }
        : { name: o.id };
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
    portable: {
      $schema: PLUGIN_SCHEMA,
      name: pkg.id,
      ...(version === null ? {} : { version }),
      ...common,
      extensions: { "com.openai": { interface: iface } },
    },
    legacy: {
      name: pkg.id,
      ...(version === null ? {} : { version }),
      ...common,
      skills: "./skills/",
      interface: iface,
    },
    claude: compact({
      name: pkg.id,
      displayName: pkg.plugin.displayName,
      description,
      author,
      license: pkg.spdx ?? undefined,
      homepage,
      repository,
      keywords,
    }),
  };
}

/** NOTICE.md: where the files came from, at which commit, under which license, and why every copy is marked internal. */
function notice(pkg: Package, config: Config, head: Head, commitOverride?: string): string {
  const lib = config.library ?? {};
  const rendering = hermesPath(config);
  const o = pkg.origin;
  const libraryName = lib.owner && lib.name ? `${lib.owner}/${lib.name}` : (lib.name ?? "the skills library");
  const commitLine =
    o.kind === "own" && commitOverride
      ? commitOverride
      : o.kind === "source"
        ? `${o.commit} (${isoDate(o.date)})`
        : head.commit
          ? `${head.commit} (${isoDate(head.date)})`
          : head.checkout
            ? "a git checkout without a commit yet"
            : "not a git checkout";
  const source =
    o.kind === "own"
      ? `\`skills/${o.group}\` of ${libraryName}${lib.homepage ? ` (${lib.homepage})` : ""}`
      : `${o.src.repo} (ref \`${o.src.ref}\`${o.src.root ? `, skills under \`${o.src.root}\`` : ""})`;
  const license = pkg.license
    ? `${pkg.spdx ?? "see LICENSE"}${pkg.spdx ? ", see LICENSE" : ""}`
    : o.kind === "own"
      ? "no LICENSE file in the library"
      : "no LICENSE among the source's attribution files";
  const renamed = o.kind === "source" ? renamesOf(o.src) : new Map<string, string>();
  const skills = [...pkg.skills.keys()].map((n) => {
    const notes = [
      renamed.has(n) ? `renamed from ${renamed.get(n)}` : "",
      o.kind === "source" && o.perSkill[n] ? `at ${o.perSkill[n]}` : "",
    ].filter(Boolean);
    return notes.length ? `${n} (${notes.join(", ")})` : n;
  });
  return [
    "# NOTICE",
    "",
    `\`${pkg.id}\` is a plugin package built by @oneezy/skills-sync; its files are copies, not the place to edit.`,
    "",
    `- Source: ${source}`,
    `- Version: ${head.version ?? "unversioned upstream"}`,
    `- Commit: ${commitLine}`,
    `- License: ${license}`,
    `- Skills: ${skills.join(", ")}`,
    ...(o.kind === "source" && o.adapted
      ? [
          `- Adapted: ${o.adapted} find/replace rule${o.adapted === 1 ? "" : "s"} from \`sources.${o.id}.adapt\` in skills-sync.json rewrote the Markdown and text files; scripts and every other file are as upstream wrote them`,
        ]
      : []),
    "",
    "Every `SKILL.md` under `skills/` carries `metadata.internal: true`: the library's own copies are the ones `npx skills` installs and updates, and these are skipped (`INSTALL_INTERNAL_SKILLS=1` re-exposes them).",
    "",
    ...(rendering
      ? [
          `Hermes rejects that flag (its portable loader takes only string-valued metadata), so the copy it loads is \`${rendering}/${pkg.id}/\` in the library: this package without the flag and every other non-string metadata entry, each skill's \`name\` set to its folder, and without the Claude Code and Codex manifests. \`hermes plugins install ${lib.owner && lib.name ? `${lib.owner}/${lib.name}` : "<owner>/<repo>"}/${rendering}/${pkg.id}\` installs it; Hermes lists its skills as \`${hermesNamespace(pkg.id)}:<skill>\`.`,
          "",
        ]
      : []),
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
    plugins: ids.map((id) =>
      compact({
        name: id,
        source: `./plugins/${id}`,
        description: description(id),
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: CATEGORY,
      }),
    ),
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
  const i = lines.findIndex((l) => l.startsWith("metadata:"));
  let next: string[];
  if (i < 0) next = [...lines, "metadata:", "  internal: true"];
  else {
    const rest = lines[i].slice("metadata:".length).trim();
    if (rest && !rest.startsWith("#") && rest !== "{}") {
      // a flow map on one line: {a: b} -> {a: b, internal: true}
      const flow = /internal:/.test(rest)
        ? rest.replace(/internal:\s*[^,}]*/, "internal: true")
        : rest.replace(/\s*}$/, (m) => `, internal: true${m}`);
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
 * The SKILL.md Hermes loads, from the package copy. Hermes's portable loader (hermes_cli/agent_plugins.py) skips a skill
 * whose `metadata` holds anything but string values, or whose `name` is not its folder's name; the `skills` CLI needs the
 * boolean `metadata.internal: true` the package copy carries. So the Hermes copy drops `internal` and every other
 * non-string entry of `metadata` (a nested map, a list, a number, a boolean), drops `metadata` when nothing is left, and
 * sets `name` to the folder; every other byte stays. Applying it twice gives the same text, which is what lets --check
 * compare the package after the transform with disk.
 */
export function forHermes(md: string, folder: string): string {
  const fm = /^---(\r?\n)([\s\S]*?)(\r?\n)---/.exec(md);
  if (!fm) return md;
  const [whole, open, body, close] = fm;
  const lines = body.split(open);
  const out: string[] = [];
  let named = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("name:")) {
      out.push(`name: ${folder}`);
      named = true;
      continue;
    }
    if (!l.startsWith("metadata:")) {
      out.push(l);
      continue;
    }
    const rest = l.slice("metadata:".length).trim();
    if (rest && !rest.startsWith("#")) {
      // a flow map on one line: its string entries, or nothing
      const kept = flowStrings(rest);
      if (kept) out.push(`metadata: ${kept}`);
      continue;
    }
    // a block map: the deeper-indented lines that follow are its entries
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++;
    const kept = stringEntries(lines.slice(i + 1, j));
    if (kept.length) out.push("metadata:", ...kept);
    i = j - 1;
  }
  if (!named) out.unshift(`name: ${folder}`);
  return `---${open}${out.join(open)}${close}---` + md.slice(whole.length);
}

/**
 * The lines of a block map's entries whose value is a string: the entry's key line and its continuation lines, as
 * written, comments between them included; nothing when no entry is left (a map of comments alone would read as null).
 */
function stringEntries(children: string[]): string[] {
  const out: string[] = [];
  if (!children.length) return out;
  let entries = 0;
  const indent = /^\s*/.exec(children[0])![0].length;
  for (let k = 0; k < children.length;) {
    const m = /^(\s+)([^\s#][^:]*?):(?:\s+(.*))?$/.exec(children[k]);
    // the entry runs until the next line at its own indent: a nested map, a list or a wrapped scalar belongs to it
    let e = k + 1;
    while (e < children.length && /^\s*/.exec(children[e])![0].length > indent) e++;
    const entry = children.slice(k, e);
    k = e;
    if (!m || m[1].length !== indent) {
      // a comment, or a line that is not an entry: kept as written
      out.push(...entry);
      continue;
    }
    const value = (m[3] ?? "").trim();
    if (m[2] === "internal" || value === "") continue;
    if (/^[|>]/.test(value) || isYamlString(value)) {
      out.push(...entry);
      entries++;
    }
  }
  return entries ? out : [];
}

/** A flow map `{a: b, c: 1}` cut to its string entries, as a flow map again; null when none is left. */
function flowStrings(flow: string): string | null {
  let v: unknown;
  try {
    v = YAML.parse(flow);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>).filter(
    ([k, x]) => k !== "internal" && typeof x === "string",
  );
  return entries.length ? `{ ${entries.map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(", ")} }` : null;
}

/** Does this scalar, as YAML, read as a string (quoted, or a plain scalar that is neither a number, a boolean nor null)? */
function isYamlString(scalar: string): boolean {
  try {
    return typeof YAML.parse(scalar) === "string";
  } catch {
    return false;
  }
}

/**
 * Why Hermes's portable loader would skip this SKILL.md as the skill in folder `folder` (hermes_cli/agent_plugins.py:
 * `name` equal to the folder, 1 to 64 characters of lowercase letters, digits and single hyphens; a `description` of 1
 * to 1024 characters; `metadata`, when present, a map of strings; `license`, `compatibility` and `allowed-tools`
 * strings). Empty when Hermes loads it. The generator notes these; the Hermes form checks an installed copy with them.
 */
export function hermesSkillProblems(md: string, folder: string): string[] {
  const fm = /^---(\r?\n)([\s\S]*?)(\r?\n)---/.exec(md);
  if (!fm) return ["no frontmatter"];
  let v: unknown;
  try {
    v = YAML.parse(fm[2]);
  } catch {
    return ["frontmatter is not YAML"];
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["frontmatter is not a map"];
  const f = v as Record<string, unknown>;
  const out: string[] = [];
  if (f.name !== folder) out.push(`name must be ${folder}`);
  else if (!/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder) || folder.length > 64)
    out.push(`${folder} is not a skill name Hermes accepts (lowercase letters, digits, single hyphens, at most 64)`);
  if (typeof f.description !== "string" || !f.description.trim() || f.description.length > 1024)
    out.push("description must be 1 to 1024 characters");
  if (
    f.metadata !== undefined &&
    (!f.metadata ||
      typeof f.metadata !== "object" ||
      Array.isArray(f.metadata) ||
      Object.values(f.metadata as Record<string, unknown>).some((x) => typeof x !== "string"))
  )
    out.push("metadata must map string keys to string values");
  for (const key of ["license", "compatibility", "allowed-tools"])
    if (f[key] !== undefined && typeof f[key] !== "string") out.push(`${key} must be a string`);
  return out;
}

/**
 * The copy of a skill folder that goes into a package: every file in the package's line endings (see `lf`), the
 * source's adapt rules applied to its text files when it has any (counted per rule), its root SKILL.md marked internal,
 * everything else as it is; a link inside is not copied, with a note.
 */
function skillCopy(
  dir: string,
  report: Report,
  rules: Compiled | null,
): { files: Map<string, Buffer>; counts: number[] } {
  const { files, links } = folderFiles(dir);
  for (const l of links)
    report.add({ kind: "note", path: path.join(dir, l), note: "a link; not copied into the package" });
  const copied = new Map([...files].map(([rel, bytes]) => [rel, lf(bytes)]));
  const { files: out, counts } = rules ? adaptFiles(copied, rules) : { files: copied, counts: [] };
  const md = out.get("SKILL.md");
  if (md) out.set("SKILL.md", Buffer.from(withInternal(md.toString("utf8")), "utf8"));
  return { files: out, counts };
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
 * Keep existing provenance when the inputs still render identically. Squashed and shallow checkouts need not hold
 * the recorded commit. Verify its date when available, and verify old generated hash suffixes during migration.
 * The target version always remains authoritative; a value on disk never chooses or bumps it.
 */
function priorHead(root: string, disk: Map<string, Buffer>, head: Head, own: boolean): Head {
  if (!head.commit) return head;
  const version = diskVersion(disk);
  const v = typeof version === "string" ? plainVersion(version) : null;
  if (!v && version !== undefined) return head;
  const n = own ? /^- Commit: ([0-9a-f]{40}) \(([^)]+)\)$/m.exec(disk.get("NOTICE.md")?.toString("utf8") ?? "") : null;
  const legacy = typeof version === "string" ? VERSION_RE.exec(version) : null;
  if (own && (!n || (legacy && !n[1].startsWith(legacy[2])))) return head;
  const held = n ? git(root, "rev-parse", "--verify", "--quiet", `${n[1]}^{commit}`) : null;
  if (held && n && isoDate(git(root, "log", "-1", "--format=%cI", held)) !== isoDate(n[2])) return head;
  return n ? { ...head, commit: n[1], date: n[2] } : head;
}

/** Writes for files that differ or are missing, deletes for files no longer part of the package (a whole skill folder as one), skips for the rest. */
function reconcile(
  report: Report,
  dir: string,
  disk: Map<string, Buffer>,
  expected: Map<string, Buffer>,
  check: boolean,
): void {
  for (const rel of [...expected.keys()].sort(cmp)) {
    const file = path.join(dir, rel);
    const have = disk.get(rel);
    if (have && asBuilt(have, expected.get(rel)!)) report.add({ kind: "skip", path: file, note: "ok" });
    else
      report.add({
        kind: "write",
        path: file,
        payload: expected.get(rel),
        note: have ? (check ? "differs" : "changed") : check ? "missing" : "new",
      });
  }
  const gone = new Set<string>();
  for (const rel of [...disk.keys()].sort(cmp)) {
    if (expected.has(rel)) continue;
    const m = /^skills\/([^/]+)\//.exec(rel);
    const folder = m && ![...expected.keys()].some((k) => k.startsWith(`skills/${m[1]}/`)) ? `skills/${m[1]}` : rel;
    if (gone.has(folder)) continue;
    gone.add(folder);
    report.add({
      kind: "delete",
      path: path.join(dir, folder),
      note: folder === rel ? "not part of the package" : "skill no longer in the package",
    });
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
export function folderFiles(dir: string): { files: Map<string, Buffer>; links: string[] } {
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
export function lf(b: Buffer): Buffer {
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
