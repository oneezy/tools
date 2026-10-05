// add <source>: stage the repo in a temp clone, list its skills, write the config entry and the plugin entry that
// packages the source. The refresh that follows reuses the clone. Nothing is installed anywhere: the config is the only
// thing add writes.
import fs from "node:fs";
import path from "node:path";
import { isDir } from "./fs.js";
import { Library } from "./library.js";
import { cloneUrl, cmp, findSkills, githubSlug, readConfigRaw, type Plugin, type Source } from "./sources.js";
import { defaultBranch, discard, stage, type Staged } from "./stage.js";

export interface AddOptions {
  id?: string;
  root?: string;
  /** folder names to take; every skill found when absent or "*" */
  skills?: string[] | "*";
  /** upstream name -> working-set name */
  as: Record<string, string>;
  /** the id of the plugin that packages the source (default: the source id); false declares none */
  plugin?: string | false;
  log: (s: string) => void;
}

export type AddResult = { ok: true; id: string; entry: Source; plugin: { id: string; entry: Plugin } | null; config: Record<string, unknown>; staged: Staged; found: Map<string, string> } | { ok: false; error: string };

/** owner/repo[#ref], a git URL[#ref], or a local path. */
export function parseSpec(spec: string): { repo: string; ref?: string } {
  const hash = spec.lastIndexOf("#");
  const ref = hash > 0 && !/[\\/]/.test(spec.slice(hash + 1)) ? spec.slice(hash + 1) : undefined;
  const repo = ref ? spec.slice(0, hash) : spec;
  return { repo: fs.existsSync(repo) ? path.resolve(repo) : repo, ref };
}

/** owner/repo -> owner-repo; a URL or path -> its last segment; lowercased, anything else becomes a dash. */
export function defaultId(repo: string): string {
  const slug = githubSlug(repo);
  const raw = slug ? slug.replace("/", "-") : path.basename(repo.replace(/[\\/]+$/, "")).replace(/\.git$/, "");
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

export function addSource(lib: Library, spec: string, opts: AddOptions): AddResult {
  const { repo, ref: askedRef } = parseSpec(spec);
  // the config as the file holds it, so add changes one entry and nothing else
  const config = lib.hasConfig() ? readConfigRaw(lib.configFile) : { version: 1, sources: {}, plugins: {} };
  const sources = (config.sources ?? {}) as Record<string, Source>;
  const id = opts.id ?? defaultId(repo);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return { ok: false, error: `source id ${id} must be lowercase letters, digits and dashes; pass --id` };
  if (sources[id]) return { ok: false, error: `source ${id} is already declared in ${path.basename(lib.configFile)}; edit it there, or pass --id for a second entry` };
  const plugins = (config.plugins ?? {}) as Record<string, Plugin>;
  const pluginId = opts.plugin === false ? null : opts.plugin ?? id;
  if (pluginId !== null && !/^[a-z0-9][a-z0-9-]*$/.test(pluginId)) return { ok: false, error: `plugin id ${pluginId} must be lowercase letters, digits and dashes; pass --plugin` };
  if (pluginId !== null && plugins[pluginId]) return { ok: false, error: `plugin ${pluginId} is already declared in ${path.basename(lib.configFile)}; pass --plugin <id> for another name, or --no-plugin` };
  const url = cloneUrl(repo);
  const ref = askedRef ?? defaultBranch(url) ?? "main";
  const r = stage(url, ref, opts.log);
  if (!r.ok) return r;
  const fail = (error: string): AddResult => {
    discard(r.staged);
    return { ok: false, error };
  };
  const root = opts.root ?? (isDir(path.join(r.staged.dir, "skills")) ? "skills" : undefined);
  const found = findSkills(r.staged.dir, root);
  if (!found.size) return fail(`no skill folders under ${root ?? "the root"} of ${repo}; pass --root`);
  const names = !opts.skills || opts.skills === "*" ? [...found.keys()].sort(cmp) : opts.skills;
  const unknown = names.filter((n) => !found.has(n));
  if (unknown.length) return fail(`not under ${root ?? "the root"} of ${repo}: ${unknown.join(", ")}; it has ${[...found.keys()].sort(cmp).join(", ")}`);
  const notSelected = Object.keys(opts.as).filter((n) => !names.includes(n));
  if (notSelected.length) return fail(`--as names skills that are not selected: ${notSelected.join(", ")}`);
  const skills = Object.keys(opts.as).length ? Object.fromEntries(names.map((n) => [n, opts.as[n] ?? n])) : names;
  const attribution = findAttribution(r.staged.dir, root);
  const entry: Source = { repo, ref, ...(root ? { root } : {}), skills, ...(attribution.length ? { attribution } : {}) };
  config.sources = { ...sources, [id]: entry };
  const plugin = pluginId === null ? null : { id: pluginId, entry: { displayName: displayName(pluginId), source: id } };
  if (plugin) config.plugins = { ...plugins, [plugin.id]: plugin.entry };
  return { ok: true, id, entry, plugin, config, staged: r.staged, found };
}

/** frontend-design -> Frontend Design: the plugin's display name until someone writes a better one in the config. */
function displayName(id: string): string {
  return id.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The LICENSE (and README) nearest the skill folders: the folder holding `root` first, then each parent up to the
 * repo root; the first folder with a license file wins, so pstack/skills takes pstack/LICENSE, not a repo-level one.
 */
function findAttribution(checkout: string, root: string | undefined): string[] {
  const dirs: string[] = [];
  for (let d = root ? path.posix.dirname(root.split("\\").join("/")) : "."; ; d = path.posix.dirname(d)) {
    dirs.push(d === "." ? "" : d);
    if (d === "." || d === "/") break;
  }
  const present = (dir: string, names: string[]) => names.map((n) => (dir ? `${dir}/${n}` : n)).filter((f) => fs.existsSync(path.join(checkout, f)));
  for (const dir of dirs) {
    const license = present(dir, ["LICENSE", "LICENSE.md", "LICENSE.txt"]);
    if (license.length) return [...license, ...present(dir, ["README.md"])];
  }
  return present("", ["README.md"]);
}
