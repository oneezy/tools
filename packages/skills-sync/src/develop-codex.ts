// The Codex Harness adapter of develop setup (tools#214). Codex has no project install: a plugin lives once in the
// user's Codex (~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/, a copy made by `codex plugin add`) and is
// switched per project by a trusted project's .codex/config.toml, which Codex lays over the user's config.toml. So:
//
// - The Library's Development builds are a marketplace of their own, `<release marketplace>-dev`, whose catalog is
//   <library>/dist/development/.agents/plugins/marketplace.json, registered once with `codex plugin marketplace add`.
// - Each selected Plugin is added from it (`codex plugin add <id>@<dev>`), which copies the build into Codex's cache.
//   An add also switches the copy on in the user config.toml, for every project (codex-cli 0.163.0, observed), so right
//   after each add the adapter switches it off there again, checks that, and removes the copy when it cannot. Between
//   the add and that write the development copy is on everywhere: an open decision for Justin (tools#214), kept short.
// - The project's .codex/config.toml gets a marked block that switches the development copy on and every same-name copy
//   from another configured marketplace (the released one) off, written last, once the copies are in place. It merges
//   with `pnpm skills:dev`'s block (develop.ts) instead of repeating a key that block already holds.
// - A rebuild reaches Codex only through another add, and a running Codex keeps what it loaded: the ChatGPT desktop
//   app needs a restart, a CLI a new session. Setup and status say which is needed.
//
// Same-name copies Codex lists from the ChatGPT account or a workspace are not switched: OpenAI documents that a project
// cannot override a workspace-managed plugin, so setup refuses activation while one is on. The adapter stays unverified
// until Codex in the ChatGPT desktop app on Windows proves it (tools#217); a test switches it on. The decision and the
// open question are docs/adr/0007.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CATEGORY, folderFiles, marketplaceName } from "./build.js";
import { isAccountMarketplace } from "./chatgpt.js";
import { developmentMarketplaceOf } from "./desired.js";
import {
  PLUGINS_END,
  PLUGINS_START,
  SKILLS_DEV_END,
  SKILLS_DEV_START,
  blockIn,
  disabledIn,
  pluginSwitches,
  trustedProjects,
  withBlock,
  withoutBlock,
} from "./codex-toml.js";
import { developmentDirs, digest, readDevelopmentStatus } from "./develop-build.js";
import {
  readProjects,
  readRecord,
  type AdapterContext,
  type AdapterResult,
  type HarnessAdapter,
} from "./develop-project.js";
import { hasLinkedParent, isDir, isLink, lexists, real, samePath, toHash, under } from "./fs.js";
import { harnessTable, type Harness } from "./harnesses.js";
import {
  addMarketplace,
  codexPluginSkills,
  installPlugin,
  listAll,
  listMarketplaces,
  promptedSkills,
  removeMarketplace,
  runner,
  uninstallPlugin,
  which,
  type Installed,
  type Run,
} from "./install.js";
import type { Library } from "./library.js";
import { apply, Report, type Action } from "./plan.js";
import { cmp, readConfig } from "./sources.js";

/** What the Codex adapter owns in one project, kept as record.harnesses.codex. */
export interface CodexOwned {
  version: 1;
  /** the development marketplace's name */
  marketplace: string;
  /** the project's .codex/config.toml */
  config: string;
  /** the block setup wrote there, exactly: remove takes it back only while it still reads so */
  block: string;
  /** whether setup made the file and its .codex folder */
  created: { file: boolean; dir: boolean };
  /** the Plugins this project loads from the development marketplace */
  plugins: string[];
  /** the same-name copies the block switches off (<name>@<marketplace>) */
  disabled: string[];
  /** the same-name copies `pnpm skills:dev`'s block switches off already, so this block leaves them out */
  covered: string[];
}

export interface CodexAdapterOptions {
  /** the codex executable; null for none; default: codex on the PATH of `env` */
  codex?: string | null;
  /** the environment codex runs with, over this process's (CODEX_HOME among it) */
  env?: NodeJS.ProcessEnv;
  /** default false: ADAPTERS passes testSwitch("codex"), which only a test turns on */
  verified?: boolean;
}

/**
 * The Codex adapter. Unverified unless a test switches it on: Codex in the ChatGPT desktop app on Windows has not yet
 * proved project precedence, refresh and restart (tools#217). Construction reads nothing; codex is found on first use.
 */
