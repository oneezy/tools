// The Claude Code adapter of a Development project: the project's selected Plugins come from the Library's Development
// builds, through a local-scope directory marketplace over dist/development, and the matching released copies are off
// in that project only. Everything it changes for the project lands in the project's .claude/settings.local.json (one
// person, this repository), and in Claude Code's own install records through its CLI:
//
//   claude plugin marketplace add <library>/dist/development --scope local   (declares the marketplace in this project)
//   claude plugin install <id>@<release>-development --scope local           (installs it for this project, read in place)
//   enabledPlugins."<id>@<release>": false, enabledPlugins."<id>@synced": false   (the released copies, this project only)
//
// Claude Code tells same-name Plugins apart by the manifest name and loads one copy: an installed marketplace copy over
// an Account plugin (<id>@synced); of two enabled marketplace copies, not the development one. So each released copy is
// switched off here, never uninstalled, and stays on in every other project. Remove takes back exactly what setup did,
// checking each key first: the local installs (claude plugin uninstall --scope local), the released copies' keys back
// to what they were, the marketplace's local declaration. It never runs `claude plugin marketplace remove`: that drops
// the marketplace for every project and uninstalls its Plugins there. A running chat keeps the copy it loaded until the
// person types /reload-plugins in it or starts a new one; nothing here can reload a chat, so it says so.
// See docs/research/2026-10-17-harness-plugin-loading.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { marketplaceName } from "./build.js";
import { developmentDirs } from "./develop-build.js";
import type { AdapterContext, HarnessAdapter } from "./develop-project.js";
import { hasLinkedParent, isDir, isLink, lexists, real, samePath, toHash } from "./fs.js";
import { json, refused, runner, which, type Run } from "./install.js";
import type { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { cmp, readConfig } from "./sources.js";

/** The project's local Claude Code settings, relative to the project. */
export const LOCAL_SETTINGS = ".claude/settings.local.json";
/** The catalog of the development marketplace, relative to dist/development. */
export const DEVELOPMENT_CATALOG = ".claude-plugin/marketplace.json";
/** An Account plugin's origin in Claude Code. */
const SYNCED = "synced";

export interface ClaudeCodeOptions {
  /** false until the Windows runtime proof exists (#213); a test switches it on */
  verified?: boolean;
  /** the claude executable; by default `claude` on PATH, looked up each time the adapter runs */
  claude?: string | null;
}

/** What setup did in this project, kept in the record as harnesses["claude-code"]. */
export interface ClaudeOwned {
  version: 1;
  /** the development marketplace's name and the folder it reads (dist/development) */
  marketplace: string;
  root: string;
  /** setup declared the marketplace in settings.local.json (it was not declared there before) */
  declared: boolean;
  /** settings.local.json before the first setup: whether setup made it, made .claude, and the top-level keys it had */
  settings: { created: boolean; folder: boolean; keys: string[] };
  /** per selected Plugin: its development id, whether setup installed it, and each released copy it switched off */
  plugins: Record<string, { id: string; installed: boolean; off: { id: string; prior: boolean | null }[] }>;
}

/** One row of `claude plugin list --json`, as the running project sees it. */
interface Row {
  id: string;
  name: string;
  origin: string;
  scope: string | null;
  enabled: boolean;
  projectPath: string | null;
}

/** settings.local.json as it is: its bytes, its object, or why it cannot be used. */
interface Settings {
  file: string;
  bytes: Buffer | null;
  data: Record<string, unknown>;
  error: string | null;
}

const at = (project: string, relative: string) => path.join(project, ...relative.split("/"));
const splitId = (id: string) => ({ name: id.slice(0, id.lastIndexOf("@")), origin: id.slice(id.lastIndexOf("@") + 1) });
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The release marketplace's name (the one build gives the Catalogs) and the development marketplace's. */
export function marketplaceNames(lib: Library): { release: string; development: string } {
  const release = marketplaceName(readConfig(lib.configFile), lib);
  return { release, development: `${release}-development` };
}

/** Each released copy setup switched off goes back to what it was, while it still holds the false setup left there. */
function restoreOff(keys: Record<string, unknown>, off: ClaudeOwned["plugins"][string]["off"]): void {
  for (const x of off)
    if (keys[x.id] === false) {
      if (x.prior === null) delete keys[x.id];
      else keys[x.id] = x.prior;
    }
}

function isOwned(v: unknown): v is ClaudeOwned {
  const o = v as ClaudeOwned;
  return (
    !!o &&
    o.version === 1 &&
    typeof o.marketplace === "string" &&
    typeof o.root === "string" &&
    typeof o.declared === "boolean" &&
    typeof o.settings?.created === "boolean" &&
    typeof o.settings.folder === "boolean" &&
    Array.isArray(o.settings.keys) &&
    !!o.plugins &&
    typeof o.plugins === "object" &&
    Object.values(o.plugins).every(
      (p) =>
        typeof p?.id === "string" &&
        typeof p.installed === "boolean" &&
        Array.isArray(p.off) &&
        p.off.every((x) => typeof x?.id === "string" && [true, false, null].includes(x.prior)),
    )
  );
}

function readSettings(project: string): Settings {
  const file = at(project, LOCAL_SETTINGS);
  const s: Settings = { file, bytes: null, data: {}, error: null };
  if (hasLinkedParent(path.dirname(file)) || isLink(file)) return { ...s, error: "it or a parent folder is a link" };
  if (!lexists(file)) return s;
  s.bytes = fs.readFileSync(file);
  try {
    const v = JSON.parse(s.bytes.toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ...s, error: "not a JSON object" };
    s.data = v as Record<string, unknown>;
  } catch (e) {
    s.error = `not JSON: ${e instanceof Error ? e.message : String(e)}`;
  }
  return s;
}

/** Every plugin row Claude Code lists from the project; null when it cannot list. */
function listRows(run: Run): Row[] | null {
  const r = run(["plugin", "list", "--json"]);
  const v = r.ok ? json(r.out) : null;
  if (!Array.isArray(v)) return null;
  return v
    .filter((p) => typeof p?.id === "string" && p.id.includes("@"))
    .map((p) => ({
      id: p.id as string,
      ...splitId(p.id as string),
      scope: typeof p.scope === "string" ? p.scope : null,
      enabled: p.enabled === true,
      projectPath: typeof p.projectPath === "string" ? p.projectPath : null,
    }));
}

/** The project's own local install of `id`, from the listing. */
const localHere = (rows: Row[], id: string, project: string) =>
  rows.find(
    (r) => r.id === id && r.scope === "local" && !!r.projectPath && samePath(real(r.projectPath), real(project)),
  );

/** Is `v` the marketplace's declaration as `claude plugin marketplace add <root> --scope local` writes it? */
const declaredAs = (v: unknown, root: string) => {
  const src = obj(obj(v).source);
  return src.source === "directory" && typeof src.path === "string" && samePath(real(src.path), real(root));
};

/** The nearest folder at or above `project` holding .git: Claude Code keeps --scope local settings there. */
function repositoryRoot(project: string): string | null {
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    if (lexists(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function tracked(project: string): boolean {
  if (!lexists(path.join(project, ".git"))) return false;
  const r = spawnSync("git", ["-C", project, "ls-files", "--error-unmatch", "--", LOCAL_SETTINGS], {
    encoding: "utf8",
  });
  return r.status === 0;
}

/** The text settings.local.json gets from `data`; null when the file should go (setup made it and nothing is left). */
function settingsText(data: Record<string, unknown>, owned: ClaudeOwned): string | null {
  const next = { ...data };
  for (const key of ["enabledPlugins", "extraKnownMarketplaces"])
    if (key in next && !owned.settings.keys.includes(key) && !Object.keys(obj(next[key])).length) delete next[key];
  if (owned.settings.created && !Object.keys(next).length) return null;
  return JSON.stringify(next, null, 2) + "\n";
}

/** Plan and apply one change to settings.local.json against the file as it is now; the actions it took. */
function writeSettings(s: Settings, text: string | null, why: string): Report {
  const r = new Report();
  if (text === null) {
    if (s.bytes) r.add({ kind: "delete", path: s.file, note: why });
  } else if (s.bytes?.toString("utf8") !== text)
    r.add({ kind: "write", path: s.file, payload: text, expectedHash: s.bytes ? toHash(s.bytes) : null, note: why });
  apply(r, false);
  return r;
}

const enabledKeys = (s: Settings) => obj(s.data.enabledPlugins);
const reload =
  "installed is not loaded: a chat open in this project keeps the copy it loaded until you type /reload-plugins in it or start a new chat";

export function claudeCodeAdapter(options: ClaudeCodeOptions = {}): HarnessAdapter {
  const cli = () => (options.claude === undefined ? which("claude") : options.claude);

  return {
    harness: "claude-code",
    verified: options.verified ?? false,
    excludes: [`/${LOCAL_SETTINGS}`],

    setup(ctx) {
      const report = new Report();
      const settingsFile = at(ctx.project, LOCAL_SETTINGS);
      const conflict = (note: string, file = settingsFile) =>
        report.add({ kind: "conflict", path: file, note: `claude-code: ${note}; nothing changed` });
      const prev = ctx.owned === null ? null : isOwned(ctx.owned) ? ctx.owned : undefined;
      if (prev === undefined) {
        conflict("the record's Claude Code state is not one this version wrote");
        return { report, owned: ctx.owned };
      }
      const file = cli();
      if (!file) {
        if (prev) conflict("no claude CLI on PATH, and this project has development Plugins in Claude Code");
        else report.add({ kind: "note", path: ctx.project, note: "claude-code: not activated: no claude CLI on PATH" });
        return { report, owned: prev };
      }
      const repo = repositoryRoot(ctx.project);
      if (repo && !samePath(real(repo), real(ctx.project)))
        conflict(`Claude Code keeps this project's local settings at its repository root ${repo}; set up that folder`);
      const run = runner(file, undefined, undefined, ctx.project);
      const help = run(["plugin", "install", "--help"]);
      if (!help.ok || !/\blocal\b/.test(help.out + help.err))
        conflict("this claude has no local plugin scope (claude plugin install --scope local); update Claude Code");
      const settings = readSettings(ctx.project);
      if (settings.error) conflict(`${LOCAL_SETTINGS} is ${settings.error}`);
      else if (tracked(ctx.project))
        conflict(`${LOCAL_SETTINGS} is tracked by git, so its development entries would be committed`);
      if (report.conflicts().length) return { report, owned: prev };

      const { release, development } = marketplaceNames(ctx.library);
      const dirs = developmentDirs(ctx.library);
      const root = dirs.output;
      const known = json(run(["plugin", "marketplace", "list", "--json"]).out);
      for (const m of Array.isArray(known) ? known : []) {
        const where = [m?.path, m?.installLocation, m?.source?.path].find((x) => typeof x === "string");
        if (m?.name === development && where && !samePath(real(where), real(root)))
          conflict(`a marketplace named ${development} already reads ${where}, not this Library's ${root}`);
      }
      const declared = obj(settings.data.extraKnownMarketplaces)[development];
      if (declared !== undefined && !declaredAs(declared, root))
        conflict(`${LOCAL_SETTINGS} declares ${development} from another source`);
      const rows = listRows(run);
      if (!rows) conflict("claude plugin list --json failed, so the released copies cannot be found");
      if (report.conflicts().length || !rows) return { report, owned: prev };

      // the development catalog lists every Plugin built for this Library, so every connected project can install its own
      const built = new Set(ctx.build?.plugins.filter((p) => p.state !== "failed").map((p) => p.id) ?? ctx.plugins);
      if (isDir(dirs.plugins))
        for (const id of fs.readdirSync(dirs.plugins))
          if (lexists(path.join(dirs.plugins, id, ".claude-plugin", "plugin.json"))) built.add(id);
      const catalog = path.join(root, ...DEVELOPMENT_CATALOG.split("/"));
      const owner = readConfig(ctx.library.configFile).library?.owner ?? release;
      const text =
        JSON.stringify(
          {
            name: development,
            owner: { name: owner },
            description: `Development builds of ${ctx.library.root}, for the projects skills-sync develop setup connects.`,
            plugins: [...built].sort(cmp).map((id) => ({ name: id, source: `./plugins/${id}` })),
          },
          null,
          2,
        ) + "\n";
      const before = lexists(catalog) ? fs.readFileSync(catalog) : null;
      if (before?.toString("utf8") === text) report.add({ kind: "skip", path: catalog });
      else report.add({ kind: "write", path: catalog, payload: text, expectedHash: before ? toHash(before) : null });

      const owned: ClaudeOwned = {
        version: 1,
        marketplace: development,
        root,
        declared: prev?.declared ?? declared === undefined,
        settings: prev?.settings ?? {
          created: !settings.bytes,
          folder: !isDir(path.join(ctx.project, ".claude")),
          keys: Object.keys(settings.data),
        },
        plugins: {},
      };
      const local = enabledKeys(settings);
      // what the commands will do, shown on plan; a run reports what they did instead
      const preview = (kind: "install" | "uninstall" | "note", note: string) => {
        if (ctx.plan) report.add({ kind, path: settingsFile, note: `claude-code: ${note}` });
      };
      if (declared === undefined) preview("install", `claude plugin marketplace add ${root} --scope local`);
      for (const id of ctx.plugins) {
        const dev = `${id}@${development}`;
        const mine = localHere(rows, dev, ctx.project);
        const was = prev?.plugins[id];
        const entry = { id: dev, installed: was?.installed ?? !mine, off: [...(was?.off ?? [])] };
        if (!mine) preview("install", `claude plugin install ${dev} --scope local`);
        for (const r of rows.filter((x) => x.name === id && x.origin !== development)) {
          if (entry.off.some((x) => x.id === r.id)) continue;
          if (r.origin === release || r.origin === SYNCED) {
            const prior = local[r.id];
            entry.off.push({ id: r.id, prior: typeof prior === "boolean" ? prior : null });
          } else if (r.origin === "skills-dir")
            report.add({
              kind: "note",
              path: settingsFile,
              note: `claude-code: ${r.id} gives way to the installed development copy`,
            });
          else if (r.enabled)
            conflict(
              `${r.id} has the name ${id} too and is on in this project, so it would compete with ${dev}; switch it off here first (claude plugin disable ${r.id} --scope local)`,
            );
        }
        for (const x of entry.off) if (local[x.id] !== false) preview("note", `${x.id} off in this project only`);
        owned.plugins[id] = entry;
      }
      const dropped = Object.entries(prev?.plugins ?? {}).filter(([id]) => !ctx.plugins.includes(id));
      for (const [, p] of dropped) {
        if (p.installed && localHere(rows, p.id, ctx.project))
          preview("uninstall", `claude plugin uninstall ${p.id} --scope local`);
        for (const x of p.off) if (local[x.id] === false) preview("note", `${x.id} back to ${x.prior ?? "unset"}`);
      }
      if (report.conflicts().length) return { report, owned: prev };

      const commands = () => {
        const done = new Report();
        const undo: (() => void)[] = [];
        const ran = (kind: "install" | "uninstall", note: string) =>
          done.add({ kind, path: settingsFile, note: `claude-code: ${note}` });
        const failed = (note: string) => {
          refused(done.add({ kind: "conflict", path: settingsFile }), run, `claude-code: ${note}`);
          for (const step of undo.reverse()) step();
          return done;
        };
        if (obj(readSettings(ctx.project).data.extraKnownMarketplaces)[development] === undefined) {
          if (!run(["plugin", "marketplace", "add", root, "--scope", "local", "--json"]).ok)
            return failed(`claude plugin marketplace add ${root} --scope local failed`);
          ran("install", `declared ${development} (${root}) in this project`);
          // only the declaration: `marketplace remove` would drop it for every project and uninstall its Plugins there
          undo.push(() => {
            const s = readSettings(ctx.project);
            const m = obj(s.data.extraKnownMarketplaces);
            if (s.error || !declaredAs(m[development], root)) return;
            delete m[development];
            writeSettings(s, settingsText(s.data, owned), "undo");
          });
        }
        for (const id of ctx.plugins) {
          const dev = owned.plugins[id].id;
          if (localHere(rows, dev, ctx.project)) continue;
          if (!run(["plugin", "install", dev, "--scope", "local", "--json"]).ok)
            return failed(`claude plugin install ${dev} --scope local failed`);
          ran("install", `installed ${dev} for this project, read in place from ${path.join(dirs.plugins, id)}`);
          undo.push(() => run(["plugin", "uninstall", dev, "--scope", "local", "--json"]));
        }
        for (const [, p] of dropped)
          if (p.installed && localHere(rows, p.id, ctx.project)) {
            if (!run(["plugin", "uninstall", p.id, "--scope", "local", "--json"]).ok)
              return failed(`claude plugin uninstall ${p.id} --scope local failed`);
            ran("uninstall", `uninstalled ${p.id} from this project`);
            undo.push(() => run(["plugin", "install", p.id, "--scope", "local", "--json"]));
          }
        // the released copies' keys, written after the CLI rewrote the file
        const s = readSettings(ctx.project);
        if (s.error) return failed(`${LOCAL_SETTINGS} is ${s.error} after the install`);
        const keys = obj(s.data.enabledPlugins);
        for (const p of Object.values(owned.plugins)) for (const x of p.off) keys[x.id] = false;
        for (const [, p] of dropped) restoreOff(keys, p.off);
        s.data.enabledPlugins = keys;
        const wrote = writeSettings(s, settingsText(s.data, owned), "released copies off in this project only");
        done.merge(wrote);
        if (wrote.actions.some((a) => a.failed || a.kind === "conflict"))
          return failed(`${LOCAL_SETTINGS} changed while setup wrote it`);
        undo.push(() => {
          const now = readSettings(ctx.project);
          if (s.bytes && !now.error && now.bytes && wrote.actions.length)
            writeSettings(now, s.bytes.toString("utf8"), "undo");
        });
        // what a new chat in this project would load: the development copies on, the released ones off
        const after = listRows(run);
        const wrong: string[] = [];
        for (const p of Object.values(owned.plugins)) {
          const mine = after && localHere(after, p.id, ctx.project);
          if (!mine?.enabled) wrong.push(`${p.id} is not installed and on for this project`);
          for (const x of p.off) if (after?.find((r) => r.id === x.id)?.enabled) wrong.push(`${x.id} is still on here`);
        }
        if (!after) wrong.push("claude plugin list --json failed");
        if (wrong.length) return failed(`after setup, ${wrong.join("; ")}`);
        const off = Object.values(owned.plugins).flatMap((p) => p.off.map((x) => x.id));
        done.add({
          kind: "note",
          path: ctx.project,
          loud: true,
          note: `claude-code: ${Object.values(owned.plugins)
            .map((p) => p.id)
            .join(", ")} on in this project${off.length ? `, ${off.join(", ")} off here only` : ""}; ${reload}`,
        });
        return done;
      };
      return { report, owned, commands };
    },

    remove(ctx) {
      const report = new Report();
      const settingsFile = at(ctx.project, LOCAL_SETTINGS);
      const conflict = (note: string) =>
        report.add({ kind: "conflict", path: settingsFile, note: `claude-code: ${note}; nothing removed` });
      if (!isOwned(ctx.owned)) {
        conflict("the record's Claude Code state is not one this version wrote");
        return report;
      }
      const owned = ctx.owned;
      const file = cli();
      if (!file) {
        conflict("no claude CLI on PATH, so the development copies cannot be uninstalled");
        return report;
      }
      const run = runner(file, undefined, undefined, ctx.project);
      const rows = listRows(run);
      const settings = readSettings(ctx.project);
      if (!rows) conflict("claude plugin list --json failed");
      if (settings.error) conflict(`${LOCAL_SETTINGS} is ${settings.error}`);
      if (!rows || settings.error) return report;
      const local = enabledKeys(settings);
      const kept = (note: string) =>
        report.add({ kind: "note", path: settingsFile, loud: true, note: `claude-code: ${note}; kept` });
      for (const p of Object.values(owned.plugins)) {
        if (ctx.plan && p.installed && localHere(rows, p.id, ctx.project))
          report.add({
            kind: "uninstall",
            path: settingsFile,
            note: `claude-code: claude plugin uninstall ${p.id} --scope local`,
          });
        for (const x of p.off)
          if (local[x.id] === false) {
            if (ctx.plan)
              report.add({
                kind: "note",
                path: settingsFile,
                note: `claude-code: ${x.id} back to ${x.prior ?? "unset"}`,
              });
          } else
            kept(
              `${x.id} is ${local[x.id] === undefined ? "unset" : JSON.stringify(local[x.id])} here since setup switched it off`,
            );
      }
      const declared = obj(settings.data.extraKnownMarketplaces)[owned.marketplace];
      if (owned.declared && declared !== undefined && !declaredAs(declared, owned.root))
        kept(`${LOCAL_SETTINGS} declares ${owned.marketplace} from another source since setup`);

      const commands = () => {
        const done = new Report();
        const uninstalled: string[] = [];
        for (const p of Object.values(owned.plugins)) {
          if (!p.installed || !localHere(rows, p.id, ctx.project)) continue;
          if (!run(["plugin", "uninstall", p.id, "--scope", "local", "--json"]).ok) {
            refused(
              done.add({ kind: "conflict", path: settingsFile }),
              run,
              `claude-code: claude plugin uninstall ${p.id} --scope local failed`,
            );
            for (const id of uninstalled.reverse()) run(["plugin", "install", id, "--scope", "local", "--json"]);
            return done;
          }
          uninstalled.push(p.id);
          done.add({
            kind: "uninstall",
            path: settingsFile,
            note: `claude-code: uninstalled ${p.id} from this project`,
          });
        }
        // the keys setup wrote, each back to what it was while it still holds what setup left there
        const s = readSettings(ctx.project);
        if (!s.error) {
          const keys = obj(s.data.enabledPlugins);
          for (const p of Object.values(owned.plugins)) {
            if (p.installed && keys[p.id] === true) delete keys[p.id];
            restoreOff(keys, p.off);
          }
          if ("enabledPlugins" in s.data) s.data.enabledPlugins = keys;
          const m = obj(s.data.extraKnownMarketplaces);
          if (owned.declared && declaredAs(m[owned.marketplace], owned.root)) {
            delete m[owned.marketplace];
            s.data.extraKnownMarketplaces = m;
          }
          done.merge(writeSettings(s, settingsText(s.data, owned), "development entries taken back"));
        }
        const folder = path.join(ctx.project, ".claude");
        if (owned.settings.folder && isDir(folder) && !isLink(folder) && !fs.readdirSync(folder).length) {
          fs.rmdirSync(folder);
          done.add({ kind: "delete", path: folder });
        }
        done.add({
          kind: "note",
          path: ctx.project,
          loud: true,
          note: `claude-code: released copies back in this project; ${reload}`,
        });
        return done;
      };
      return { report, commands };
    },

    status(ctx: AdapterContext) {
      if (!isOwned(ctx.owned))
        return { state: "unknown", note: "the record's Claude Code state is not one this version wrote" };
      const owned = ctx.owned;
      const file = cli();
      if (!file) return { state: "unknown", note: "no claude CLI on PATH" };
      const rows = listRows(runner(file, undefined, undefined, ctx.project));
      if (!rows) return { state: "unknown", note: "claude plugin list --json failed" };
      const wrong: string[] = [];
      for (const p of Object.values(owned.plugins)) {
        if (!localHere(rows, p.id, ctx.project)?.enabled) wrong.push(`${p.id} is not installed and on here`);
        for (const x of p.off) if (rows.find((r) => r.id === x.id)?.enabled) wrong.push(`${x.id} is on here again`);
      }
      if (wrong.length) return { state: "drifted", note: `${wrong.join("; ")}; develop setup puts it back` };
      const ids = Object.values(owned.plugins).map((p) => p.id);
      return {
        state: "installed",
        note: `${ids.join(", ")} installed and on for this project, read in place from ${owned.root}; ${reload}`,
      };
    },
  };
}
