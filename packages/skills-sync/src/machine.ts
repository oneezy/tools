// The probe: which harnesses this machine has and what each one holds right now, read on every run and never written
// down (ADR-0012). Per harness: the account plugins claude.ai delivered (<id>@synced), the plugins installed through the
// harness's own CLI (from the library's catalog, or from anywhere else), the loose links in its user skills folder and
// where they point, and the real skill folders there. The plugin CLIs are asked through install.ts's runner, read-only
// listings only; when a CLI is missing, the account plugins are read from their folders instead.
import fs from "node:fs";
import path from "node:path";
import { isDir, isLink, isSkillDir, linkTarget } from "./fs.js";
import { detected, RESERVED, type Harness } from "./harnesses.js";
import { codexPluginSkills, harnessCli, listInstalled, runner, supportsPlugins } from "./install.js";

/** The library's catalog name: the marketplace a plugin this tool installed comes from, on Claude Code and Codex. */
export const LIBRARY_MARKETPLACE = "oneezy-skills";

/** An account plugin: claude.ai syncs it into <claudeHome>/plugins/synced/<org>_<bucket>/<folder>/. */
export interface AccountPlugin {
  /** the plugin's name, without @synced */
  id: string;
  /** from the folder's plugin.json (the library's version); null when it has none */
  version: string | null;
  skills: string[];
  path: string;
  /** the claude.ai marketplace label the bucket's manifest records (Justin's library is "skills"); null when unknown */
  marketplace: string | null;
  /** switched off at claude.ai: listed, never judged; true when read from the folders without the CLI */
  enabled: boolean;
}

/** A plugin installed through the harness's CLI: <id>@<marketplace>. */
export interface CliPlugin {
  id: string;
  marketplace: string;
  version: string | null;
  /** the skills it carries; null when they could not be read (Codex without its prompt input) */
  skills: string[] | null;
  enabled: boolean;
  /** where the harness reads it from, when it says */
  path: string | null;
}

export interface LooseLink {
  name: string;
  path: string;
  target: string;
}

export interface SkillFolder {
  name: string;
  path: string;
}

export interface HarnessState {
  harness: Harness;
  /** the harness's plugin CLI on PATH; null when the harness has none or it is not installed */
  cli: string | null;
  /** why plugins, or their skills, could not be listed through the CLI, when they could not */
  note?: string;
  synced: AccountPlugin[];
  installed: CliPlugin[];
  loose: LooseLink[];
  folders: SkillFolder[];
}

export interface Machine {
  /** a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) */
  cloud: boolean;
  harnesses: HarnessState[];
}

export function probe(table: Harness[], env: NodeJS.ProcessEnv = process.env): Machine {
  return { cloud: env.CLAUDE_CODE_REMOTE === "true", harnesses: detected(table).map((h) => probeHarness(h, env)) };
}

function probeHarness(h: Harness, env: NodeJS.ProcessEnv): HarnessState {
  const state: HarnessState = { harness: h, cli: null, synced: [], installed: [], loose: [], folders: [] };
  const cli = harnessCli(h, env);
  if (cli) {
    state.cli = cli.file;
    if (!cli.file) state.note = `no ${cli.bin} on PATH`;
    else {
      const run = runner(cli.file);
      const listed = supportsPlugins(run) ? listInstalled(h, run) : null;
      if (!listed) state.note = `${cli.bin} cannot list its plugins`;
      else {
        // Codex names no folder for a plugin; its loaded skills come from the prompt input it renders locally
        let codexSkills: Map<string, string[]> | null = null;
        if (h.id === "codex" && listed.length) {
          codexSkills = codexPluginSkills(run);
          if (!codexSkills) state.note = `${cli.bin} cannot list its plugin skills`;
        }
        for (const p of listed) {
          if (p.scope === "synced" || p.marketplace === "synced") {
            if (p.folder) state.synced.push(accountPlugin(p.name, p.folder, p.version, p.enabled));
          } else
            state.installed.push({
              id: p.name,
              marketplace: p.marketplace,
              version: p.version,
              enabled: p.enabled,
              path: p.folder,
              // no folder and no prompt input: the skills are unknown, not none
              skills: p.folder ? skillsIn(p.folder) : codexSkills ? (codexSkills.get(p.name) ?? []) : null,
            });
        }
      }
    }
  }
  // the account plugins are folders claude.ai wrote: without the CLI they are read from there
  if (h.id === "claude-code" && state.note) state.synced = scanSynced(h.configDir);
  for (const dir of [h.userSkills, ...(h.legacyUserSkills ?? [])]) {
    if (!isDir(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      // the harness's own entries (.system, synced) and dot names are never a skill, link or folder
      if (RESERVED.has(name) || name.startsWith(".")) continue;
      const p = path.join(dir, name);
      if (isLink(p)) state.loose.push({ name, path: p, target: linkTarget(p) ?? "" });
      else if (isSkillDir(p)) state.folders.push({ name, path: p });
    }
  }
  return state;
}

/** The skill folder names under <dir>/skills, sorted. */
export function skillsIn(dir: string): string[] {
  const skills = path.join(dir, "skills");
  if (!isDir(skills)) return [];
  return fs
    .readdirSync(skills)
    .filter((n) => isSkillDir(path.join(skills, n)))
    .sort();
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A field of the plugin's manifest: the root plugin.json as the library writes it, else the Claude manifest (claude.ai's
 * own plugins, such as design, live in a UUID folder with only that one).
 */
function manifestField(dir: string, field: "name" | "version"): string | null {
  for (const file of ["plugin.json", path.join(".claude-plugin", "plugin.json")]) {
    const v = readJson(path.join(dir, file))?.[field];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/** The claude.ai marketplace label of an account plugin, from <folder>.meta.json beside it, else the bucket's manifest. */
function accountMarketplace(dir: string): string | null {
  const bucket = path.dirname(dir);
  const meta = readJson(path.join(bucket, `${path.basename(dir)}.meta.json`));
  if (typeof meta?.marketplace_name === "string") return meta.marketplace_name;
  const manifest = readJson(path.join(bucket, "manifest.json"));
  const entry = Array.isArray(manifest?.plugins)
    ? (manifest.plugins as Array<Record<string, unknown>>).find((p) => p?.name === path.basename(dir))
    : undefined;
  return typeof entry?.marketplaceName === "string" ? entry.marketplaceName : null;
}

function accountPlugin(id: string, dir: string, listedVersion: string | null, enabled: boolean): AccountPlugin {
  const version =
    manifestField(dir, "version") ?? (listedVersion && listedVersion !== "unknown" ? listedVersion : null);
  return { id, version, skills: skillsIn(dir), path: dir, marketplace: accountMarketplace(dir), enabled };
}

/** Without the CLI: every plugin folder under plugins/synced/<bucket>/, the bucket's manifest and meta files skipped. */
function scanSynced(configDir: string): AccountPlugin[] {
  const root = path.join(configDir, "plugins", "synced");
  if (!isDir(root)) return [];
  const out: AccountPlugin[] = [];
  for (const bucket of fs.readdirSync(root).sort()) {
    const dir = path.join(root, bucket);
    if (bucket.startsWith(".") || !isDir(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (name.startsWith(".") || !isDir(p)) continue;
      out.push(accountPlugin(manifestField(p, "name") ?? name, p, null, true));
    }
  }
  return out;
}
