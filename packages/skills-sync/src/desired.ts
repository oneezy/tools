// One form per harness (ADR-0007): the plugin form wherever the harness has a plugin route, the loose-skill form only
// where it has none. Claude Code gets the account plugins claude.ai delivers, Codex the library's marketplace from
// GitHub, Hermes the library's plugins straight from GitHub (hermes plugins install owner/repo/path, oneezy/skills#68
// said go). Goose is dropped. desired() turns the release and the probe into the plan sync applies: a note for what an
// older version left on the machine, then per harness the managed block in its global instructions file (ADR-0011;
// its text is the release's SHARED.md; when that cannot be read, one line says so, a block already there stays as it
// is and a file without one gets the built-in text), a cleanup line for every block an older skills-sync left in a
// repository, and, outside the cloud, the session hook entry in its user hooks file (ADR-0010) and whatever the
// harness's form module in src/forms/ asks for. The release's
// skills-sync.json (ADR-0012) says which harnesses are served and which plugins each gets; pluginsFor() is the one place
// a form reads its plugin list. --plan and apply share this one code path; only apply() differs.
import { blockAction, releaseSource, SHARED_FILE } from "./block.js";
import type { GitHub } from "./github.js";
import { hookActions } from "./hooks.js";
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
      return "github-plugins";
    default:
      return null;
  }
}

/** What a form module is told about the run. */
export interface FormOptions {
  /** --plan: say what would be done, run no plugin command that changes anything (read-only listings are fine) */
  plan: boolean;
  /** the GitHub client the release was read with, for a form that has to ask GitHub before it installs; null offline */
  github?: GitHub | null;
}

/**
 * A harness's form module (src/forms/<harness>.ts): from the release (null when GitHub could not be read), the
 * harness's probed state and the machine, the actions that bring the harness to its form. Never called in the cloud,
 * where the block is the whole sync (ADR-0007: claude.ai delivers the account plugins; nothing else is installed).
 * Plugin commands go through install.ts's drivers from inside the form, outside --plan, and come back as install and
 * uninstall actions (records of what ran, or would run); apply() runs the file actions (link, remove, write, ...). A
 * form that asks GitHub something first (Hermes: whether the release commit carries its rendering) answers a promise.
 */
export type FormFn = (
  release: Release | null,
  state: HarnessState,
  machine: Machine,
  options: FormOptions,
) => Action[] | Promise<Action[]>;

/**
 * The catalog name a library's build gives its marketplaces when its config names none: <owner>-<name> of the repo,
 * lowercased (GitHub's names are not case-sensitive, so `--library Oneezy/Skills` is oneezy/skills).
 */
export function catalogFor(repo: string): string {
  return repo.replace("/", "-").toLowerCase();
}

/**
 * Is a marketplace name the catalog? Compared without case: the catalog comes from a repo name or the release config's
 * owner and name, which GitHub does not tell apart by case, and Hermes's comes from the lowercased install URL.
 */
export function sameCatalog(name: string, catalog: string): boolean {
  return name.toLowerCase() === catalog.toLowerCase();
}

/**
 * The catalog name the library's plugins come from on Claude Code and Codex: the release's config names it, else the
 * release repo's <owner>-<name>; the constant only when no release was read at all.
 */
export function catalogOf(release: Release | null): string {
  return release?.config?.catalog ?? (release ? catalogFor(release.repo) : LIBRARY_MARKETPLACE);
}

/** Whether the release's config serves this harness: every detected one, unless machines.harnesses names a list. */
export function serves(release: Release | null, harnessId: string): boolean {
  const list = release?.config?.harnesses;
  return !list || list.includes(harnessId);
}

/** Why a harness is not served: the harnesses the release's skills-sync.json names, for the one note that says so. */
export function notServed(release: Release | null): string {
  return `the release's skills-sync.json names harnesses ${(release?.config?.harnesses ?? []).join(", ")}`;
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
  /** the GitHub client the release was read with, handed to the forms */
  github?: GitHub | null;
  /** why the release could not be read, when it could not: the one line about the global blocks says it */
  releaseError?: string | null;
}

/**
 * The plan: what every harness on this machine should have, against what the probe found. Nothing is written here;
 * outside --plan the form modules may run their harness's plugin commands (recorded as install/uninstall actions).
 */
export async function desired(
  release: Release | null,
  machine: Machine,
  forms: Record<string, FormFn>,
  options: DesiredOptions = {},
): Promise<Report> {
  const report = new Report();
  for (const old of oldStateNotes(machine)) report.add(old.action);
  // the block's text: the release's SHARED.md (or the built-in text); without it one line, a block already there kept
  // and a missing one given the built-in text (blockAction)
  const text = releaseSource(release, options.releaseError ?? null);
  const source = text.ok ? text.source : null;
  if (!text.ok && machine.harnesses.some((s) => s.block))
    report.add({
      kind: "note",
      path: SHARED_FILE,
      note: `not read: ${text.reason}; blocks already there kept as they are, a missing one gets the built-in text`,
      loud: true,
    });
  for (const state of machine.harnesses) {
    const id = state.harness.id;
    if (!formOf(id)) continue;
    if (!serves(release, id)) {
      report.add({
        kind: "note",
        path: state.harness.name,
        note: `not served: ${notServed(release)}; nothing changed here`,
      });
      continue;
    }
    const block = state.block ? blockAction(state.block.file, source) : null;
    if (block) report.add(block);
    for (const old of state.repoBlocks)
      report.add({
        kind: "note",
        path: old.file,
        note:
          `skills-sync block (${old.ids.join(", ")}) outside the global file; remove it by hand, ` +
          `the block lives only in ${state.harness.name}'s global file now`,
      });
    if (machine.cloud) continue;
    // the session hook is a PC and WSL thing (ADR-0010): a cloud session never reads user hooks
    if (state.hook) for (const a of hookActions(state.harness, state.hook)) report.add(a);
    const form = forms[id];
    if (!form) continue;
    for (const a of await form(release, state, machine, { plan: !!options.plan, github: options.github ?? null }))
      report.add(a);
  }
  return report;
}