export function codexAdapter(options: CodexAdapterOptions = {}): HarnessAdapter {
  return {
    harness: "codex",
    verified: options.verified ?? false,
    excludes: ["/.codex/config.toml"],
    setup: (ctx) => setup(resolve(options), ctx),
    remove: (ctx) => remove(resolve(options), ctx),
    status: (ctx) => status(resolve(options), ctx),
  };
}

interface Resolved {
  file: string | null;
  env: NodeJS.ProcessEnv;
  harness: Harness;
  /** <CODEX_HOME>/config.toml */
  userConfig: string;
}

function resolve(options: CodexAdapterOptions): Resolved {
  const env = { ...process.env, ...options.env };
  const harness = harnessTable(os.homedir(), env).find((h) => h.id === "codex")!;
  return {
    file: options.codex === undefined ? which("codex", env) : options.codex,
    env: options.env ?? {},
    harness,
    userConfig: path.join(harness.configDir, "config.toml"),
  };
}

/** The development marketplace's name: the release marketplace's (as build names it) with -dev. */
export function developmentMarketplace(lib: Library): string {
  return developmentMarketplaceOf(marketplaceName(readConfig(lib.configFile), lib), "codex")!;
}

/** The development marketplace's Codex catalog, inside the Development output. */
export function developmentCatalog(lib: Library): string {
  return path.join(developmentDirs(lib).output, ".agents", "plugins", "marketplace.json");
}

/** The block for a project: its development copies on, the same-name copies from elsewhere off. */
function blockText(on: string[], off: string[]): string {
  const table = (id: string, enabled: boolean) => `[plugins.${JSON.stringify(id)}]\nenabled = ${enabled}\n`;
  return [
    PLUGINS_START,
    "# Development Plugins for this project: skills-sync develop setup wrote this block; develop remove takes it back.",
    [...on.map((id) => table(id, true)), ...off.map((id) => table(id, false))].join("\n") + PLUGINS_END,
  ].join("\n");
}

/** A previous owned value, checked; null for none; an error when it is not one this adapter wrote. */
function ownedOf(v: unknown): { owned: CodexOwned | null; error: string | null } {
  if (v === null || v === undefined) return { owned: null, error: null };
  const o = v as CodexOwned;
  const strings = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string");
  const ok =
    o.version === 1 &&
    typeof o.marketplace === "string" &&
    typeof o.config === "string" &&
    path.isAbsolute(o.config) &&
    path.basename(o.config) === "config.toml" &&
    typeof o.block === "string" &&
    o.block.startsWith(PLUGINS_START) &&
    o.block.endsWith(PLUGINS_END) &&
    typeof o.created?.file === "boolean" &&
    typeof o.created?.dir === "boolean" &&
    strings(o.plugins) &&
    strings(o.disabled) &&
    strings(o.covered);
  return ok
    ? { owned: o, error: null }
    : { owned: null, error: "record.harnesses.codex is not what develop setup wrote" };
}

/** Runs codex in `project`, so Codex lays that project's trusted .codex/config.toml over the user's. */
function inProject(run: Run, project: string): Run {
  const r: Run = (args) => {
    const x = run(["-C", project, ...args]);
    r.failure = run.failure;
    return x;
  };
  return r;
}

/** Is the project, or a folder above it, trusted in the user's config.toml. */
function trusted(project: string, userToml: string): boolean {
  return trustedProjects(userToml).some((t) => under(real(project), real(t)));
}

