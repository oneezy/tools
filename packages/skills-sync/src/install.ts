// The harnesses' plugin CLIs (claude, codex): one driver per harness with the read-only listings the probe asks for
// (plugins, marketplaces, Codex's loaded skills) and the plugin commands the forms and unlink run (install, uninstall,
// marketplace add, remove and upgrade), each through the harness's own command, never a settings edit by this tool.
// pluginDependency serves migrate-aliases, which still verifies a plugin's copy of a skill from a checkout before it
// retires an alias.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { isDir, isLink, linkTarget, samePath, under, real, hasLinkedParent } from "./fs.js";
import { withInternal } from "./build.js";
import type { Harness } from "./harnesses.js";
import type { Library } from "./library.js";
import type { Action } from "./plan.js";
import { compareVersions } from "./versions.js";

/** One built plugin as a harness's catalog lists it. */
export interface Built {
  name: string;
  dir: string;
  skills: string[];
}

/** One plugin a harness lists as installed, whatever installed it. */
export interface Installed {
  id: string;
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
  /** where the harness reads the plugin from when it reads it in place (Claude Code's directory marketplaces) */
  folder: string | null;
  readInPlace?: boolean;
  /** Claude Code: "user" for a CLI install, "synced" for an account plugin claude.ai delivered */
  scope?: string;
}

/** One marketplace a harness has registered: where it reads it from, and the source it was added from. */
export interface Marketplace {
  name: string;
  /** the folder the harness reads the catalog from (a Git snapshot under its config folder, or the local folder itself) */
  root: string | null;
  /** Codex: "git" for owner/repo or a Git URL, "local" for a folder; Claude Code: its source kind; null when unsaid */
  sourceType: string | null;
  /** the Git URL or local folder it was added from; null when unsaid */
  source: string | null;
}

export interface Run {
  (args: string[]): { ok: boolean; out: string; err: string; exitCode: number | null };
  failure?: Action["diagnostic"];
  resolutionFailures?: Map<string, Action["diagnostic"]>;
}

// Ask each write command's help once; older Claude versions support listings' --json but not writes'.
const jsonCapabilities = new WeakMap<Run, Map<string, boolean>>();
function claudeWrite(run: Run, command: string[], args: string[]): boolean {
  const capabilities = jsonCapabilities.get(run) ?? new Map<string, boolean>();
  jsonCapabilities.set(run, capabilities);
  const key = command.join(" ");
  if (!capabilities.has(key)) {
    const help = run([...command, "--help"]);
    if (!help.ok) return false;
    capabilities.set(key, /(?:^|\s)--json(?:\s|,|$)/m.test(help.out + help.err));
  }
  return run([...command, ...args, ...(capabilities.get(key) ? ["--json"] : [])]).ok;
}

