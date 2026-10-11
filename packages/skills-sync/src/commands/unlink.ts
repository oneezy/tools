// unlink, a machine command: take away what this tool put on the machine, and only that. Per detected harness with a
// form: the plugins installed from the library's catalog (installed[].marketplace is the catalog name) and the catalog's
// registration once none of them remains, through the harness's own plugin commands; every loose link in its skills
// folders (Codex's old folder too) that points into a library copy or at nothing; its session hook entry in the
// harness's user hooks file (hooks.ts; the file itself when it held nothing else); the skills block in its global
// instructions file (likewise). Account plugins, plugins from other marketplaces, real skill folders, links to anywhere
// else, other hook entries, Codex's trust record and blocks in repository files are never touched. Offline: no release
// is read, so the catalog name is the library's constant and the library is --library's repo or the default. Hermes's
// plugins (tools#153) join here when its module lands. Under --plan no plugin command that changes anything runs and
// apply() writes nothing; the caller exits 1 when anything is red.
import os from "node:os";
import path from "node:path";
import { blockRemoval } from "../block.js";
import { formOf } from "../desired.js";
import { lexists } from "../fs.js";
import { harnessTable } from "../harnesses.js";
import { hookRemoval } from "../hooks.js";
import { listMarketplaces, refused, removeMarketplace, runner, supportsPlugins, uninstallPlugin } from "../install.js";
import { libraryCopy, LIBRARY_MARKETPLACE, oldStateNotes, probe, type HarnessState, type Machine } from "../machine.js";
import { apply, Report, type Action } from "../plan.js";

export interface UnlinkOptions {
  /** the library's repo, owner/repo: whose copies a link may point into */
  repo: string;
  /** show what would go, remove nothing */
  plan: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface UnlinkResult {
  report: Report;
  machine: Machine;
}

export function runUnlink(options: UnlinkOptions): UnlinkResult {
  const env = options.env ?? process.env;
  const machine = probe(harnessTable(undefined, env), env, options.cwd);
  const report = new Report();
  for (const old of oldStateNotes(machine)) report.add(old.action);
  const home = os.homedir();
  for (const state of machine.harnesses) {
    if (!formOf(state.harness.id)) continue;
    for (const a of plugins(state, options.plan)) report.add(a);
    for (const l of state.loose)
      if (libraryCopy(l.target, options.repo, home))
        report.add({
          kind: "remove",
          path: l.path,
          target: l.target,
          note: lexists(l.target) ? "a link to a library copy" : "a dangling link",
        });
    if (state.hook) {
      const a = hookRemoval(state.harness, state.hook);
      if (a) report.add(a);
    }
    if (state.block) {
      const a = blockRemoval(state.block.file);
      if (a) report.add(a);
    }
  }
  apply(report, options.plan);
  return { report, machine };
}

/**
 * The library's plugins on a harness with a plugin CLI, uninstalled one by one, then the catalog's registration once no
 * plugin from it is left (Claude Code's remove takes the catalog's plugins with it, so never while one stays). A
 * refusal turns the action into a conflict with the CLI's own words; the next plugin is still tried.
 */
function plugins(state: HarnessState, plan: boolean): Action[] {
  const out: Action[] = [];
  if (!state.cli) return out;
  const catalog = LIBRARY_MARKETPLACE;
  const bin = path.basename(state.cli).replace(/\.(cmd|bat|exe)$/i, "");
  const run = runner(state.cli);
  const where = (what: string) => `${state.harness.name}: ${what}`;
  const mine = state.installed.filter((p) => p.marketplace === catalog).sort((a, b) => a.id.localeCompare(b.id));
  let remaining = mine.length;
  for (const p of mine) {
    const id = `${p.id}@${p.marketplace}`;
    const a: Action = { kind: "uninstall", path: where(`plugin ${id}`), note: "installed by this tool" };
    out.push(a);
    if (plan || uninstallPlugin(state.harness, run, id)) remaining--;
    else refused(a, run, `${bin} could not uninstall it`);
  }
  if (remaining || !supportsPlugins(run)) return out;
  const markets = listMarketplaces(state.harness, run);
  if (markets === null) {
    out.push({
      kind: "note",
      path: where(`marketplace ${catalog}`),
      note: `${bin} could not list its marketplaces; a registration stays`,
    });
    return out;
  }
  if (!markets.some((m) => m.name === catalog)) return out;
  const a: Action = { kind: "uninstall", path: where(`marketplace ${catalog}`), note: "registered by this tool" };
  out.push(a);
  if (!plan && !removeMarketplace(state.harness, run, catalog)) refused(a, run, `${bin} could not remove it`);
  return out;
}
