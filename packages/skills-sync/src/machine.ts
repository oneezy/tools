// The probe: which harnesses this machine has and what each one holds right now, read on every run and never written
// down (ADR-0012). Per harness: the account plugins claude.ai delivered (<id>@synced), the plugins installed through the
// harness's own CLI (from the library's catalog, or from anywhere else), the loose links in its user skills folder and
// where they point, the real skill folders there, the state of the managed block in its global instructions file, the
// session hook entry in its user hooks file, and the blocks an older skills-sync left in repository files. For the
// machine: what an older version left behind, the clone or link at ~/.skills-sync and its answers file, detected and
// reported, never read. The plugin CLIs are asked through install.ts's runner, read-only listings only; when a CLI is
// missing, the account plugins are read from their folders instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalFile, readBlock, repoBlocks, type BlockState, type RepoBlock } from "./block.js";
import { LOCAL_NAME } from "./config.js";
import { isDir, isLink, isSkillDir, lexists, linkTarget, real, under } from "./fs.js";
import { detected, RESERVED, type Harness } from "./harnesses.js";
import { readHook, type HookState } from "./hooks.js";
import {
  codexPluginSkills,
  harnessCli,
  listInstalled,
  listMarketplaces,
  runner,
  supportsPlugins,
  type Marketplace,
} from "./install.js";
import { homeLibrary } from "./library.js";
import type { Action } from "./plan.js";

/** The library's catalog name when the release's config names none: the marketplace a plugin this tool installed comes from. */
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
  /** the marketplaces the harness's CLI lists (Codex: the library's from GitHub or an old local folder); empty when it cannot */
  marketplaces: Marketplace[];
  loose: LooseLink[];
  folders: SkillFolder[];
  /** the managed block in the harness's global instructions file; null when its table row names no such file */
  block: BlockState | null;
  /** blocks an older skills-sync left outside the global file (repository files, AGENTS.override.md): reported, never edited */
  repoBlocks: RepoBlock[];
  /** the session hook entry in the harness's user hooks file (ADR-0010); null when its table row names no such file */
  hook: HookState | null;
}

/** The old tool's ~/.skills-sync: a link to its library clone, or the clone itself. Detected; never read, never removed. */
export interface OldLibrary {
  path: string;
  kind: "link" | "folder";
  /** where the link points, for a link */
  target?: string;
}

export interface Machine {
  /** a claude.ai cloud session (CLAUDE_CODE_REMOTE=true) */
  cloud: boolean;
  harnesses: HarnessState[];
  /** ~/.skills-sync when it exists: the old library clone or the link to it; nothing reads it any more */
  oldLibrary: OldLibrary | null;
  /** the old tool's skills-sync.local.json inside that clone, when it exists; nothing reads it any more */
  oldLocalFile: string | null;
}

/**
 * `cwd` is where the run happens: a repository's instruction files there are looked at for old blocks. The projects
 * the old local file remembered are not: that file is a leftover now, reported and never read (ADR-0012); a block in
 * another repository is found by running there, where its harness would read it.
 */
export function probe(table: Harness[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Machine {
  const found = detected(table);
  const roots = [path.resolve(cwd)];
  const globals = found.map(globalFile).filter((f): f is string => !!f);
  const hl = homeLibrary(os.homedir());
  const local = path.join(hl, LOCAL_NAME);
  return {
    cloud: isCloud(env),
    harnesses: found.map((h) => probeHarness(h, env, roots, globals)),
    oldLibrary: oldLibrary(hl),
    oldLocalFile: lexists(local) ? local : null,
  };
}

/** A claude.ai cloud session: the container sets CLAUDE_CODE_REMOTE=true. */
export function isCloud(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

function oldLibrary(hl: string): OldLibrary | null {
  if (!lexists(hl)) return null;
  if (isLink(hl)) return { path: hl, kind: "link", target: linkTarget(hl) ?? "?" };
  return isDir(hl) ? { path: hl, kind: "folder" } : null;
}

/**
 * One note each for what an older version left behind: the clone (or link) at ~/.skills-sync and the answers file
 * beside it. Nothing reads them any more; deleting them is a human's. `text` is the line status prints.
 */
export function oldStateNotes(machine: Machine): Array<{ action: Action; text: string }> {
  const out: Array<{ action: Action; text: string }> = [];
  const lib = machine.oldLibrary;
  const tail = "nothing reads it any more, delete it by hand";
  if (lib) {
    const how = lib.kind === "link" ? `link -> ${lib.target}` : "folder";
    out.push({
      action: {
        kind: "note",
        path: lib.path,
        ...(lib.target ? { target: lib.target } : {}),
        note: `the old library ${lib.kind === "link" ? "link" : "clone"}; ${tail}`,
      },
      text: `${lib.path} (${how}) is the old library clone; ${tail}`,
    });
  }
  if (machine.oldLocalFile)
    out.push({
      action: { kind: "note", path: machine.oldLocalFile, note: `the old tool's answers file; ${tail}` },
      text: `${machine.oldLocalFile} is the old tool's answers file; ${tail}`,
    });
  return out;
}

/**
 * Is `target`, where a loose link points, a copy the tool made? Inside a checkout or clone of the library (a
 * skills-sync.json naming the release repo's owner and name at some ancestor), inside ~/.skills-sync or what it points
 * at, or gone (a clone that moved or was deleted leaves its links dangling). Anything else is the user's. The one
 * definition of "the tool's leftover" for a link, for the forms and for unlink.
 */
export function libraryCopy(target: string, repo: string, home = os.homedir()): boolean {
  if (!lexists(target)) return true;
  const hl = homeLibrary(home);
  if (under(target, hl) || under(target, real(hl))) return true;
  const [owner, name] = repo.toLowerCase().split("/");
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    const lib = readJson(path.join(dir, "skills-sync.json"))?.library as Record<string, unknown> | undefined;
    if (lib && String(lib.owner).toLowerCase() === owner && String(lib.name).toLowerCase() === name) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

function probeHarness(h: Harness, env: NodeJS.ProcessEnv, roots: string[], globals: string[]): HarnessState {
  const file = globalFile(h);
  const state: HarnessState = {
    harness: h,
    cli: null,
    synced: [],
    installed: [],
    marketplaces: [],
    loose: [],
    folders: [],
    block: file ? readBlock(file) : null,
    repoBlocks: [
      ...repoBlocks(roots, h.projectInstructions ?? [], globals),
      ...repoBlocks([h.configDir], (h.userInstructions ?? []).slice(1), globals),
    ],
    hook: readHook(h),
  };
  const cli = harnessCli(h, env);
  if (cli) {
    state.cli = cli.file;
    if (!cli.file) state.note = `no ${cli.bin} on PATH`;
    else {
      const run = runner(cli.file);
      const listed = supportsPlugins(run) ? listInstalled(h, run) : null;
      if (!listed) state.note = `${cli.bin} cannot list its plugins`;
      else {
        state.marketplaces = listMarketplaces(h, run) ?? [];
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
