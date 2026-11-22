import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasLinkedParent, isDir, isLink, lexists, linkTarget, real, samePath, toHash, under } from "./fs.js";
import { Library } from "./library.js";
import { apply, Report } from "./plan.js";
import { readConfig } from "./sources.js";
import {
  PLUGINS_END,
  PLUGINS_START,
  SKILLS_DEV_END,
  SKILLS_DEV_START,
  blockIn,
  pluginSwitches,
  withoutBlock,
} from "./codex-toml.js";
import { developmentMarketplace } from "./develop-codex.js";

const START = SKILLS_DEV_START;
const END = SKILLS_DEV_END;
interface Receipt {
  version: 1;
  library: string;
  links: Record<string, string>;
}

/** Enumerate installed skills using the paths the loader sees, without following cycles. */
export function externalSkills(roots: string[], workspace: string): string[] {
  const files = new Set<string>();
  const walk = (dir: string, ancestors: Set<string>) => {
    if (!isDir(dir) || under(real(dir), real(workspace)) || ancestors.has(real(dir))) return;
    const next = new Set([...ancestors, real(dir)]);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".system", ".git", "node_modules"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.name === "SKILL.md" && entry.isFile()) {
        files.add(file);
        files.add(real(file));
      } else if (entry.isDirectory() || entry.isSymbolicLink()) walk(file, next);
    }
  };
  for (const root of roots) walk(root, new Set());
  return [...files].sort();
}

/**
 * Refuse an existing project skill policy rather than overwriting it. develop setup's block (a Development project's,
 * develop-codex.ts) is skills-sync's too: it stays as it is, and the plugins it switches are left out of this block, so
 * no key is set twice.
 */
