// The plugin form on the harnesses that have one: the library's built plugins (plugins/<id>/, listed in its two catalogs)
// installed on Claude Code and Codex through each harness's own plugin commands. The tool never edits a settings file; the
// harness writes its own while it installs. A plugin's skills lose their loose links on a harness only once that harness lists
// the plugin enabled and resolves one of its skills (verified without a session: no tokens spent). Goose and Hermes have
// no plugins and keep their links. What the tool installed is recorded per harness in the local file, so a rollback
// (sync --links) or unlink removes only its own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDir, isLink, linkTarget, samePath, under, real, hasLinkedParent } from "./fs.js";
import { withInternal } from "./build.js";
import type { Harness } from "./harnesses.js";
import type { Library } from "./library.js";
import type { Report } from "./plan.js";

/** How a harness gets the library's skills: its plugins, or one loose link per skill in its user folder. */
export type Form = "plugin" | "links";

/** What the tool installed on one harness (keyed by the harness's config folder in the local file): plugin ids, its marketplace. */
export interface Owned {
  harness: string;
  marketplace?: string;
  plugins: string[];
}

/** One built plugin as a harness's catalog lists it. */
export interface Built {
  name: string;
  dir: string;
  skills: string[];
}

interface Installed {
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
  /** where the harness reads the plugin from when it reads it in place (Claude Code's directory marketplaces) */
  folder: string | null;
}

interface Run {
  (args: string[]): { ok: boolean; out: string; err: string };
}

interface Driver {
  bin: string;
  /** the catalog this harness installs from, under the library */
  catalog: string;
  /** the file a plugin install writes, named when the harness cannot install through a command */
  settings: (h: Harness) => string;
  marketplaces: (run: Run) => Array<{ name: string; path: string }> | null;
  installed: (run: Run) => Installed[] | null;
  addMarketplace: (run: Run, root: string) => boolean;
  removeMarketplace: (run: Run, name: string) => boolean;
  install: (run: Run, id: string) => boolean;
  uninstall: (run: Run, id: string) => boolean;
  /** the names of the given plugins that resolve at least one of their skills */
  resolving: (run: Run, plugins: Built[], marketplace: string) => Set<string>;
  /** the version this harness would install from the built package */
  built: (lib: Library, b: Built) => string | null;
  /** is the installed plugin the built one? */
  matches: (i: Installed, b: Built, lib: Library) => boolean;
}

/** The JSON a harness printed: the whole output, else from the first line that opens an object or array. */
function json(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    const lines = out.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*[[{]/.test(lines[i])) continue;
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        /* the next candidate */
      }
    }
    return null;
  }
}

