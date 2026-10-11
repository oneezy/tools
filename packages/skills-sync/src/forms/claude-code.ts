// Claude Code's form: the account plugins claude.ai delivers as <id>@synced (ADR-0007). The tool installs nothing on
// Claude Code any more; this form takes away what hides or duplicates an account plugin, and only once that plugin is
// verified present on this machine: listed by claude itself (not read from its folders), switched on, its skills read.
// Then, per account plugin the release lists: the same-named plugin the tool installed earlier from the library's
// marketplace goes (a CLI-installed plugin outranks the account one, so it hides it), then every loose link in
// ~/.claude/skills whose name is one of its skills and that points at a library copy, or at nothing. A link to somewhere
// else and a real skill folder are the user's: named, never removed. A plugin the release lists that the account does
// not deliver yet keeps whatever it has today and is a manual step at claude.ai. Plugins from other marketplaces and
// other account plugins are never touched. The library's marketplace registration goes with the last plugin the tool
// installed from it. Plugin commands run here through install.ts's drivers, outside --plan, and come back as uninstall
// actions; the link removals come back as remove actions for apply().
import os from "node:os";
import { catalogOf, pluginsFor, type FormFn } from "../desired.js";
import { lexists } from "../fs.js";
import { listMarketplaces, refused, removeMarketplace, runner, uninstallPlugin, type Run } from "../install.js";
import {
  libraryCopy,
  type AccountPlugin,
  type CliPlugin,
  type HarnessState,
  type LooseLink,
  type SkillFolder,
} from "../machine.js";
import type { Action } from "../plan.js";

/** What one delivered account plugin makes redundant on the machine. */
interface Redundant {
  account: AccountPlugin;
  /** the same-named plugin the tool installed from the library's marketplace, when one is there */
  plugin: CliPlugin | null;
  /** the loose links and real folders in the user skills folder named after one of its skills */
  links: LooseLink[];
  folders: SkillFolder[];
}

export const claudeCode: FormFn = (release, state, _machine, { plan }) => {
  const out: Action[] = [];
  const where = (what: string) => `${state.harness.name}: ${what}`;
  if (!release)
    return [
      {
        kind: "note",
        path: where("account plugins"),
        note: "nothing compared or removed: the latest release was not read",
      },
    ];

  const catalog = catalogOf(release);
  const mine = state.installed.filter((p) => p.marketplace === catalog);
  // the release plugins this harness gets (the release's config may narrow them), switched on at the account: where
  // Claude Code loads the library's skills from
  const listed = pluginsFor(release, state.harness.id).map((p) => p.id);
  const delivered = new Map<string, AccountPlugin>();
  for (const p of state.synced) if (listed.includes(p.id) && p.enabled) delivered.set(p.id, p);
  const work: Redundant[] = [...delivered.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((account) => ({
      account,
      plugin: mine.find((p) => p.id === account.id) ?? null,
      links: state.loose.filter((l) => account.skills.includes(l.name)),
      folders: state.folders.filter((f) => account.skills.includes(f.name)),
    }));

  // claude listed nothing (missing, or it cannot list): the account plugins were read from their folders, unverified
  const file = state.cli;
  if (state.note || !file) {
    if (work.some((w) => w.plugin || w.links.length))
      out.push({
        kind: "conflict",
        path: where("account plugins"),
        note: `${state.note ?? "no claude on PATH"}; account plugins not verified, nothing removed`,
      });
    return out;
  }
  const run = runner(file);
  const home = os.homedir();
  const gone = new Set<string>();

  for (const w of work) {
    const tag = `${w.account.id}@synced`;
    if (!w.plugin && !w.links.length && !w.folders.length) continue;
    if (!w.account.skills.length) {
      // listed, but its folder holds no skill (a download still finishing): not verified, nothing goes for it
      if (w.plugin || w.links.length)
        out.push({
          kind: "conflict",
          path: where(`plugin ${tag}`),
          note: "lists no skills yet; not verified, nothing removed for it",
        });
      continue;
    }
    if (w.plugin) {
      const id = `${w.plugin.id}@${w.plugin.marketplace}`;
      const a: Action = { kind: "uninstall", path: where(`plugin ${id}`), note: `hides ${tag}` };
      out.push(a);
      if (!plan && !uninstallPlugin(state.harness, run, id)) {
        refused(a, run, `claude could not uninstall it; ${tag} stays hidden and its skills' links stay`);
        continue;
      }
      gone.add(id);
    }
    for (const l of w.links) {
      if (libraryCopy(l.target, release.repo, home))
        out.push({
          kind: "remove",
          path: l.path,
          target: l.target,
          note: `${l.name} is in ${tag}; ${lexists(l.target) ? "a link to a library copy" : "a dangling link"}`,
        });
      else
        out.push({
          kind: "note",
          path: l.path,
          target: l.target,
          note: `${l.name} is also in ${tag}; this link points outside the library, so it is yours to keep or remove`,
        });
    }
    for (const f of w.folders)
      out.push({
        kind: "note",
        path: f.path,
        note: `${f.name} is also in ${tag}; a real skill folder is yours to keep or remove`,
      });
  }

  // the registration goes with the last plugin the tool installed from the marketplace: claude's remove takes the
  // marketplace's plugins with it, so never while one the account does not deliver yet stays
  if (mine.length && mine.every((p) => gone.has(`${p.id}@${p.marketplace}`)))
    out.push(...marketplace(state, run, catalog, plan));

  // claude listed fine and not one account plugin: the sync itself is off, not a plugin (a token or API-key sign-in,
  // syncClaudeAiPlugins: false, a Claude Code older than 2.1.273), so one line, not one per plugin
  if (!state.synced.length)
    out.push({
      kind: "note",
      path: state.harness.name,
      note: "claude lists no account plugins; check it is logged in with the claude.ai account and that syncClaudeAiPlugins is not off",
    });
  // what the account does not deliver yet keeps whatever it has today; switching it on is a click at claude.ai
  else
    for (const id of listed)
      if (!delivered.has(id))
        out.push({
          kind: "note",
          path: state.harness.name,
          note: `${id}: not delivered by the claude.ai account yet; switch it on at claude.ai (Customize > Plugins), then sync again`,
        });
  return out;
};

function marketplace(state: HarnessState, run: Run, catalog: string, plan: boolean): Action[] {
  const p = `${state.harness.name}: marketplace ${catalog}`;
  const markets = listMarketplaces(state.harness, run);
  if (markets === null)
    return [{ kind: "note", path: p, note: "claude could not list its marketplaces; a registration stays" }];
  if (!markets.some((m) => m.name === catalog)) return [];
  const a: Action = { kind: "uninstall", path: p, note: "no plugin from it remains" };
  if (!plan && !removeMarketplace(state.harness, run, catalog)) refused(a, run, "claude could not remove it");
  return [a];
}
