// unlink, a machine command: take away what this tool put on the machine, and only that. Per detected harness with a
// form: the plugins installed from the library's catalog (installed[].marketplace is the catalog name) and the catalog's
// registration once none of them remains, through the harness's own plugin commands; every loose link in its skills
// folders (Codex's old folder too) that points into a library copy or at nothing; its session hook entry in the
// harness's user hooks file (hooks.ts; the file itself when it held nothing else); the skills block in its global
// instructions file (likewise). Account plugins, plugins from other marketplaces, real skill folders, links to anywhere
// else, other hook entries, Codex's trust record and blocks in repository files are never touched. Offline: no release
// is read, so the library is --library's repo or the default, and the catalog name is the one its build gives its
// marketplaces (<owner>-<name>). A harness that cannot list its plugins keeps its registration: on Claude Code removing
// it would take every plugin from it, unseen. Hermes has no marketplace: the tool's plugins there are the ones hermes
// recorded as installed from the library repository (`hermes plugins install owner/repo/...`, read from its files by
// the probe), removed with `hermes plugins remove <id>`; a folder hermes did not record, or one from another repository,
// stays. Under --plan no plugin command that changes anything runs and apply() writes nothing; the caller exits 1 when
// anything is red.
import os from "node:os";
import path from "node:path";
import { blockRemoval } from "../block.js";
import { catalogFor, formOf } from "../desired.js";
import { lexists } from "../fs.js";
import { harnessTable } from "../harnesses.js";
import { githubRepo } from "../hermes.js";
import { hookRemoval } from "../hooks.js";
import {
  hermes,
  listMarketplaces,
  refused,
  removeMarketplace,
  runner,
  supportsPlugins,
  uninstallPlugin,
} from "../install.js";
import { libraryCopy, oldStateNotes, probe, type HarnessState, type Machine } from "../machine.js";
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
    const taken =
      state.harness.id === "hermes"
        ? hermesPlugins(state, options.repo, options.plan)
        : plugins(state, options.repo, options.plan);
    for (const a of taken) report.add(a);
    for (const l of state.loose)
      if (!l.target) report.add({ kind: "note", path: l.path, note: "a link whose target cannot be read; left alone" });
      else if (libraryCopy(l.target, options.repo, home))
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
function plugins(state: HarnessState, repo: string, plan: boolean): Action[] {
  const out: Action[] = [];
  if (!state.cli) return out;
  const catalog = catalogFor(repo);
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
  // the probe could not list the plugins: whatever is installed from the catalog was never seen, so its registration
  // stays (Claude Code's remove would take every plugin from it)
  if (state.note?.endsWith("cannot list its plugins")) {
    out.push({
      kind: "note",
      path: where(`marketplace ${catalog}`),
      note: "plugins could not be listed; marketplace left (removing it would take every plugin from it, unseen)",
    });
    return out;
  }
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

/**
 * Hermes's plugins from the library: the ones hermes recorded as installed from the library repository (the probe read
 * its install rows), removed one by one with `hermes plugins remove`, which drops the folder, the row and the config
 * entry. Nothing else under <home>/plugins is the tool's. Without hermes on PATH they are named and stay.
 */
function hermesPlugins(state: HarnessState, repo: string, plan: boolean): Action[] {
  const out: Action[] = [];
  const mine = state.installed
    .filter((p) => p.install && githubRepo(p.install.url) === repo.toLowerCase())
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!mine.length) return out;
  const where = (what: string) => `${state.harness.name}: ${what}`;
  const ids = mine.map((p) => p.id).join(", ");
  if (!state.cli) {
    out.push({
      kind: "note",
      path: where("plugins"),
      note: `no ${hermes.bin} on PATH; ${ids} installed from ${repo} stay`,
    });
    return out;
  }
  const run = runner(state.cli);
  if (!hermes.supports(run)) {
    out.push({
      kind: "conflict",
      path: where("plugins"),
      note: `this ${hermes.bin} has no plugins command; ${ids} installed from ${repo} stay`,
      ...(run.failure ? { diagnostic: run.failure } : {}),
    });
    return out;
  }
  for (const p of mine) {
    const a: Action = { kind: "uninstall", path: where(`plugin ${p.id}`), note: `installed by this tool from ${repo}` };
    out.push(a);
    if (!plan && !hermes.remove(run, p.id)) refused(a, run, `${hermes.bin} could not remove it`);
  }
  return out;
}