function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at < 0 ? { name: id, marketplace: "" } : { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

let headCache: { root: string; sha: string | null } | null = null;
/** The library's HEAD as Claude Code versions a directory marketplace's plugin without a version: 12 hex. */
function head(lib: Library): string | null {
  if (headCache?.root === lib.root) return headCache.sha;
  const r = spawnSync("git", ["-C", lib.root, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" });
  headCache = { root: lib.root, sha: r.status === 0 ? r.stdout.trim() : null };
  return headCache.sha;
}

const claude: Driver = {
  bin: "claude",
  catalog: path.join(".claude-plugin", "marketplace.json"),
  settings: (h) => path.join(h.configDir, "settings.json"),
  marketplaces(run) {
    const r = run(["plugin", "marketplace", "list", "--json"]);
    const v = r.ok ? json(r.out) : null;
    if (!Array.isArray(v)) return null;
    return v
      .map((m) => ({ name: str(m?.name) ?? "", path: str(m?.path) ?? str(m?.installLocation) ?? "" }))
      .filter((m) => m.name);
  },
  installed(run) {
    const r = run(["plugin", "list", "--json"]);
    const v = r.ok ? json(r.out) : null;
    if (!Array.isArray(v)) return null;
    return v
      .filter((p) => str(p?.id))
      .map((p) => ({
        id: p.id,
        ...splitId(p.id),
        version: str(p.version),
        enabled: p.enabled === true,
        folder: str(p.readFromFolder),
      }));
  },
  addMarketplace: (run, root) => run(["plugin", "marketplace", "add", root, "--json"]).ok,
  removeMarketplace: (run, name) => run(["plugin", "marketplace", "remove", name, "--json"]).ok,
  install: (run, id) => run(["plugin", "install", id, "--scope", "user", "--json"]).ok,
  uninstall: (run, id) => run(["plugin", "uninstall", id, "--scope", "user", "--json"]).ok,
  resolving(run, plugins, marketplace) {
    const out = new Set<string>();
    for (const b of plugins) {
      const r = run(["plugin", "details", `${b.name}@${marketplace}`]);
      const m = r.ok ? /^\s*Skills \((\d+)\)\s+(.*)$/m.exec(r.out) : null;
      const listed = m ? m[2].split(",").map((s) => s.trim()) : [];
      if (b.skills.some((s) => listed.includes(s))) out.add(b.name);
    }
    return out;
  },
  built: (lib) => head(lib),
  // a directory marketplace's plugin is read in place: whatever is built is what loads next session
  matches: (i, b, lib) => (i.folder ? samePath(i.folder, b.dir) : i.version !== null && i.version === head(lib)),
};

const codex: Driver = {
  bin: "codex",
  catalog: path.join(".agents", "plugins", "marketplace.json"),
  settings: (h) => path.join(h.configDir, "config.toml"),
  marketplaces(run) {
    const r = run(["plugin", "marketplace", "list", "--json"]);
    const v = (r.ok ? json(r.out) : null) as { marketplaces?: unknown } | null;
    if (!v || !Array.isArray(v.marketplaces)) return null;
    return v.marketplaces
      .map((m) => ({ name: str(m?.name) ?? "", path: str(m?.root) ?? str(m?.marketplaceSource?.source) ?? "" }))
      .filter((m) => m.name);
  },
  installed(run) {
    const r = run(["plugin", "list", "--json"]);
    const v = (r.ok ? json(r.out) : null) as { installed?: unknown } | null;
    if (!v || !Array.isArray(v.installed)) return null;
    return v.installed
      .filter((p) => str(p?.pluginId) && p.installed !== false)
      .map((p) => ({
        id: p.pluginId,
        name: str(p.name) ?? splitId(p.pluginId).name,
        marketplace: str(p.marketplaceName) ?? splitId(p.pluginId).marketplace,
        version: str(p.version),
        enabled: p.enabled === true,
        folder: null,
      }));
  },
  addMarketplace: (run, root) => run(["plugin", "marketplace", "add", root, "--json"]).ok,
  removeMarketplace: (run, name) => run(["plugin", "marketplace", "remove", name, "--json"]).ok,
  install: (run, id) => run(["plugin", "add", id, "--json"]).ok,
  uninstall: (run, id) => run(["plugin", "remove", id, "--json"]).ok,
  resolving(run, plugins) {
    const out = new Set<string>();
    if (!plugins.length) return out;
    // the model-visible prompt input, rendered locally: each loaded plugin skill is listed as <plugin>:<skill>
    const r = run(["debug", "prompt-input"]);
    if (!r.ok) return out;
    for (const b of plugins) if (b.skills.some((s) => r.out.includes(`- ${b.name}:${s}:`))) out.add(b.name);
    return out;
  },
  built(_lib, b) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(b.dir, ".codex-plugin", "plugin.json"), "utf8")).version;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  },
  // Codex loads its cache copy, keyed by the manifest's version: a rebuild needs the plugin added again
  matches: (i, b, lib) => i.version !== null && i.version === codex.built(lib, b),
};

const DRIVERS: Record<string, Driver> = { "claude-code": claude, codex };

/** The harnesses this step can give plugins to. */
export function pluginHarness(h: Harness): boolean {
  return h.id in DRIVERS;
}

export function nativePluginRoute(lib: Library, h: Harness, skill: string): boolean {
  const d = DRIVERS[h.id],
    catalog = readCatalog(lib, h);
  const file = d && which(d.bin);
  return !!file && !!catalog?.plugins.some((item) => item.skills.includes(skill)) && supportsPlugins(runner(file));
}

