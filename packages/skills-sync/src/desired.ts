// One form per harness (ADR-0007): the plugin form wherever the harness has a plugin route, the loose-skill form only
// where it has none. Claude Code gets the account plugins claude.ai delivers, Codex the library's marketplace from
// GitHub, Hermes loose skills until its plugin probe passes. Goose is dropped. desired() turns the release and the probe
// into the plan sync applies: a note for what an older version left on the machine, then per harness the managed block
// in its global instructions file (ADR-0011), a cleanup line for every block an older skills-sync left in a repository,
// and, outside the cloud, whatever the harness's form module in src/forms/ asks for. The release's skills-sync.json
// (ADR-0012) says which harnesses are served and which plugins each gets; pluginsFor() is the one place a form reads its
// plugin list. --plan and apply share this one code path; only apply() differs.
import { blockAction } from "./block.js";
import { LIBRARY_MARKETPLACE, oldStateNotes, type HarnessState, type Machine } from "./machine.js";
import { Report, type Action } from "./plan.js";
import type { Release, ReleasePlugin } from "./release.js";

export type MachineForm = "account-plugins" | "github-plugins" | "loose";

/** What a user reads for each form. */
export const FORM_LABEL: Record<MachineForm, string> = {
  "account-plugins": "account plugins",
  "github-plugins": "plugins from GitHub",
  loose: "loose skills",
};

/** The form a harness gets; null for a harness this tool no longer serves. */
export function formOf(harnessId: string): MachineForm | null {
  switch (harnessId) {
    case "claude-code":
      return "account-plugins";
    case "codex":
      return "github-plugins";
    case "hermes":
      return "loose";
    default:
      return null;
  }
}

/** What a form module is told about the run. */
export interface FormOptions {
  /** --plan: say what would be done, run no plugin command that changes anything (read-only listings are fine) */
  plan: boolean;
}

/**
 * A harness's form module (src/forms/<harness>.ts): from the release (null when GitHub could not be read), the
 * harness's probed state and the machine, the actions that bring the harness to its form. Never called in the cloud,
 * where the block is the whole sync (ADR-0007: claude.ai delivers the account plugins; nothing else is installed).
 * Plugin commands go through install.ts's drivers from inside the form, outside --plan, and come back as install and
 * uninstall actions (records of what ran, or would run); apply() runs the file actions (link, remove, write, ...).
 */
export type FormFn = (release: Release | null, state: HarnessState, machine: Machine, options: FormOptions) => Action[];

/** The catalog name the library's plugins come from on Claude Code and Codex: the release's config names it, else the constant. */
export function catalogOf(release: Release | null): string {
  return release?.config?.catalog ?? LIBRARY_MARKETPLACE;
}

/** Whether the release's config serves this harness: every detected one, unless machines.harnesses names a list. */
export function serves(release: Release | null, harnessId: string): boolean {
  const list = release?.config?.harnesses;
  return !list || list.includes(harnessId);
}

/**
 * The release plugins a harness gets, sorted by id: every one the release ships, narrowed to the ids the release's
 * config names for the harness (machines.plugins.<harness>, else machines.plugins["*"]) when it names any. An id the
 * release does not ship is nothing. The one place a form module takes its plugin list from.
 */
export function pluginsFor(release: Release, harnessId: string): ReleasePlugin[] {
  const chosen = release.config?.plugins[harnessId] ?? release.config?.plugins["*"];
  return Object.values(release.plugins)
    .filter((p) => !chosen || chosen.includes(p.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface DesiredOptions {
  /** --plan: the forms run no plugin command that changes anything */
  plan?: boolean;
}

/**
 * The plan: what every harness on this machine should have, against what the probe found. Nothing is written here;
 * outside --plan the form modules may run their harness's plugin commands (recorded as install/uninstall actions).
 */
export function desired(
  release: Release | null,
  machine: Machine,
  forms: Record<string, FormFn>,
  options: DesiredOptions = {},
): Report {
  const report = new Report();
  for (const old of oldStateNotes(machine)) report.add(old.action);
  for (const state of machine.harnesses) {
    const id = state.harness.id;
    if (!formOf(id)) continue;
    if (!serves(release, id)) {
      report.add({
        kind: "note",
        path: state.harness.name,
        note: `not served: the release's skills-sync.json names harnesses ${release!.config!.harnesses!.join(", ")}; nothing changed here`,
      });
      continue;
    }
    if (state.block) report.add(blockAction(state.block.file));
    for (const old of state.repoBlocks)
      report.add({
        kind: "note",
        path: old.file,
        note: `skills-sync block (${old.ids.join(", ")}) outside the global file; remove it by hand, the block lives only in ${state.harness.name}'s global file now`,
      });
    if (!machine.cloud)
      for (const a of forms[id]?.(release, state, machine, { plan: !!options.plan }) ?? []) report.add(a);
  }
  return report;
}