/** Does git track the file: true, false, or null when git cannot say (no git, not a repository). */
function tracked(project: string, relative: string, env: NodeJS.ProcessEnv): boolean | null {
  const r = spawnSync("git", ["-C", project, "ls-files", "--error-unmatch", "--", relative], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  if (r.status === 0) return true;
  return r.status === 1 && !r.error && /did not match/.test(r.stderr) ? false : null;
}

const read = (file: string): Buffer | null => (lexists(file) ? fs.readFileSync(file) : null);

/** The Plugins other connected projects of this Library load from the development marketplace in Codex. */
function usedElsewhere(lib: Library, project: string): Set<string> {
  const used = new Set<string>();
  for (const p of Object.keys(readProjects(lib).projects)) {
    if (samePath(real(p), real(project))) continue;
    const { record } = readRecord(p);
    if (!record || !samePath(real(record.library), real(lib.root))) continue;
    for (const id of ownedOf(record.harnesses.codex).owned?.plugins ?? []) used.add(id);
  }
  return used;
}

/** The copy Codex runs of an installed plugin: its cache folder for the version it lists. */
function cacheOf(h: Harness, market: string, row: Installed): string {
  return path.join(h.configDir, "plugins", "cache", market, row.name, row.version ?? "local");
}

/** Is Codex's copy of the plugin the build: the same files, byte for byte (digest as develop-build hashes output). */
function current(dir: string, sha256: string | null): boolean {
  return !!sha256 && isDir(dir) && digest(folderFiles(dir).files) === sha256;
}

/**
 * Switch `id` off in the user config.toml in place and read it back; null when it is off, else why not. The write is
 * planned against the bytes just read, so a change made since (Codex, a person, another run) is never overwritten.
 */
function switchOff(file: string, id: string): string | null {
  const before = read(file);
  const text = before?.toString("utf8") ?? "";
  if (pluginSwitches(text).get(id) === false) return null;
  const next = disabledIn(text, id);
  if (next === null) return `${id} is set there in a form this tool does not edit`;
  const w = new Report();
  const a = w.add({ kind: "write", path: file, payload: next, expectedHash: before ? toHash(before) : null });
  apply(w, false);
  if (a.kind !== "write") return a.note ?? "not written";
  return pluginSwitches(fs.readFileSync(file, "utf8")).get(id) === false ? null : "it reads on after the write";
}

/** One write of `file` from `before` to `next`, applied now; the failure as a failed conflict on the action. */
function writeNow(done: Report, file: string, next: string | null, before: Buffer | null): boolean {
  const w = new Report();
  const a: Action =
    next === null
      ? w.add({ kind: "delete", path: file })
      : w.add({ kind: "write", path: file, payload: next, expectedHash: before ? toHash(before) : null });
  if (next === null && before && !read(file)?.equals(before)) {
    a.kind = "conflict";
    a.note = "changed since planning; left alone";
  } else apply(w, false);
  if (a.kind === "write" || a.kind === "delete") {
    done.merge(w);
    return true;
  }
  done.add({ ...a, kind: "conflict", failed: true, note: `${file}: ${a.note ?? "not written"}` });
  return false;
}

const RESTART =
  "restart the ChatGPT desktop app to load it (Codex CLI: start a new session); a running chat keeps the copy it loaded";

function setup(o: Resolved, ctx: AdapterContext): AdapterResult & { owned: unknown } {
  const report = new Report();
  const conflict = (file: string, note: string) => report.add({ kind: "conflict", path: file, note: `codex: ${note}` });
  const { owned: previous, error } = ownedOf(ctx.owned);
  if (error) {
    conflict(ctx.project, `${error}; left untouched`);
    return { report, owned: ctx.owned };
  }
  if (!o.file) {
    report.add({ kind: "note", path: ctx.project, loud: true, note: "codex: no codex CLI on PATH; not activated" });
    return { report, owned: ctx.owned ?? null };
  }
  const run = runner(o.file, undefined, o.env);
  const h = o.harness;
  const lib = ctx.library;
  const dev = developmentMarketplace(lib);
  const dirs = developmentDirs(lib);
  const listed = listAll(h, run);
  const markets = listMarketplaces(h, run);
  if (!listed || !markets) {
    conflict(ctx.project, `codex cannot list its plugins or marketplaces; nothing activated`);
    return { report, owned: ctx.owned ?? null };
  }
  const installed = listed.filter((p) => p.installed !== false);
  const devMarket = markets.find((m) => m.name === dev);
  if (devMarket && !(devMarket.root && samePath(real(devMarket.root), real(dirs.output))))
    conflict(
      ctx.project,
      `Codex has a marketplace ${dev} from ${devMarket.root ?? "elsewhere"}, not ${dirs.output}; left untouched`,
    );

  // the catalog the development marketplace reads: every Plugin with a Development build, plus this selection
  const configured = readConfig(lib.configFile).plugins;
  const builtIds = isDir(dirs.plugins)
    ? fs.readdirSync(dirs.plugins).filter((id) => isDir(path.join(dirs.plugins, id)))
    : [];
  const catalogIds = [...new Set([...builtIds, ...ctx.plugins])].filter((id) => configured[id]).sort(cmp);
  const catalog = developmentCatalog(lib);
  const l = readConfig(lib.configFile).library ?? {};
  const catalogText =
    JSON.stringify(
      {
        name: dev,
        interface: { displayName: `${l.owner ? `${l.owner}/` : ""}${l.name ?? path.basename(lib.root)} (development)` },
        plugins: catalogIds.map((id) => ({
          name: id,
          source: `./plugins/${id}`,
          ...(configured[id].description ? { description: configured[id].description } : {}),
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: CATEGORY,
        })),
      },
      null,
      2,
    ) + "\n";
  const catalogBefore = read(catalog);
  if (hasLinkedParent(path.dirname(catalog))) conflict(catalog, "a parent folder is a link; left untouched");
  else if (catalogBefore?.toString("utf8") === catalogText) report.add({ kind: "skip", path: catalog });
  else
    report.add({
      kind: "write",
      path: catalog,
      payload: catalogText,
      expectedHash: catalogBefore ? toHash(catalogBefore) : null,
    });

  // the same-name copies Codex has from elsewhere: switched off in this project, unless a project cannot switch them
  const configuredMarkets = new Set(markets.map((m) => m.name));
  const release: string[] = [];
  for (const p of installed) {
    if (!ctx.plugins.includes(p.name) || p.marketplace === dev) continue;
    const id = `${p.name}@${p.marketplace}`;
    if (!configuredMarkets.has(p.marketplace) || isAccountMarketplace(p.marketplace)) {
      if (p.enabled)
        conflict(
          ctx.project,
          `${id} reaches Codex from the ChatGPT account or workspace, not from a marketplace this machine added; a project's .codex/config.toml cannot switch a workspace-managed plugin off (OpenAI docs) and is unproven for an account one, so ${p.name} is not activated: a decision for Justin (tools#214)`,
        );
      continue;
    }
    release.push(id);
  }
  // the release catalog's copy is off here before it is even installed: a later sync adds it from GitHub and switches it
  // on for the user, and the block must already hold it off in this project (tools#215)
  const installedHere = [...release];
  const releaseMarket = marketplaceName(readConfig(lib.configFile), lib);
  for (const id of ctx.plugins) if (!release.includes(`${id}@${releaseMarket}`)) release.push(`${id}@${releaseMarket}`);
  release.sort(cmp);
  const on = ctx.plugins.map((id) => `${id}@${dev}`);

  const config = path.join(ctx.project, ".codex", "config.toml");
  if (hasLinkedParent(config) || isLink(config))
    conflict(config, "the file or a parent folder is a link; left untouched");
  const before = isLink(config) ? null : read(config);
  const text = before?.toString("utf8") ?? "";
  let ours: string | null = null;
  let skillsDev = new Map<string, boolean | null>();
  let outside = new Map<string, boolean | null>();
  try {
    ours = blockIn(text, PLUGINS_START, PLUGINS_END);
    const theirs = blockIn(text, SKILLS_DEV_START, SKILLS_DEV_END);
    if (theirs) skillsDev = pluginSwitches(theirs);
    outside = pluginSwitches(
      withoutBlock(withoutBlock(text, PLUGINS_START, PLUGINS_END), SKILLS_DEV_START, SKILLS_DEV_END),
    );
  } catch (e) {
    conflict(config, `${e instanceof Error ? e.message : String(e)}; left untouched`);
  }
  if (outside.has("*"))
    conflict(config, "it has plugins settings this tool cannot read; merge by hand; left untouched");
  for (const id of [...on, ...release])
    if (outside.has(id))
      conflict(config, `${id} is set outside develop setup's block; merge it by hand; left untouched`);
  for (const id of on)
    if (skillsDev.has(id))
      conflict(
        config,
        `pnpm skills:dev's block switches ${id}; run pnpm skills:dev again, which leaves it to develop setup`,
      );
  for (const id of release)
    if (skillsDev.has(id) && skillsDev.get(id) !== false)
      conflict(config, `pnpm skills:dev's block sets ${id} other than off; left untouched`);
  const covered = release.filter((id) => skillsDev.get(id) === false);
  const disabled = release.filter((id) => !skillsDev.has(id));
  const block = blockText(on, disabled);
  if (ours !== null && ours !== block && ours !== previous?.block)
    conflict(config, "develop setup's block was changed since setup; left untouched (develop remove keeps it too)");
  if (tracked(ctx.project, ".codex/config.toml", o.env))
    conflict(
      config,
      "git tracks .codex/config.toml: the development switches would be committed and reach cloud sessions; not activated",
    );
  if (report.conflicts().length) return { report, owned: ctx.owned ?? null };

  const next = withBlock(text, PLUGINS_START, PLUGINS_END, block);
  const owned: CodexOwned = {
    version: 1,
    marketplace: dev,
    config,
    block,
    created: {
      file: previous?.created.file ?? !before,
      dir: previous?.created.dir ?? !isDir(path.dirname(config)),
    },
    plugins: [...ctx.plugins],
    disabled,
    covered,
  };
  const userText = read(o.userConfig)?.toString("utf8") ?? "";
  if (!trusted(ctx.project, userText))
    report.add({
      kind: "note",
      path: config,
      loud: true,
      note: `codex: Codex reads .codex/config.toml only in a trusted project: trust ${ctx.project} in Codex (it asks when it first opens the folder); until then it keeps the released copies here`,
    });

  // what the commands will do, in order: register the marketplace, add each Plugin whose cached copy is not the build
  // (switching it off again for every project right after), write the block, drop Plugins no project uses any more
  const builds = new Map((ctx.build?.plugins ?? []).map((p) => [p.id, p]));
  const toAdd = ctx.plugins.filter((id) => {
    const row = installed.find((p) => p.name === id && p.marketplace === dev);
    return !row || !current(cacheOf(h, dev, row), builds.get(id)?.sha256 ?? null);
  });
  const others = usedElsewhere(lib, ctx.project);
  const dropped = (previous?.plugins ?? []).filter(
    (id) =>
      !ctx.plugins.includes(id) && !others.has(id) && installed.some((p) => p.name === id && p.marketplace === dev),
  );
  if (!devMarket) report.add({ kind: "install", path: dirs.output, note: `codex plugin marketplace add (${dev})` });
  for (const id of toAdd)
    report.add({
      kind: "install",
      path: path.join(h.configDir, "plugins", "cache", dev, id),
      note: `codex plugin add ${id}@${dev}, then switched off again in ${o.userConfig}: an add switches it on for every project`,
    });
  if (next !== text && ctx.plan)
    report.add({ kind: "write", path: config, payload: next, expectedHash: before ? toHash(before) : null });
  else if (next === text) report.add({ kind: "skip", path: config });
  for (const id of dropped)
    report.add({ kind: "uninstall", path: ctx.project, note: `codex plugin remove ${id}@${dev}: no project uses it` });

  const commands = (): Report => {
    const done = new Report();
    const fresh: string[] = [];
    let addedMarket = false;
    const undo = () => {
      for (const id of fresh)
        if (!uninstallPlugin(h, run, id))
          done.add({ kind: "note", path: ctx.project, loud: true, note: `codex: could not take ${id} back out` });
      if (addedMarket && !removeMarketplace(h, run, dev))
        done.add({
          kind: "note",
          path: ctx.project,
          loud: true,
          note: `codex: could not take marketplace ${dev} back out`,
        });
    };
    const fail = (file: string, note: string): Report => {
      done.add({ kind: "conflict", path: file, failed: true, note: `codex: ${note}`, diagnostic: run.failure });
      undo();
      return done;
    };
    if (!devMarket) {
      const added = addMarketplace(h, run, dirs.output);
      if (!added) return fail(dirs.output, `codex plugin marketplace add refused; nothing activated`);
      addedMarket = !added.alreadyAdded;
      done.add({ kind: "install", path: dirs.output, note: `codex plugin marketplace add (${dev})` });
    }
    for (const id of ctx.plugins) {
      const key = `${id}@${dev}`;
      if (toAdd.includes(id)) {
        const was = installed.some((p) => p.name === id && p.marketplace === dev);
        const start = Date.now();
        if (!installPlugin(h, run, key)) return fail(ctx.project, `codex plugin add ${key} refused; nothing activated`);
        if (!was) fresh.push(key);
        const off = switchOff(o.userConfig, key);
        const window = Date.now() - start;
        if (off !== null) {
          // on for every project and not switchable off: out of Codex again, so no other project loads it
          const removed = uninstallPlugin(h, run, key);
          if (removed && fresh.includes(key)) fresh.splice(fresh.indexOf(key), 1);
          return fail(
            o.userConfig,
            `${key}: codex plugin add switched it on for every project and it could not be switched off again (${off}); ${removed ? "removed it from Codex, so no project loads it" : "and removing it failed too: switch it off by hand"}; nothing activated`,
          );
        }
        done.add({
          kind: "install",
          path: path.join(h.configDir, "plugins", "cache", dev, id),
          note: `codex plugin add ${key}; on for every project for ${window} ms, until switched off again in ${o.userConfig}`,
        });
      } else {
        // already the build: only make sure it is off for every other project (a run that died after its add)
        const off = switchOff(o.userConfig, key);
        if (off !== null)
          return fail(o.userConfig, `${key} is on for every project and could not be switched off (${off})`);
      }
    }
    if (next !== text && !writeNow(done, config, next, before)) {
      done.actions[done.actions.length - 1].note =
        `codex: ${done.actions[done.actions.length - 1].note}; nothing activated`;
      undo();
      return done;
    }
    for (const id of dropped)
      if (uninstallPlugin(h, run, `${id}@${dev}`))
        done.add({
          kind: "uninstall",
          path: ctx.project,
          note: `codex plugin remove ${id}@${dev}: no project uses it`,
        });
      else return fail(ctx.project, `codex plugin remove ${id}@${dev} refused`);
    done.add({
      kind: "note",
      path: config,
      note:
        toAdd.length || next !== text
          ? `codex: ${ctx.plugins.map((id) => `${id}@${dev}`).join(", ")} on in this project, ${[...disabled, ...covered].join(", ") || "no other copy"} off; ${RESTART}. Visible but inactive: ${on.join(", ")} in Codex's plugin list for every other project${installedHere.length ? `, ${installedHere.sort(cmp).join(", ")} still installed` : ""}`
          : "codex: already active here; no restart needed",
    });
    return done;
  };
  return { report, owned, commands };
}

function remove(o: Resolved, ctx: AdapterContext): AdapterResult {
  const report = new Report();
  const { owned, error } = ownedOf(ctx.owned);
  if (error || !owned) {
    report.add({ kind: "conflict", path: ctx.project, note: `codex: ${error ?? "nothing recorded"}; nothing removed` });
    return { report };
  }
  const config = owned.config;
  const before = isLink(config) ? null : read(config);
  const text = before?.toString("utf8") ?? "";
  let block: string | null = null;
  try {
    block = blockIn(text, PLUGINS_START, PLUGINS_END);
  } catch (e) {
    report.add({ kind: "note", path: config, loud: true, note: `codex: ${String(e)}; kept` });
  }
  let next: string | null | undefined; // undefined: leave the file as it is
  if (block !== null && block !== owned.block)
    report.add({
      kind: "note",
      path: config,
      loud: true,
      note: "codex: develop setup's block changed since setup; kept",
    });
  else if (block !== null) {
    const rest = withoutBlock(text, PLUGINS_START, PLUGINS_END);
    next = !rest && owned.created.file ? null : rest;
  }
  const lib = ctx.library;
  const others = usedElsewhere(lib, ctx.project);
  const dev = owned.marketplace;
  const run = o.file ? runner(o.file, undefined, o.env) : null;
  const h = o.harness;
  const listed = run ? listAll(h, run) : null;
  const markets = run ? listMarketplaces(h, run) : null;
  if (!run || !listed || !markets)
    report.add({
      kind: "note",
      path: ctx.project,
      loud: true,
      note: `codex: ${run ? "codex cannot list its plugins" : "no codex CLI on PATH"}; the development copies stay installed in Codex, switched off for every project`,
    });
  const drop = owned.plugins.filter(
    (id) => !others.has(id) && !!listed?.some((p) => p.name === id && p.marketplace === dev && p.installed !== false),
  );
  const dropMarket = !!markets?.some((m) => m.name === dev) && !others.size && !!run;
  if (next !== undefined && ctx.plan)
    report.add(
      next === null
        ? { kind: "delete", path: config }
        : { kind: "write", path: config, payload: next, expectedHash: before ? toHash(before) : null },
    );
  for (const id of drop)
    report.add({ kind: "uninstall", path: ctx.project, note: `codex plugin remove ${id}@${dev}: no project uses it` });
  if (dropMarket) report.add({ kind: "uninstall", path: ctx.project, note: `codex plugin marketplace remove ${dev}` });

  const commands = (): Report => {
    const done = new Report();
    if (next !== undefined) {
      if (!writeNow(done, config, next, before)) return done;
      const dir = path.dirname(config);
      if (next === null && owned.created.dir && isDir(dir) && !fs.readdirSync(dir).length) {
        fs.rmdirSync(dir);
        done.add({ kind: "delete", path: dir });
      }
    }
    for (const id of drop) {
      if (!uninstallPlugin(h, run!, `${id}@${dev}`)) {
        done.add({
          kind: "conflict",
          path: ctx.project,
          failed: true,
          note: `codex: codex plugin remove ${id}@${dev} refused`,
          diagnostic: run!.failure,
        });
        return done;
      }
      done.add({ kind: "uninstall", path: ctx.project, note: `codex plugin remove ${id}@${dev}: no project uses it` });
    }
    if (dropMarket) {
      if (!removeMarketplace(h, run!, dev)) {
        done.add({
          kind: "conflict",
          path: ctx.project,
          failed: true,
          note: `codex: codex plugin marketplace remove ${dev} refused`,
          diagnostic: run!.failure,
        });
        return done;
      }
      done.add({ kind: "uninstall", path: ctx.project, note: `codex plugin marketplace remove ${dev}` });
    }
    done.add({
      kind: "note",
      path: ctx.project,
      note: `codex: back to the released copies here; ${RESTART.replace("load it", "load them")}`,
    });
    return done;
  };
  return { report, commands };
}

function status(o: Resolved, ctx: AdapterContext): { state: string; note: string } {
  const { owned, error } = ownedOf(ctx.owned);
  if (error) return { state: "unknown", note: error };
  if (!owned) return { state: "not activated", note: "develop setup activates the selection in Codex" };
  if (!o.file) return { state: "unknown", note: "no codex CLI on PATH" };
  const run = runner(o.file, undefined, o.env);
  const h = o.harness;
  const listed = listAll(h, run)?.filter((p) => p.installed !== false) ?? null;
  const prompt = codexPluginSkills(inProject(run, ctx.project));
  if (!listed || !prompt) return { state: "unknown", note: "codex cannot list its plugins or render its prompt input" };
  const dev = owned.marketplace;
  const user = pluginSwitches(read(o.userConfig)?.toString("utf8") ?? "");
  const builds = readDevelopmentStatus(ctx.library)?.plugins ?? {};
  const states: string[] = [];
  const notes: string[] = [];
  for (const id of owned.plugins) {
    const key = `${id}@${dev}`;
    const row = listed.find((p) => p.name === id && p.marketplace === dev);
    const copies = listed.filter((p) => p.name === id).map((p) => p.marketplace);
    const loaded = (m: string) => promptedSkills(prompt, id, m, copies).length > 0;
    const others = copies.filter((m) => m !== dev && loaded(m));
    let state: string;
    if (!row) state = "not installed";
    else if (loaded(dev) && others.length) state = "duplicate";
    else if (others.length) state = "released copy loaded";
    else if (!loaded(dev)) state = "not loaded";
    else if (!current(cacheOf(h, dev, row), builds[id]?.sha256 ?? null)) state = "stale";
    else state = "active";
    if (row && user.get(key) !== false) state = "on everywhere";
    states.push(state);
    notes.push(
      {
        "not installed": `${id}: Codex has no ${key}; develop setup adds it`,
        duplicate: `${id}: both ${key} and ${others.join(", ")} load here`,
        "released copy loaded": `${id}: ${others.join(", ")} loads here, not ${key}${trusted(ctx.project, read(o.userConfig)?.toString("utf8") ?? "") ? "" : " (Codex does not trust this project, so it ignores .codex/config.toml)"}`,
        "not loaded": `${id}: ${key} is installed but does not load here`,
        stale: `${id}: Codex's copy is not the latest build; develop setup adds it again, then ${RESTART}`,
        active: `${id}: ${key} loads here`,
        "on everywhere": `${id}: ${key} is switched on for every project in ${o.userConfig}; develop setup switches it off`,
      }[state]!,
    );
  }
  const order = [
    "on everywhere",
    "duplicate",
    "released copy loaded",
    "not installed",
    "not loaded",
    "stale",
    "active",
  ];
  const state = order.find((s) => states.includes(s)) ?? "active";
  return {
    state,
    note: `${notes.join("; ")}. Read from codex debug prompt-input; Codex in the ChatGPT desktop app loads what it read at its last restart. Visible but inactive elsewhere: ${owned.plugins.map((id) => `${id}@${dev}`).join(", ")}`,
  };
}