/** Resolve the exact installed skill, not merely any skill supplied by a matching plugin version. */
export function pluginDependency(
  lib: Library,
  h: Harness,
  skill: string,
  required: string[],
  plan: boolean,
): string | null {
  const d = DRIVERS[h.id];
  const catalog = readCatalog(lib, h);
  const b = catalog?.plugins.find((item) => item.skills.includes(skill));
  const own = lib.scanOwn().skills.find((item) => item.name === skill);
  const file = d && which(d.bin);
  if (!d || !catalog || !b || !own || !file) return null;
  const built = path.join(b.dir, "skills", skill);
  const loose = path.join(h.userSkills, skill);
  if (fs.existsSync(path.join(loose, "SKILL.md")) && !ownLink(lib, loose)) return null;
  const matchesFiles = (dir: string) =>
    ["SKILL.md", ...required].every((name) => {
      const expected =
        name === "SKILL.md"
          ? Buffer.from(withInternal(fs.readFileSync(path.join(own.dir, name), "utf8")))
          : fs.readFileSync(path.join(own.dir, name));
      const target = path.join(dir, name);
      return !isLink(target) && under(real(target), real(dir)) && fs.readFileSync(target).equals(expected);
    });
  try {
    if (hasLinkedParent(built) || !matchesFiles(built)) return null;
    const run = runner(file);
    const market = d.marketplaces(run)?.find((item) => item.name === catalog.marketplace);
    if (market && !samePath(market.path, lib.root)) return null;
    const id = `${b.name}@${catalog.marketplace}`;
    const installed = d.installed(run);
    if (!installed || installed.some((item) => item.name === b.name && item.id !== id)) return null;
    const current = installed.find((item) => item.id === id);
    if (current && !current.enabled) return null;
    if (plan && (!current || !d.matches(current, b, lib))) return built;
    if (!market || !current || !d.matches(current, b, lib)) return null;
    if (h.id === "claude-code") {
      if (!current.folder || !d.resolving(run, [{ ...b, skills: [skill] }], catalog.marketplace).has(b.name))
        return null;
      const dir = path.join(current.folder, "skills", skill);
      return matchesFiles(dir) ? dir : null;
    }
    const prompt = run(["debug", "prompt-input"]);
    if (!prompt.ok) return null;
    const texts: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === "string") texts.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(json(prompt.out) ?? prompt.out);
    for (const line of texts.flatMap((text) => text.split(/\r?\n/))) {
      if (!line.trimStart().startsWith(`- ${b.name}:${skill}:`)) continue;
      const located = /\(file:\s*(.+?)\)\s*$/.exec(line)?.[1];
      if (!located || path.basename(located) !== "SKILL.md") continue;
      const dir = path.dirname(located);
      if (matchesFiles(dir)) return dir;
    }
  } catch {
    /* An unreadable cache or unsupported inventory is a dependency blocker. */
  }
  return null;
}

/** A harness's catalog: the marketplace name and each listed plugin that is built under plugins/, with its skill folders. */
export function readCatalog(lib: Library, h: Harness): { marketplace: string; plugins: Built[] } | null {
  const d = DRIVERS[h.id];
  if (!d) return null;
  let v: { name?: unknown; plugins?: unknown };
  try {
    v = JSON.parse(fs.readFileSync(path.join(lib.root, d.catalog), "utf8"));
  } catch {
    return null;
  }
  if (typeof v.name !== "string" || !v.name || !Array.isArray(v.plugins)) return null;
  const plugins: Built[] = [];
  for (const p of v.plugins) {
    const name = str(p?.name);
    const source = str(p?.source);
    if (!name || !source) continue;
    const dir = path.resolve(lib.root, source);
    if (!under(dir, path.join(lib.root, "plugins")) || !isDir(dir)) continue;
    const skillsDir = path.join(dir, "skills");
    const skills = isDir(skillsDir)
      ? fs
          .readdirSync(skillsDir)
          .filter((n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md")))
          .sort()
      : [];
    if (skills.length) plugins.push({ name, dir, skills });
  }
  return plugins.length ? { marketplace: v.name, plugins } : null;
}

/** A command on PATH, as the OS would find it (PATHEXT on Windows); null when there is none. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = process.platform === "win32";
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (env[key] ?? "").split(path.delimiter).filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs)
    for (const ext of exts) {
      const file = path.join(dir, bin + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        /* not here */
      }
    }
  return null;
}

