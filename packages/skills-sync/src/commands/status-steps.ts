// The manual steps status lists at the end: what only a person can do, written step by step so Justin can follow them
// on a phone (spec story 54, 57). A step is never a red line (the machine is right; the person is not done yet), and a
// red line is never hidden by a step: status prints the red lines first, the steps after. Each open step is one block
// with a stable id /oneezy-status can read: the account plugins claude.ai does not deliver to Claude Code yet (a toggle
// at claude.ai), a Claude Code that lists no account plugin at all (a sign-in), the Codex hook trust (its TUI, once per
// machine), the duplicate Codex plugins from other marketplaces (ChatGPT's), what is left in Codex's skills folders to
// adopt or delete, and, in the cloud, the old setup line that still cloned the old library and linked every skill a
// second time. The rules for "a library copy" and "the release's own files" are the forms' own (machine.ts's libraryCopy,
// the Codex form's sameFiles), so status and sync agree on what sync removes and what it leaves for a person.
import { CHATGPT_BOOTSTRAP, CHATGPT_LINE, chatgptState, isAccountMarketplace, needsBootstrap } from "../chatgpt.js";
import { catalogOf, developmentMarketplaceOf, formOf, pluginsFor, sameCatalog, serves } from "../desired.js";
import { sameFiles } from "../forms/codex.js";
import { lexists } from "../fs.js";
import { libraryCopy, type HarnessState, type Machine } from "../machine.js";
import type { Release } from "../release.js";

export interface ManualStep {
  /** stable: claude-plugins, claude-account, codex-trust, codex-other-plugins, development-everywhere, adopt-or-delete, chatgpt-update, cloud-setup */
  id: string;
  title: string;
  /** numbered when printed, in order */
  steps: string[];
}

/** The setup script line the cloud environment should run (ADR-0008), and the one it ran before the repair. */
const CLOUD_SETUP_LINE = "npx --yes @oneezy/skills-sync@latest --quiet";
const OLD_CLOUD_FLAGS = "-y --agents claude-code --global --no-projects --no-wsl --quiet";

/** How many items a step spells out before "and N more": a step is read on a phone. */
const NAMED = 10;

/**
 * The open manual steps for this machine, in the order they print. Reads only (the links and folders the probe found,
 * hashing a folder's files against the release's), writes nothing.
 */
export function manualSteps(machine: Machine, release: Release | null): ManualStep[] {
  const out: ManualStep[] = [];
  if (machine.cloud) {
    // a cloud session has no hooks to trust and installs no plugin: the account delivers them, the setup script links
    const claude = machine.harnesses.find((s) => s.harness.id === "claude-code");
    const step = cloudSetup(machine, claude);
    return step ? [step] : [];
  }
  for (const state of machine.harnesses) {
    // a harness the release does not serve is one note in status and nothing is owed for it (ADR-0012)
    if (!formOf(state.harness.id) || !serves(release, state.harness.id)) continue;
    if (state.harness.id === "claude-code") push(out, claudePlugins(state, release));
    // the other-marketplace plugins and the folder rules below are Codex's (Hermes's form has its own and prints them)
    if (state.harness.id === "codex") {
      push(out, codexTrust(state));
      push(out, otherPlugins(state, release));
      push(out, developmentEverywhere(state, release));
      push(out, adoptOrDelete(state, release));
    }
  }
  push(out, chatgptUpdate(machine, release));
  return out;
}

/** The release plugins this harness gets (the release's skills-sync.json may narrow them), sorted: sync's list. */
function ids(release: Release, state: HarnessState): string[] {
  return pluginsFor(release, state.harness.id).map((p) => p.id);
}

function push(out: ManualStep[], step: ManualStep | null): void {
  if (step) out.push(step);
}

function list(items: string[]): string {
  return items.length > NAMED
    ? `${items.slice(0, NAMED).join(", ")} … and ${items.length - NAMED} more`
    : items.join(", ");
}

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The release plugins the claude.ai account does not deliver to this Claude Code (no <id>@synced, or one switched off
 * at claude.ai): a toggle on the Plugins page. Only when claude itself listed its plugins (the folders alone cannot say
 * what is switched on) and the release was read (without it, nothing is known to be missing). When claude lists no
 * account plugin at all, the account sync itself is off, not a plugin: one step about the sign-in, not one per plugin.
 */
