// One form per harness (ADR-0007): the plugin form wherever the harness has a plugin route, the loose-skill form only
// where it has none. Claude Code gets the account plugins claude.ai delivers, Codex the library's marketplace from
// GitHub, Hermes loose skills until its plugin probe passes. Goose is dropped. desired() turns the release and the probe
// into the plan sync applies: per harness the managed block in its global instructions file (ADR-0011), a cleanup line
// for every block an older skills-sync left in a repository, and, outside the cloud, whatever the harness's form module
// in src/forms/ asks for. --plan and apply share this one code path; only apply() differs.
import { blockAction } from "./block.js";
import type { HarnessState, Machine } from "./machine.js";
import { Report, type Action } from "./plan.js";
import type { Release } from "./release.js";

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

/**
 * A harness's form module (src/forms/<harness>.ts): from the release (null when GitHub could not be read), the
 * harness's probed state and the machine, the actions that bring the harness to its form. Never called in the cloud,
 * where the block is the whole sync (ADR-0007: claude.ai delivers the account plugins; nothing else is installed).
 */
export type FormFn = (release: Release | null, state: HarnessState, machine: Machine) => Action[];

export interface DesiredOptions {
  /** only these harness ids (--agents); every detected one when unset */
  agents?: string[];
}

/** The plan: what every harness on this machine should have, against what the probe found. Pure; nothing written. */
export function desired(
  release: Release | null,
  machine: Machine,
  forms: Record<string, FormFn>,
  options: DesiredOptions = {},
): Report {
  const report = new Report();
  for (const state of machine.harnesses) {
    const id = state.harness.id;
    if (!formOf(id) || (options.agents && !options.agents.includes(id))) continue;
    if (state.block) report.add(blockAction(state.block.file));
    for (const old of state.repoBlocks)
      report.add({
        kind: "note",
        path: old.file,
        note: `skills-sync block (${old.ids.join(", ")}) in a repository file; remove it by hand, the block lives only in ${state.harness.name}'s global file now`,
      });
    if (!machine.cloud) for (const a of forms[id]?.(release, state, machine) ?? []) report.add(a);
  }
  return report;
}