/** Run a harness CLI with no TTY: a .cmd shim (npm's, on Windows) through the shell, anything else directly. */
function runner(file: string): Run {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const quote = (s: string) => (/[\s&|<>^()%!"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
  return (args) => {
    const r = shell
      ? spawnSync(quote(file), args.map(quote), {
          shell: true,
          encoding: "utf8",
          cwd: os.homedir(),
          input: "",
          timeout: 180_000,
          windowsHide: true,
        })
      : spawnSync(file, args, { encoding: "utf8", cwd: os.homedir(), input: "", timeout: 180_000, windowsHide: true });
    return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "") + (r.error ? r.error.message : "") };
  };
}

/** Does this harness's CLI have plugin commands? Asked through --help only, so an old CLI never starts a session. */
function supportsPlugins(run: Run): boolean {
  const r = run(["plugin", "--help"]);
  return r.ok && /marketplace/.test(r.out + r.err);
}

export interface PluginResult {
  /** per harness id: the skill names whose loose links give way to a verified plugin, and that plugin's id */
  covered: Map<string, Map<string, string>>;
  /** the ownership record, per harness config folder, after this run */
  owned: Record<string, Owned>;
}

/**
 * The plugin step for the selected harnesses. form plugin: install what the catalogs list, verify, and report which skills
 * the plugins now carry. form links: uninstall the plugins this tool installed (the marketplace stays registered). On
 * plan nothing runs but the harnesses' read-only listings.
 */
export function plugins(
  lib: Library,
  harnesses: Harness[],
  form: Form,
  owned: Record<string, Owned>,
  report: Report,
  plan: boolean,
): PluginResult {
  const result: PluginResult = { covered: new Map(), owned: { ...owned } };
  for (const h of harnesses) {
    const d = DRIVERS[h.id];
    if (!d) continue;
    const prior = owned[h.configDir] ?? { harness: h.id, plugins: [] };
    if (form === "links") {
      const next = rollback(h, d, prior, false, report, plan);
      setOwned(result.owned, h.configDir, next);
      continue;
    }
    const catalog = readCatalog(lib, h);
    if (!catalog) continue; // no built plugins: the links are the only form, exactly as before
    const file = which(d.bin);
    if (!file) {
      report.add({ kind: "note", path: h.userSkills, note: `${h.name}: no ${d.bin} on PATH; loose links kept` });
      continue;
    }
    const run = runner(file);
    if (!supportsPlugins(run)) {
      report.add({
        kind: "conflict",
        path: d.settings(h),
        note: `${h.name} blocked: this ${d.bin} has no plugin commands, so installing the plugins would need an edit to ${d.settings(h)}, which skills-sync never makes; loose links kept`,
      });
      continue;
    }
    const covered = install(lib, h, d, run, catalog, prior, report, plan);
    result.covered.set(h.id, covered.skills);
    setOwned(result.owned, h.configDir, covered.owned);
  }
  return result;
}

function setOwned(all: Record<string, Owned>, key: string, o: Owned): void {
  if (!o.plugins.length && !o.marketplace) delete all[key];
  else all[key] = o;
}