function claudePlugins(state: HarnessState, release: Release | null): ManualStep | null {
  if (!release || !state.listed) return null;
  const name = state.harness.name;
  if (!state.synced.length)
    return {
      id: "claude-account",
      title: `${name} lists no account plugin: check its claude.ai sign-in`,
      steps: [
        "Run claude and check it is signed in with the claude.ai account that holds the plugins (/login), not an API key.",
        "Check ~/.claude/settings.json does not set syncClaudeAiPlugins to false.",
        `Start a new Claude Code session; claude plugin list should then show ${ids(release, state).join(", ")} as <id>@synced. Run status again.`,
      ],
    };
  const delivered = new Set(state.synced.filter((p) => p.enabled).map((p) => p.id));
  const missing = ids(release, state)
    .filter((id) => !delivered.has(id))
    .sort();
  if (!missing.length) return null;
  const off = missing.filter((id) => state.synced.some((p) => p.id === id && !p.enabled));
  return {
    id: "claude-plugins",
    title: `Switch on the account plugins claude.ai does not deliver to ${name} yet: ${missing.join(", ")}`,
    steps: [
      "Open https://claude.ai/customize/plugins (Customize > Plugins) in a browser, signed in to the claude.ai account Claude Code uses.",
      ...missing.map((id) => `Find ${id} and switch it on${off.includes(id) ? " (it is switched off today)" : ""}.`),
      `Start a new Claude Code session so claude.ai syncs ${missing.length === 1 ? "it" : "them"} in, then run npx --yes @oneezy/skills-sync@latest status: each should show as <id>@synced.`,
    ],
  };
}

/**
 * Codex runs a user hook only after the person trusted it in its TUI, once per machine or WSL distro (ADR-0010,
 * oneezy/skills#66), and again after the entry changed from the form they trusted (Codex lists it as modified). The
 * same words hooks.ts's CODEX_TRUST_STEP and CODEX_RETRUST_STEP print as sync's note, as steps. The trust stays the
 * person's tap: the tool never writes it.
 */
function codexTrust(state: HarnessState): ManualStep | null {
  const hook = state.hook;
  if (!hook?.present || (hook.trust !== "new" && hook.trust !== "changed")) return null;
  const changed = hook.trust === "changed";
  return {
    id: "codex-trust",
    title: changed
      ? `Review the changed Skills Sync hook in ${state.harness.name} again, once on this machine (${hook.file})`
      : `Trust the Skills Sync hook in ${state.harness.name}, once on this machine (${hook.file})`,
    steps: [
      "Run codex in a terminal on this machine.",
      'On the "Hooks need review" screen choose "1. Review hooks" (or type /hooks).',
      `Select SessionStart, then the row "[!] Skills Sync · ${changed ? "modified" : "new"}", and press t.`,
      "Press Esc twice. The hook runs from the next codex start, and status no longer lists this step.",
    ],
  };
}

/**
 * The ChatGPT account's copies of the release plugins, read through a signed-in Codex (chatgpt.ts), behind or missing:
 * only Justin can update them, by typing one line in ChatGPT. Nothing when the account could not be read.
 */
function chatgptUpdate(machine: Machine, release: Release | null): ManualStep | null {
  const state = chatgptState(
    machine.harnesses.find((s) => s.harness.id === "codex"),
    release,
  );
  const open = state.plugins.filter((p) => !p.current && !p.ahead);
  if (!state.checked || !release || !open.length) return null;
  return {
    id: "chatgpt-update",
    title: `Bring the ChatGPT plugins up to ${release.tag}: ${open.map((p) => p.id).join(", ")}`,
    steps: [
      "Open ChatGPT (the website or the desktop app) and start a new chat.",
      ...(needsBootstrap(state)
        ? [
            `The account's oneezy plugin predates the update procedure, so first type: ${CHATGPT_BOOTSTRAP}`,
            `Start another new chat and type: ${CHATGPT_LINE}`,
          ]
        : [`Type: ${CHATGPT_LINE}`]),
      "Approve each plugin update ChatGPT asks about. It ends with every plugin updated, already current, or failed and why.",
      "Start codex once on this machine so it picks up the account's new copies, then run status again.",
    ],
  };
}

/**
 * A plugin of a library plugin's name installed from another marketplace lists every skill of it a second time beside
 * the library's; the tool never removes it (tools#150), so the person does, by hand. The ChatGPT account's own copies
 * (chatgpt.ts's isAccountMarketplace) are not such a plugin: they are the ChatGPT destination, kept at the release.
 */
