// remove <source>: add in reverse. Takes a third-party source out of the config with the plugins that package it, and
// plans away what add and update made of it in the library: its lock entry, its snapshot under upstream/ and its
// working-set copies. The packages, their Hermes renderings and the catalogs follow from the build the caller runs on
// the config as written. Offline: nothing is cloned. An authored group, and a plugin without a source, are never taken.
import path from "node:path";
import { CONFIG_NAME } from "./config.js";
import { isDir, isLink, isSkillDir } from "./fs.js";
import { Library } from "./library.js";
import { lockText, readLockFile } from "./lock.js";
import { Report } from "./plan.js";
import {
  cmp,
  configText,
  githubSlug,
  lockedUpstream,
  readConfigRaw,
  selection,
  type Config,
  type Plugin,
  type Source,
} from "./sources.js";

export type RemoveResult =
  | {
      ok: true;
      id: string;
      entry: Source;
      /** the ids of the plugins that package the source, sorted */
      plugins: string[];
      /** the source's working-set names, as the lock and the config have them, sorted */
      skills: string[];
      /** the config as it is written: the source and its plugins taken out, every other entry as the file had it */
      config: Record<string, unknown>;
      /** the config write, the lock write, and the deletes of the snapshot and the working-set copies */
      report: Report;
    }
  /** code 2: the spec names no source, or more than one; 1: the source is still referenced elsewhere in the config */
  | { ok: false; code: 1 | 2; error: string };

/** The source a spec names: its id, else the one source whose repo it is (owner/repo or a GitHub URL, any case, or the repo as written). */
function findSource(
  sources: Record<string, Source>,
  plugins: Record<string, Plugin>,
  spec: string,
): { id: string } | { error: string } {
  if (sources[spec]) return { id: spec };
  const slug = githubSlug(spec)?.toLowerCase();
  const hits = Object.keys(sources)
    .filter((id) => sources[id].repo === spec || (!!slug && githubSlug(sources[id].repo)?.toLowerCase() === slug))
    .sort(cmp);
  if (hits.length === 1) return { id: hits[0] };
  if (hits.length > 1)
    return { error: `remove: ${spec} matches ${hits.length} sources (${hits.join(", ")}); name one by its id` };
  const p = plugins[spec];
  if (p?.group)
    return { error: `remove: ${spec} is an authored group (skills/${p.group}), not a source; remove never takes one` };
  if (p?.source) return { error: `remove: ${spec} is a plugin; its source is ${p.source}: remove ${p.source}` };
  const ids = Object.keys(sources).sort(cmp);
  return { error: `remove: no source ${spec} in ${CONFIG_NAME} (sources: ${ids.join(", ") || "none"})` };
}

export function removeSource(lib: Library, spec: string): RemoveResult {
  // the config as the file holds it, so remove changes the entries it names and nothing else
  const config = readConfigRaw(lib.configFile);
  const sources = (config.sources ?? {}) as Record<string, Source>;
  const plugins = (config.plugins ?? {}) as Record<string, Plugin>;
  const found = findSource(sources, plugins, spec);
  if ("error" in found) return { ok: false, code: 2, error: found.error };
  const id = found.id;
  const entry = sources[id];
  // only a plugin that names this source goes: an authored group names none
  const mine = Object.keys(plugins)
    .filter((p) => plugins[p].source === id && !plugins[p].group)
    .sort(cmp);
  // what still names one of them once they are gone: a machine's plugin list, a ChatGPT upload record
  const machines = (config.machines as Config["machines"])?.plugins ?? {};
  const releases = (config.releases ?? {}) as Record<string, unknown>;
  const refs = [
    ...Object.keys(machines)
      .sort(cmp)
      .flatMap((h) => mine.filter((p) => machines[h].includes(p)).map((p) => `machines.plugins.${h} lists ${p}`)),
    ...mine.filter((p) => releases[p]).map((p) => `releases.${p} records its upload`),
  ];
  if (refs.length)
    return {
      ok: false,
      code: 1,
      error: `remove: ${id} is still referenced in ${path.basename(lib.configFile)}: ${refs.join("; ")}; take those out first`,
    };

  const next: Record<string, unknown> = { ...config, sources: without(sources, [id]) };
  if (config.plugins) next.plugins = without(plugins, mine);
  const lock = readLockFile(lib.root);
  const locked = lock?.sources[id];
  const skills = [
    ...new Set([
      ...Object.keys(locked?.skills ?? {}),
      ...selection(entry, lockedUpstream(locked?.skills)).map((s) => s.name),
    ]),
  ].sort(cmp);

  const report = new Report();
  const note = `sources.${id}${mine.length ? ` and plugins.${mine.join(", plugins.")}` : ""} removed`;
  report.add({ kind: "write", path: lib.configFile, payload: configText(next), note });
  if (lock && locked)
    report.add({
      kind: "write",
      path: lib.lockFile,
      payload: lockText(without(lock.sources, [id])),
      note: `sources.${id} removed`,
    });
  const snapshot = path.join(lib.upstream, id);
  if (isDir(snapshot)) report.add({ kind: "delete", path: snapshot, note: `source ${id} removed` });
  // a working-set copy of its skills, never an own skill's name or a link someone made there
  const own = new Set(lib.ownSkills());
  for (const n of skills) {
    const copy = path.join(lib.agents, n);
    if (!own.has(n) && !isLink(copy) && isSkillDir(copy))
      report.add({ kind: "delete", path: copy, note: `source ${id} removed` });
  }
  return { ok: true, id, entry, plugins: mine, skills, config: next, report };
}

/** A record without the given keys, the rest in the order the file had them. */
function without<T>(record: Record<string, T>, keys: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
}