function install(
  lib: Library,
  h: Harness,
  d: Driver,
  run: Run,
  catalog: { marketplace: string; plugins: Built[] },
  prior: Owned,
  report: Report,
  plan: boolean,
): { skills: Map<string, string>; owned: Owned } {
  const owned: Owned = { ...prior, harness: h.id, plugins: [...prior.plugins] };
  const skills = new Map<string, string>();
  const mkt = catalog.marketplace;
  const where = (what: string) => `${h.name}: ${what}`;
  const fail = (what: string, why: string) => report.add({ kind: "conflict", path: where(what), note: why });

  const markets = d.marketplaces(run);
  if (!markets) {
    fail(`marketplace ${mkt}`, `${d.bin} could not list its marketplaces; loose links kept`);
    return { skills, owned };
  }
  const existing = markets.find((m) => m.name === mkt);
  if (existing && !(existing.path && samePath(existing.path, lib.root))) {
    fail(
      `marketplace ${mkt}`,
      `already registered from ${existing.path || "another source"}, not this library; left alone, loose links kept`,
    );
    return { skills, owned };
  }
  if (!existing) {
    report.add({ kind: "install", path: where(`marketplace ${mkt}`), target: lib.root });
    if (!plan) {
      if (!d.addMarketplace(run, lib.root)) {
        fail(`marketplace ${mkt}`, `${d.bin} plugin marketplace add failed; loose links kept`);
        return { skills, owned };
      }
      owned.marketplace = mkt;
    }
  }

  const before = d.installed(run) ?? (plan && !existing ? [] : null);
  if (!before) {
    fail(`plugins from ${mkt}`, `${d.bin} could not list its plugins; loose links kept`);
    return { skills, owned };
  }
  const listed = new Set(catalog.plugins.map((b) => `${b.name}@${mkt}`));
  // a plugin this tool installed that the catalog no longer lists is this tool's to remove
  for (const id of prior.plugins.filter((x) => !listed.has(x) && splitId(x).marketplace === mkt)) {
    if (before.some((i) => i.id === id)) {
      report.add({ kind: "uninstall", path: where(`plugin ${id}`), note: "no longer in the library's catalog" });
      if (!plan && !d.uninstall(run, id)) {
        fail(`plugin ${id}`, `${d.bin} could not uninstall it`);
        continue;
      }
    }
    owned.plugins = owned.plugins.filter((x) => x !== id);
  }
  const candidates: Built[] = [];
  const fresh = new Set<string>();
  for (const b of catalog.plugins) {
    const id = `${b.name}@${mkt}`;
    const mine = before.find((i) => i.id === id);
    const other = before.find((i) => i.name === b.name && i.marketplace !== mkt);
    if (other) {
      fail(`plugin ${b.name}`, `already installed as ${other.id}; left alone, loose links kept for its skills`);
      continue;
    }
    if (!mine) {
      report.add({ kind: "install", path: where(`plugin ${id}`), note: d.built(lib, b) ?? undefined });
      if (!plan) {
        if (!d.install(run, id)) {
          fail(`plugin ${id}`, `${d.bin} could not install it; loose links kept`);
          continue;
        }
        if (!owned.plugins.includes(id)) owned.plugins.push(id);
        fresh.add(id);
      }
    } else if (!mine.enabled) {
      fail(`plugin ${id}`, "installed but disabled; left alone, loose links kept");
      continue;
    } else if (!d.matches(mine, b, lib)) {
      report.add({
        kind: "install",
        path: where(`plugin ${id}`),
        note: `${mine.version ?? "no version"} -> ${d.built(lib, b) ?? "built"}`,
      });
      if (!plan && !d.install(run, id)) {
        fail(`plugin ${id}`, `${d.bin} could not reinstall it at the built version`);
        continue;
      }
      fresh.add(id);
    } else report.add({ kind: "skip", path: where(`plugin ${id}`), note: "installed" });
    candidates.push(b);
  }
  if (plan) {
    for (const b of candidates) for (const s of b.skills) skills.set(s, `${b.name}@${mkt}`);
    return { skills, owned };
  }

  // verify before any link goes: listed enabled, and one skill resolving. A plugin already in place whose skills hold
  // no loose link of this tool's has nothing left to unlink, so it is not asked again on every run
  const after = d.installed(run) ?? [];
  const enabled = candidates.filter((b) => after.some((i) => i.id === `${b.name}@${mkt}` && i.enabled));
  const toAsk = enabled.filter(
    (b) => fresh.has(`${b.name}@${mkt}`) || b.skills.some((s) => ownLink(lib, path.join(h.userSkills, s))),
  );
  const resolving = d.resolving(run, toAsk, mkt);
  for (const b of candidates) {
    const id = `${b.name}@${mkt}`;
    const ok = enabled.includes(b) && (!toAsk.includes(b) || resolving.has(b.name));
    if (!ok) {
      fail(
        `plugin ${id}`,
        `installed but not verified (${enabled.includes(b) ? `none of its skills resolves in ${d.bin}` : `${d.bin} does not list it enabled`}); loose links kept`,
      );
      continue;
    }
    for (const s of b.skills) skills.set(s, id);
  }
  return { skills, owned };
}

function ownLink(lib: Library, p: string): boolean {
  if (!isLink(p)) return false;
  const t = linkTarget(p);
  return !!t && under(t, lib.root);
}

/**
 * Uninstall the plugins this tool installed on one harness; with `marketplace`, the marketplace it registered too (unlink).
 * A plugin no longer installed just leaves the record. Returns the record after.
 */