export function developmentConfig(before: string, disabled: string[], plugins: string[] = []): string {
  const start = before.indexOf(START);
  const end = before.indexOf(END);
  if (start < 0 !== end < 0 || (start >= 0 && end < start)) throw new Error("Incomplete development config markers");
  const rest = start < 0 ? before : before.slice(0, start) + before.slice(end + END.length).replace(/^\r?\n/, "");
  if (rest.includes(START) || rest.includes(END)) throw new Error("Duplicate development config markers");
  const setup = blockIn(rest, PLUGINS_START, PLUGINS_END);
  const theirs = setup ? pluginSwitches(setup) : new Map();
  plugins = plugins.filter((id) => !theirs.has(id));
  const scan = withoutBlock(rest, PLUGINS_START, PLUGINS_END);
  const rootSettings = scan.split(/^\s*\[/m)[0];
  if (/^\s*\[\[?\s*["']?skills(?:["']|\.|\s|\])/m.test(scan) || /^\s*["']?skills["']?\s*[.=]/m.test(rootSettings))
    throw new Error("Existing project skills configuration needs an explicit merge; left untouched");
  if (
    plugins.length &&
    (/^\s*\[\[?\s*["']?plugins(?:["']|\.|\s|\])/m.test(scan) || /^\s*["']?plugins["']?\s*[.=]/m.test(rootSettings))
  )
    throw new Error("Existing project plugins configuration needs an explicit merge; left untouched");
  const entries = disabled.map((file) => `  { path = ${JSON.stringify(file.replace(/\\/g, "/"))}, enabled = false },`);
  const pluginTables = plugins.map((id) => `\n[plugins.${JSON.stringify(id)}]\nenabled = false\n`).join("");
  return `${rest.trimEnd()}${rest.trim() ? "\n\n" : ""}${START}\n# Generated local paths; rerun pnpm skills:dev after external plugin updates.\n# Some Codex versions ignore project skills.config; plugin switches below still apply.\n[skills]\nconfig = [\n${entries.join("\n")}\n]\n${pluginTables}${END}\n`;
}

/** Live links stay inside the workspace. User directories and global settings are read only. */
export function develop(
  lib: Library,
  workspace: string,
  options: { plan: boolean; home?: string; codexHome?: string },
): Report {
  const report = new Report();
  const conflict = (file: string, note: string) => report.add({ kind: "conflict", path: file, note });
  workspace = path.resolve(workspace);
  if (!isDir(workspace) || !under(real(lib.root), real(workspace)) || !lib.hasConfig()) {
    conflict(workspace, "The library must be an existing package inside this workspace");
    return report;
  }
  const own = lib.scanOwn();
  for (const ignored of own.ignored) conflict(ignored.path, ignored.note);
  const skills = lib.workingSet();
  for (const skill of own.skills) skills.set(skill.name, skill.dir);
  const lock = lib.lock();
  if (!lock) conflict(lib.lockFile, "Missing source lock; restore the library before develop");
  for (const source of Object.values(lock?.sources ?? {})) {
    for (const name of Object.keys(source.skills))
      if (!skills.has(name)) conflict(lib.agents, `Missing ${name}; run refresh --frozen before develop`);
  }
  if (!skills.size) conflict(lib.own, "No skills to install");
  const receiptPath = path.join(workspace, ".agents", "skills-sync-development.json");
  const configPath = path.join(workspace, ".codex", "config.toml");
  const roots = [".agents/skills", ".claude/skills"];
  for (const file of [receiptPath, configPath, ...roots.map((r) => path.join(workspace, r))])
    if (hasLinkedParent(file)) conflict(file, "Destination or parent is a link; left untouched");
  if (report.conflicts().length) return report;
  let previous: Receipt = { version: 1, library: lib.root, links: {} };
  if (lexists(receiptPath)) {
    try {
      previous = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Receipt;
      if (
        previous.version !== 1 ||
        !samePath(previous.library, lib.root) ||
        !previous.links ||
        typeof previous.links !== "object"
      )
        throw new Error("Receipt belongs to another library or is invalid");
    } catch (error) {
      conflict(receiptPath, String(error));
      return report;
    }
  }
  const links: Record<string, string> = {};
  for (const [name, target] of skills) {
    if (path.basename(name) !== name || !under(real(target), real(lib.root))) {
      conflict(target, "Skill must be a folder inside the source package");
      continue;
    }
    for (const root of roots) links[`${root}/${name}`] = real(target);
  }
  for (const [relative, oldTarget] of Object.entries(previous.links)) {
    if (links[relative]) continue;
    const destination = path.resolve(workspace, relative);
    if (!roots.some((root) => samePath(path.dirname(destination), path.join(workspace, root)))) {
      conflict(receiptPath, "Receipt contains a destination outside the skill roots");
    } else if (lexists(destination)) {
      if (isLink(destination) && samePath(linkTarget(destination) ?? "", oldTarget))
        report.add({ kind: "remove", path: destination });
      else conflict(destination, "Previously installed skill was changed; left untouched");
    }
  }
  for (const [relative, target] of Object.entries(links)) {
    const destination = path.join(workspace, relative);
    if (!lexists(destination)) report.add({ kind: "link", path: destination, target });
    else if (isLink(destination) && samePath(real(destination), target))
      report.add({ kind: "skip", path: destination });
    else if (
      isLink(destination) &&
      previous.links[relative] &&
      samePath(linkTarget(destination) ?? "", previous.links[relative])
    )
      report.add({ kind: "relink", path: destination, target });
    else conflict(destination, "Existing skill is not this installation's link; left untouched");
  }
  const home = options.home ?? os.homedir();
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex");
  const cache = path.join(codexHome, "plugins", "cache");
  const pluginIds = Object.keys(readConfig(lib.configFile).plugins);
  // the Library's development marketplace is develop setup's to switch, per Development project (develop-codex.ts)
  const dev = developmentMarketplace(lib);
  const markets = isDir(cache) ? fs.readdirSync(cache).filter((marketplace) => marketplace !== dev) : [];
  const plugins = isDir(cache)
    ? markets
        .flatMap((marketplace) =>
          pluginIds.filter((id) => isDir(path.join(cache, marketplace, id))).map((id) => `${id}@${marketplace}`),
        )
        .sort()
    : [];
  const disabled = externalSkills(
    [
      path.join(home, ".agents", "skills"),
      path.join(codexHome, "skills"),
      ...markets.map((mk) => path.join(cache, mk)),
    ],
    workspace,
  );
  const write = (file: string, content: string) => {
    const before = lexists(file) ? fs.readFileSync(file) : null;
    if (before?.toString() !== content)
      report.add({ kind: "write", path: file, payload: content, expectedHash: before ? toHash(before) : null });
  };
  try {
    write(
      configPath,
      developmentConfig(lexists(configPath) ? fs.readFileSync(configPath, "utf8") : "", disabled, plugins),
    );
  } catch (error) {
    conflict(configPath, String(error));
  }
  write(receiptPath, JSON.stringify({ version: 1, library: lib.root, links } satisfies Receipt, null, 2) + "\n");
  if (report.conflicts().length) return report;
  apply(report, options.plan);
  report.add({
    kind: "note",
    path: workspace,
    note: `${skills.size} live skills; ${plugins.length} duplicate library plugins disabled for this workspace. Requested exclusions for ${disabled.length} external skill paths; some Codex versions ignore project skill rules. Verify in a fresh chat. Global and Claude plugin settings are unchanged.`,
  });
  return report;
}