interface Driver {
  bin: string;
  /** the catalog this harness installs from, under the library */
  catalog: string;
  /** the file a plugin install writes, named when the harness cannot install through a command */
  settings: (h: Harness) => string;
  marketplaces: (run: Run) => Marketplace[] | null;
  installed: (run: Run) => Installed[] | null;
  /** register a marketplace from a local folder (or, Codex, owner/repo on GitHub); null when the command failed */
  addMarketplace: (run: Run, source: string) => MarketplaceAdded | null;
  removeMarketplace: (run: Run, name: string) => boolean;
  /** Codex: refresh a Git marketplace's snapshot and reinstall its plugins; the errors it reported, null when it failed */
  upgradeMarketplace?: (run: Run, name: string) => { errors: string[] } | null;
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
      .map((m) => {
        const root = str(m?.path) ?? str(m?.installLocation);
        return {
          name: str(m?.name) ?? "",
          root,
          sourceType: str(m?.source) ?? str(m?.source?.source),
          source: str(m?.source?.repo) ?? str(m?.source?.url) ?? str(m?.source?.path) ?? root,
        };
      })
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
        folder: str(p.readFromFolder) ?? str(p.installPath),
        readInPlace: !!str(p.readFromFolder),
        ...(str(p.scope) ? { scope: p.scope as string } : {}),
      }));
  },
  addMarketplace: (run, root) =>
    claudeWrite(run, ["plugin", "marketplace", "add"], [root]) ? { name: null, alreadyAdded: false } : null,
  removeMarketplace: (run, name) => claudeWrite(run, ["plugin", "marketplace", "remove"], [name]),
  install: (run, id) => claudeWrite(run, ["plugin", "install"], [id, "--scope", "user"]),
  uninstall: (run, id) => claudeWrite(run, ["plugin", "uninstall"], [id, "--scope", "user"]),
  resolving(run, plugins, marketplace) {
    const out = new Set<string>();
    run.resolutionFailures = new Map();
    for (const b of plugins) {
      const r = run(["plugin", "details", `${b.name}@${marketplace}`]);
      if (run.failure) run.resolutionFailures.set(b.name, run.failure);
      const m = r.ok ? /^\s*Skills \((\d+)\)\s+(.*)$/m.exec(r.out) : null;
      const listed = m ? m[2].split(",").map((s) => s.trim()) : [];
      if (b.skills.some((s) => listed.includes(s))) out.add(b.name);
    }
    return out;
  },
  built: (lib) => head(lib),
  // a directory marketplace's plugin is read in place: whatever is built is what loads next session
  matches: (i, b, lib) =>
    i.readInPlace ? !!i.folder && samePath(i.folder, b.dir) : i.version !== null && i.version === head(lib),
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
      .map((m) => ({
        name: str(m?.name) ?? "",
        root: str(m?.root),
        sourceType: str(m?.marketplaceSource?.sourceType),
        source: str(m?.marketplaceSource?.source),
      }))
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
  addMarketplace: codexMarketplaceAdd,
  removeMarketplace: (run, name) => run(["plugin", "marketplace", "remove", name, "--json"]).ok,
  upgradeMarketplace: codexMarketplaceUpgrade,
  install: (run, id) => run(["plugin", "add", id, "--json"]).ok,
  uninstall: (run, id) => run(["plugin", "remove", id, "--json"]).ok,
  resolving(run, plugins) {
    const out = new Set<string>();
    run.resolutionFailures = new Map();
    if (!plugins.length) return out;
    // the model-visible prompt input, rendered locally: each loaded plugin skill is listed as <plugin>:<skill>
    const r = run(["debug", "prompt-input"]);
    if (!r.ok) {
      for (const b of plugins) if (run.failure) run.resolutionFailures.set(b.name, run.failure);
      return out;
    }
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

/** A user plugin as `hermes plugins list --json --no-bundled` prints it. */
export interface HermesListed {
  name: string;
  /** enabled, disabled, or not enabled */
  status: string;
  version: string | null;
  /** `git pinned@<sha8>` for a --ref install, the catalog annotation, else user or git */
  source: string | null;
}

/**
 * Hermes's plugin commands (`hermes plugins ...`), through the same runner. Hermes has no marketplace: a plugin is
 * installed straight from a GitHub repository path (`owner/repo/sub/dir`), pinned to a commit with --ref (a full sha),
 * switched on with `enable` (plugins.enabled in config.yaml), moved with `install --force --ref` (`hermes plugins update`
 * refuses a pinned install, so there is no update here) and dropped with `remove` (for `unlink`, tools#154).
 * `list --json --no-bundled` is the harness's own view of its user plugins. Nothing here is a Driver: the old
 * library-based plugin step never serves Hermes.
 */
export const hermes = {
  bin: "hermes",
  /** does this hermes have plugin commands? asked through --help only */
  supports(run: Run): boolean {
    const r = run(["plugins", "--help"]);
    return r.ok && /install/.test(r.out + r.err);
  },
  list(run: Run): HermesListed[] | null {
    const r = run(["plugins", "list", "--json", "--no-bundled"]);
    const v = r.ok ? json(r.out) : null;
    if (!Array.isArray(v)) return null;
    return v
      .filter((p) => str(p?.name))
      .map((p) => ({
        name: p.name as string,
        status: str(p.status) ?? "not enabled",
        // the CLI prints manifest.get("version", "") (older builds str(None)) for a manifest without a version
        version: str(p.version) && p.version !== "None" ? (p.version as string) : null,
        source: str(p.source),
      }));
  },
  /**
   * --no-enable: the enable is a step of its own, so a failed one is told apart. --force replaces an install and answers
   * a `caution` from Hermes's security scan (a `dangerous` one it never gets past); the form passes it for the library's
   * own plugins only. `scan` is the verdict Hermes printed when it was not clean (it prints one only when the scan stops
   * the install; a caution --force answers is silent), and `output` what Hermes printed (redacted as a failure's
   * diagnostic is), the scan's findings with it.
   */
  install(
    run: Run,
    identifier: string,
    options: { ref?: string; force?: boolean } = {},
  ): { ok: boolean; scan: HermesScan | null; output: NonNullable<Action["diagnostic"]> } {
    const args = [
      "plugins",
      "install",
      identifier,
      "--no-enable",
      ...(options.ref ? ["--ref", options.ref] : []),
      ...(options.force ? ["--force"] : []),
    ];
    const r = run(args);
    const output = run.failure ?? {
      command: [hermes.bin, ...args],
      exitCode: r.exitCode,
      stdout: redact(r.out),
      stderr: redact(r.err),
    };
    return { ok: r.ok, scan: scanVerdict(`${r.out}\n${r.err}`), output };
  },
  enable: (run: Run, name: string) => run(["plugins", "enable", name]).ok,
  remove: (run: Run, name: string) => run(["plugins", "remove", name]).ok,
};

/** A verdict of Hermes's install-time security scan that is not clean: `caution` asks to confirm, `dangerous` blocks. */
export type HermesScan = "caution" | "dangerous";

/**
 * The verdict of Hermes's security scan in what `hermes plugins install` printed, when it was not clean; null for a
 * clean scan or none. Hermes (hermes_cli/plugins_cmd_install.py, tools/plugin_guard.py, tools/skills_guard.py) prints
 * it only when the scan stops the install: the report's head line `Scan: <name> (<identifier>/community)  Verdict:
 * CAUTION` (or `DANGEROUS`), and the refusal `Blocked: Security scan blocked plugin install: Requires confirmation
 * (caution verdict, <n> findings)` or `... Blocked (dangerous verdict, ...). --force does not override a dangerous
 * verdict.`, all on stdout, exit 1. A caution that --force answers passes in silence (a log line, nothing printed), so
 * a successful --force install reads null here. Rich wraps at 80 columns when stdout is not a terminal, so a line
 * break may sit inside either phrase; colour codes (FORCE_COLOR) are taken out first. Hermes records no verdict in its
 * files, so this output is the only place it shows.
 */
export function scanVerdict(text: string): HermesScan | null {
  const plain = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const m = /\bVerdict:\s+(CAUTION|DANGEROUS)\b/i.exec(plain) ?? /\b(caution|dangerous)\s+verdict\b/i.exec(plain);
  return m ? (m[1].toLowerCase() as HermesScan) : null;
}

/** The plugin CLI of a harness that has one: its name, and where PATH has it (null when it is not installed). */
export function harnessCli(
  h: Harness,
  env: NodeJS.ProcessEnv = process.env,
): { bin: string; file: string | null } | null {
  const bin = DRIVERS[h.id]?.bin ?? (h.id === "hermes" ? hermes.bin : null);
  return bin ? { bin, file: which(bin, env) } : null;
}

/** What the harness lists as installed, account plugins included; null when it cannot list. */
export function listInstalled(h: Harness, run: Run): Installed[] | null {
  return DRIVERS[h.id]?.installed(run) ?? null;
}

/**
 * The plugin command behind `a` was refused: the action becomes the failure, with the CLI's own words attached
 * (`run.failure`, the last command's stderr and exit code), so one line says what happened to that plugin.
 */
export function refused(a: Action, run: Run, note: string): void {
  a.kind = "conflict";
  a.failed = true;
  a.note = note;
  a.diagnostic = run.failure;
}

/**
 * Codex: the skills each enabled plugin loads, from the model-visible prompt input rendered locally (one line per
 * plugin skill, `- <plugin>:<skill>: ...`); null when Codex cannot render it. No session starts, no tokens are spent.
 */
export function codexPluginSkills(run: Run): Map<string, string[]> | null {
  const r = run(["debug", "prompt-input"]);
  if (!r.ok) return null;
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(json(r.out) ?? r.out);
  const out = new Map<string, string[]>();
  for (const line of texts.flatMap((t) => t.split(/\r?\n/))) {
    const m = /^\s*- ([^\s:`]+):([^\s:`]+):/.exec(line);
    if (!m) continue;
    const list = out.get(m[1]) ?? [];
    if (!list.includes(m[2])) list.push(m[2]);
    out.set(m[1], list.sort());
  }
  return out;
}

/**
 * Codex: the skills an enabled plugin <id>@<marketplace> loads, from the prompt input (`prompted`, what
 * codexPluginSkills read for it) and the copy Codex runs: a user-only skill is loaded but never in the prompt input.
 */
export function codexLoadedSkills(codexHome: string, marketplace: string, id: string, prompted: string[]): string[] {
  return [...new Set([...prompted, ...codexUserOnlySkills(codexHome, marketplace, id)])].sort();
}

/**
 * Codex: the user-only skills of the plugin <id>@<marketplace>, read from the copy Codex runs,
 * <codexHome>/plugins/cache/<marketplace>/<id>/<version>/skills/: each skill folder with a SKILL.md whose
 * agents/openai.yaml sets policy.allow_implicit_invocation to false (the library's form of disable-model-invocation,
 * which Codex itself does not read). Codex loads such a skill and runs it when the user names it ($name, or the $ and
 * /skills pickers), but keeps it out of the model's skill list, so the prompt input never shows it. The version folder
 * is the one Codex picks: `local` when present, else the highest. [] when the plugin has no copy there, or when the
 * marketplace or id is not one folder name (an empty marketplace would make path.join read another plugin's folder).
 */
export function codexUserOnlySkills(codexHome: string, marketplace: string, id: string): string[] {
  if (!codexSegment(marketplace) || !codexSegment(id)) return [];
  const base = path.join(codexHome, "plugins", "cache", marketplace, id);
  let versions: string[];
  try {
    versions = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && codexSegment(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  if (!versions.length) return [];
  const version = versions.includes("local") ? "local" : versions.sort(compareVersions)[versions.length - 1];
  const skills = path.join(base, version, "skills");
  if (!isDir(skills)) return [];
  return fs
    .readdirSync(skills)
    .filter((s) => fs.existsSync(path.join(skills, s, "SKILL.md")) && userOnly(path.join(skills, s)))
    .sort();
}

/** One folder name as Codex accepts a plugin version (and so a cache segment): ASCII letters, digits, `.+_-`, not `.`/`..`. */
function codexSegment(s: string): boolean {
  return /^[A-Za-z0-9._+-]+$/.test(s) && s !== "." && s !== "..";
}

/** Does the skill's agents/openai.yaml set policy.allow_implicit_invocation to false. */
function userOnly(dir: string): boolean {
  try {
    const v: unknown = YAML.parse(fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf8"));
    const policy = v && typeof v === "object" ? (v as { policy?: unknown }).policy : null;
    return (
      !!policy && typeof policy === "object" && (policy as Record<string, unknown>).allow_implicit_invocation === false
    );
  } catch {
    return false;
  }
}

/**
 * What a marketplace add answered: the name the harness gave the marketplace (Codex says it; Claude Code does not) and
 * whether it was registered from that source already (Codex: `alreadyAdded`, exit 0, nothing changed).
 */
export interface MarketplaceAdded {
  name: string | null;
  alreadyAdded: boolean;
}

/** `codex plugin marketplace add <source> --json`: its answer when it worked, null when it failed (run.failure says why). */
function codexMarketplaceAdd(run: Run, source: string): MarketplaceAdded | null {
  const r = run(["plugin", "marketplace", "add", source, "--json"]);
  if (!r.ok) return null;
  const v = json(r.out) as { marketplaceName?: unknown; alreadyAdded?: unknown } | null;
  return { name: str(v?.marketplaceName), alreadyAdded: v?.alreadyAdded === true };
}

/**
 * `codex plugin marketplace upgrade <name> --json`: refreshes a Git marketplace's snapshot when the remote moved and
 * force-reinstalls every plugin installed from it (the first upgrade after an add reinstalls even when nothing moved).
 * The errors it reported, as strings; null when the command failed (run.failure says why).
 */
function codexMarketplaceUpgrade(run: Run, name: string): { errors: string[] } | null {
  const r = run(["plugin", "marketplace", "upgrade", name, "--json"]);
  if (!r.ok) return null;
  const v = json(r.out) as { errors?: unknown } | null;
  const errors = Array.isArray(v?.errors) ? v.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e))) : [];
  return { errors };
}

/** The marketplaces the harness's CLI lists; null when it cannot list them. */
export function listMarketplaces(h: Harness, run: Run): Marketplace[] | null {
  return DRIVERS[h.id]?.marketplaces(run) ?? null;
}

/**
 * Register a marketplace from `source`: a local folder, or for Codex `owner/repo` on GitHub (and a Git URL). Null when the
 * command failed (run.failure holds the diagnostic) or the harness has no driver.
 */
export function addMarketplace(h: Harness, run: Run, source: string): MarketplaceAdded | null {
  return DRIVERS[h.id]?.addMarketplace(run, source) ?? null;
}

/** Unregister a marketplace by name. Codex keeps the plugins installed from it; Claude Code uninstalls them with it. */
export function removeMarketplace(h: Harness, run: Run, name: string): boolean {
  return DRIVERS[h.id]?.removeMarketplace(run, name) ?? false;
}

/**
 * Upgrade a marketplace (Codex: refresh its Git snapshot and reinstall its plugins). The errors the command reported;
 * null when it failed, or for a harness without the command.
 */
export function upgradeMarketplace(h: Harness, run: Run, name: string): { errors: string[] } | null {
  return DRIVERS[h.id]?.upgradeMarketplace?.(run, name) ?? null;
}

/** Install `<id>@<marketplace>` through the harness's CLI (Codex's add is idempotent). False when the command failed. */
export function installPlugin(h: Harness, run: Run, id: string): boolean {
  return DRIVERS[h.id]?.install(run, id) ?? false;
}

/** Uninstall one plugin (<id>@<marketplace>) through the harness's own command; false when it refused (run.failure says why). */
export function uninstallPlugin(h: Harness, run: Run, id: string): boolean {
  return DRIVERS[h.id]?.uninstall(run, id) ?? false;
}

/** Resolve the exact installed skill, not merely any skill supplied by a matching plugin version. */
export function pluginDependency(
  lib: Library,
  h: Harness,
  skill: string,
  required: string[],
  plan: boolean,
  expectedLooseTarget?: string,
  onFailure?: (diagnostic: NonNullable<Action["diagnostic"]>) => void,
): string | null {
  const d = DRIVERS[h.id];
  const catalog = readCatalog(lib, h);
  const b = catalog?.plugins.find((item) => item.skills.includes(skill));
  const own = lib.scanOwn().skills.find((item) => item.name === skill);
  const file = d && which(d.bin);
  if (!d || !catalog || !b || !own || !file) return null;
  const built = path.join(b.dir, "skills", skill);
  const loose = path.join(h.userSkills, skill);
  if (
    fs.existsSync(path.join(loose, "SKILL.md")) &&
    !ownLink(lib, loose) &&
    !(expectedLooseTarget && isLink(loose) && samePath(linkTarget(loose) ?? "", expectedLooseTarget))
  )
    return null;
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
    const run = runner(file, onFailure);
    const market = d.marketplaces(run)?.find((item) => item.name === catalog.marketplace);
    if (market && !(market.root && samePath(market.root, lib.root))) return null;
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
    const lines = texts.flatMap((text) => text.split(/\r?\n/));
    const roots = new Map<string, string>();
    for (const line of lines) {
      const alias = /^\s*- `(r\d+)` = `(.+)`\s*$/.exec(line);
      if (alias && path.isAbsolute(alias[2])) roots.set(alias[1], alias[2]);
    }
    for (const line of lines) {
      if (!line.trimStart().startsWith(`- ${b.name}:${skill}:`)) continue;
      let located = /\(file:\s*(.+?)\)\s*$/.exec(line)?.[1];
      if (!located) continue;
      if (!path.isAbsolute(located)) {
        const alias = /^(r\d+)[/\\](.+)$/.exec(located);
        const root = alias && roots.get(alias[1]);
        if (!root || !alias) continue;
        located = path.resolve(root, alias[2]);
        if (!under(located, root)) continue;
      }
      if (path.basename(located) !== "SKILL.md") continue;
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

/**
 * Run a harness CLI with no TTY: a .cmd shim (npm's, on Windows) through the shell, anything else directly. The shell
 * gets one command line, quoted here for cmd.exe, never an args array: Node warns on stderr (DEP0190) for that pair, and
 * a sync must print nothing it did not mean to.
 */
export function runner(file: string, onFailure?: (diagnostic: NonNullable<Action["diagnostic"]>) => void): Run {
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
  const quote = (s: string) => (/[\s&|<>^()%!"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
  const run: Run = (args) => {
    const r = shell
      ? spawnSync([file, ...args].map(quote).join(" "), {
          shell: true,
          encoding: "utf8",
          cwd: os.homedir(),
          input: "",
          timeout: 180_000,
          windowsHide: true,
        })
      : spawnSync(file, args, { encoding: "utf8", cwd: os.homedir(), input: "", timeout: 180_000, windowsHide: true });
    const result = {
      ok: r.status === 0,
      out: r.stdout ?? "",
      err: (r.stderr ?? "") + (r.error ? r.error.message : ""),
      exitCode: r.status,
    };
    run.failure = result.ok
      ? undefined
      : {
          command: [file, ...args].map(redact),
          exitCode: result.exitCode,
          stdout: redact(result.out),
          stderr: redact(result.err),
        };
    if (run.failure) onFailure?.(run.failure);
    return result;
  };
  return run;
}

/** A CLI's output with the credentials a clone URL or an auth header can carry taken out. */
function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+@/g, "$1[redacted]@").replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
}

/** Does this harness's CLI have plugin commands? Asked through --help only, so an old CLI never starts a session. */
export function supportsPlugins(run: Run): boolean {
  const r = run(["plugin", "--help"]);
  return r.ok && /marketplace/.test(r.out + r.err);
}

function ownLink(lib: Library, p: string): boolean {
  if (!isLink(p)) return false;
  const t = linkTarget(p);
  return !!t && under(t, lib.root);
}