function rollback(h: Harness, d: Driver, prior: Owned, marketplace: boolean, report: Report, plan: boolean): Owned {
  const owned: Owned = { ...prior, plugins: [...prior.plugins] };
  if (!owned.plugins.length && !(marketplace && owned.marketplace)) return owned;
  const where = (what: string) => `${h.name}: ${what}`;
  const file = which(d.bin);
  if (!file) {
    report.add({
      kind: "conflict",
      path: where(owned.plugins.join(", ") || `marketplace ${owned.marketplace}`),
      note: `installed by skills-sync, but no ${d.bin} on PATH to remove it`,
    });
    return owned;
  }
  const run = runner(file);
  const installed = d.installed(run);
  if (!installed) {
    report.add({ kind: "conflict", path: where("plugins"), note: `${d.bin} could not list its plugins; left alone` });
    return owned;
  }
  for (const id of prior.plugins) {
    if (installed.some((i) => i.id === id)) {
      report.add({ kind: "uninstall", path: where(`plugin ${id}`), note: "installed by skills-sync" });
      if (plan) continue;
      if (!d.uninstall(run, id)) {
        report.add({ kind: "conflict", path: where(`plugin ${id}`), note: `${d.bin} could not uninstall it` });
        continue;
      }
    }
    if (!plan) owned.plugins = owned.plugins.filter((x) => x !== id);
  }
  if (marketplace && owned.marketplace) {
    const m = owned.marketplace;
    if (d.marketplaces(run)?.some((x) => x.name === m)) {
      report.add({ kind: "uninstall", path: where(`marketplace ${m}`), note: "registered by skills-sync" });
      if (!plan) {
        if (d.removeMarketplace(run, m)) delete owned.marketplace;
        else report.add({ kind: "conflict", path: where(`marketplace ${m}`), note: `${d.bin} could not remove it` });
      }
    } else if (!plan) delete owned.marketplace;
  }
  return owned;
}

/** unlink's half: every plugin and marketplace this tool installed on the given harnesses, removed. */
export function removeOwned(
  harnesses: Harness[],
  owned: Record<string, Owned>,
  report: Report,
  plan: boolean,
): Record<string, Owned> {
  const next = { ...owned };
  for (const h of harnesses) {
    const d = DRIVERS[h.id];
    const prior = owned[h.configDir];
    if (!d || !prior) continue;
    setOwned(next, h.configDir, rollback(h, d, prior, true, report, plan));
  }
  return next;
}

export interface HarnessForm {
  form: Form;
  /** why the harness is on links when it could have plugins: no CLI, no plugin commands, nothing built */
  note?: string;
  plugins: Array<{
    name: string;
    id: string;
    installed: string | null;
    built: string | null;
    enabled: boolean;
    match: boolean;
    owned: boolean;
  }>;
}

/** status: per harness, which form is active and, per built plugin, the installed and built versions. Reads only. */
export function pluginStatus(
  lib: Library,
  harnesses: Harness[],
  owned: Record<string, Owned>,
): Record<string, HarnessForm> {
  const out: Record<string, HarnessForm> = {};
  for (const h of harnesses) {
    const d = DRIVERS[h.id];
    if (!d) {
      out[h.id] = { form: "links", note: "no plugin support", plugins: [] };
      continue;
    }
    const catalog = readCatalog(lib, h);
    if (!catalog) {
      out[h.id] = { form: "links", note: "the library has no built plugins", plugins: [] };
      continue;
    }
    const file = which(d.bin);
    if (!file) {
      out[h.id] = { form: "links", note: `no ${d.bin} on PATH`, plugins: [] };
      continue;
    }
    const run = runner(file);
    const installed = supportsPlugins(run) ? d.installed(run) : null;
    if (!installed) {
      out[h.id] = { form: "links", note: `${d.bin} cannot list plugins`, plugins: [] };
      continue;
    }
    const mine = owned[h.configDir]?.plugins ?? [];
    const plugins = catalog.plugins.map((b) => {
      const id = `${b.name}@${catalog.marketplace}`;
      const i = installed.find((x) => x.id === id);
      return {
        name: b.name,
        id,
        installed: i ? (i.version ?? "") : null,
        built: d.built(lib, b),
        enabled: !!i?.enabled,
        match: !!i && d.matches(i, b, lib),
        owned: mine.includes(id),
      };
    });
    out[h.id] = { form: plugins.some((p) => p.enabled) ? "plugin" : "links", plugins };
  }
  return out;
}