function otherPlugins(state: HarnessState, release: Release | null): ManualStep | null {
  if (!release) return null;
  const others = state.installed
    // a plugin switched off loads nothing, so it doubles nothing
    .filter(
      (p) =>
        p.enabled &&
        !sameCatalog(p.marketplace, catalogOf(release)) &&
        !isAccountMarketplace(p.marketplace) &&
        p.marketplace !== developmentMarketplaceOf(catalogOf(release), state.harness.id) &&
        ids(release, state).includes(p.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!others.length) return null;
  const name = state.harness.name;
  return {
    id: "codex-other-plugins",
    title: `Uninstall the ${name} plugins from other marketplaces that double the library's: ${others.map((p) => `${p.id}@${p.marketplace}`).join(", ")}`,
    steps: [
      ...others.map(
        (p) =>
          `${p.id}@${p.marketplace}: open ChatGPT > Plugins > Installed, find ${p.id} and choose Uninstall plugin; or run codex plugin remove ${p.id}@${p.marketplace}.`,
      ),
      "Run status again: each skill name should be listed once.",
    ],
  };
}

/**
 * A development copy (`develop setup`'s, develop-codex.ts) switched on for the user doubles the library's plugin in every
 * project, not only the ones set up for development. It is not uninstalled: `develop setup` switches it off again.
 */
function developmentEverywhere(state: HarnessState, release: Release | null): ManualStep | null {
  if (!release) return null;
  const dev = developmentMarketplaceOf(catalogOf(release), state.harness.id);
  const on = state.installed.filter((p) => p.enabled && p.marketplace === dev && ids(release, state).includes(p.id));
  if (!on.length) return null;
  const list = on.map((p) => `${p.id}@${p.marketplace}`).join(", ");
  return {
    id: "development-everywhere",
    title: `Switch the ${state.harness.name} development copies off outside Development projects: ${list}`,
    steps: [
      "In a project set up for development (it holds .agents/skills-sync-project.json), run skills-sync develop setup: it switches them off for every other project and keeps them on there.",
      "Run status again: each skill name should be listed once.",
    ],
  };
}

/**
 * What sync leaves in the harness's skills folders because it is not the library's: a real folder that is not exactly
 * the release's files for the skill (or a skill the release does not carry), a link to somewhere that is not a library
 * copy, and a library copy or dangling link no plugin of the release carries. Everything of the library's own, sync
 * removes once its plugin verifies, so it is not a step. Without the release nothing can be judged.
 */
function adoptOrDelete(state: HarnessState, release: Release | null): ManualStep | null {
  if (!release) return null;
  const plugins = pluginsFor(release, state.harness.id);
  const carrier = (skill: string) => plugins.find((p) => p.skills.includes(skill));
  const items: string[] = [];
  for (const l of state.loose) {
    if (!l.target) {
      items.push(`${l.path}: a link whose target cannot be read`);
      continue;
    }
    const copy = libraryCopy(l.target, release.repo) ? (lexists(l.target) ? "library" : "dangling") : null;
    if (!copy) items.push(`${l.path}: links to ${l.target}, not a library copy`);
    else if (!carrier(l.name))
      items.push(
        `${l.path}: ${copy === "dangling" ? "a dangling link" : "a link into a library copy"}, and no plugin in ${release.tag} carries ${l.name}`,
      );
  }
  for (const f of state.folders) {
    const p = carrier(f.name);
    if (!p) items.push(`${f.path}: a skill folder not in ${release.tag}`);
    else if (!sameFiles(f.path, p, `skills/${f.name}/`))
      items.push(`${f.path}: a skill folder that is not the library's copy`);
  }
  if (!items.length) return null;
  const shown = items.length > NAMED ? [...items.slice(0, NAMED), `… and ${items.length - NAMED} more`] : items;
  return {
    id: "adopt-or-delete",
    title: `Adopt into ${release.repo} or delete by hand: ${count(items.length, "item")} left in ${state.harness.name}'s skills folders`,
    steps: [
      ...shown,
      `To adopt one: add it under skills/ in ${release.repo} on dev and let the release carry it; the next sync installs it as a plugin and removes the copy. To drop one: delete the folder or link. Then run status again.`,
    ],
  };
}

/**
 * In the cloud the account plugins arrive on their own and the block is the whole sync (ADR-0007); the old setup line
 * cloned the library to ~/.skills-sync and linked every skill into ~/.claude/skills, so each was listed twice. Either
 * leftover in this session means the old line ran here: from the environment's setup script, or from an agent that
 * followed a repository's "run this first" line. The evidence cannot tell which, so the step names both; only a person
 * can change either.
 */
function cloudSetup(machine: Machine, claude: HarnessState | undefined): ManualStep | null {
  const evidence: string[] = [];
  if (machine.oldLibrary)
    evidence.push(
      `${machine.oldLibrary.path} is the old library ${machine.oldLibrary.kind === "link" ? `link -> ${machine.oldLibrary.target}` : "clone"}`,
    );
  if (claude?.loose.length)
    evidence.push(
      `${count(claude.loose.length, "loose link")} in ${claude.harness.userSkills} (${list(claude.loose.map((l) => l.name))})`,
    );
  if (!evidence.length) return null;
  return {
    id: "cloud-setup",
    title: `The old @oneezy/skills-sync line ran in this session (${evidence.join("; ")}): make the cloud run the new one`,
    steps: [
      "At claude.ai open this project's settings, then the Cloud environment menu, then the gear beside the selected environment, and find Setup script (an environment the organization owns is read-only there: an admin changes it in the admin settings).",
      `If the line that runs @oneezy/skills-sync is the old one (it ends ${OLD_CLOUD_FLAGS}), replace it with: ${CLOUD_SETUP_LINE}`,
      `If the setup script already runs the new line, the old one came from elsewhere in this session, such as a repository's AGENTS.md telling the agent to run it first: change that line to ${CLOUD_SETUP_LINE} the same way.`,
      "Start a new cloud thread and run npx --yes @oneezy/skills-sync@latest status there: no loose link, and this step gone.",
    ],
  };
}
