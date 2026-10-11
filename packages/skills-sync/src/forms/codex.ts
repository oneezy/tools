// Codex's form: the library's plugins from the GitHub marketplace oneezy/skills (ADR-0007). The marketplace is added
// from GitHub (an old registration of the same name from a local folder, the ~/.skills-sync form, is replaced), every
// plugin the release lists is installed through `codex plugin add`, a plugin behind the release is brought up with one
// `codex plugin marketplace upgrade` (it refreshes the snapshot and reinstalls every plugin from it), and each plugin is
// verified through Codex's own listing and the skills it loads. Only then do the copies of its skills go: loose links to
// a library copy (a checkout, ~/.skills-sync, or a target that is gone) in ~/.agents/skills and the deprecated
// ~/.codex/skills, and a real folder there whose SKILL.md is byte for byte the release's. `.system` is Codex's and is
// never listed; every other real folder, and every link to something that is not a library copy, is a line for Justin:
// adopt it into the library or delete it by hand. A plugin of the same name from another marketplace (a ChatGPT account
// plugin) lists every skill twice; it is never removed here, the line says how. Shapes: notes/skills-66.md and
// docs/research/codex-hook-trust-and-account-plugins.md in oneezy/skills.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FormFn } from "../desired.js";
import { lexists, real, toHash, under } from "../fs.js";
import {
  addMarketplace,
  codexPluginSkills,
  installPlugin,
  listInstalled,
  removeMarketplace,
  runner,
  upgradeMarketplace,
  type Run,
} from "../install.js";
import { homeLibrary } from "../library.js";
import { LIBRARY_MARKETPLACE, type HarnessState } from "../machine.js";
import type { Action } from "../plan.js";
import type { ReleasePlugin } from "../release.js";

/** One plugin as Codex lists it right now, with the skills its prompt input shows it loading (null: not readable). */
interface Have {
  name: string;
  marketplace: string;
  version: string | null;
  enabled: boolean;
  skills: string[] | null;
}

export const codex: FormFn = (release, state, _machine, options) => {
  const plan = options.plan;
  const h = state.harness;
  const where = (what: string) => `${h.name}: ${what}`;
  const mkt = LIBRARY_MARKETPLACE;
  const out: Action[] = [];
  const conflict = (what: string, note: string, run?: Run): void => {
    out.push({ kind: "conflict", path: where(what), note, ...(run?.failure ? { diagnostic: run.failure } : {}) });
  };
  const form = "plugins from GitHub";
  if (!release)
    return [{ kind: "note", path: where(form), note: "latest release not read; nothing installed, nothing removed" }];
  if (!state.cli)
    return [{ kind: "note", path: where(form), note: `no codex on PATH; nothing installed, nothing removed` }];
  if (state.note?.endsWith("cannot list its plugins")) {
    conflict(form, `${state.note}; nothing installed, nothing removed`);
    return out;
  }
  const run = runner(state.cli);

  // 1. the marketplace: oneezy-skills from GitHub, the release repo
  const existing = state.marketplaces.find((m) => m.name === mkt);
  let marketplaceChanged = false;
  if (existing && existing.sourceType === "git" && existing.source && sameRepo(existing.source, release.repo))
    out.push({ kind: "skip", path: where(`marketplace ${mkt}`), note: `from GitHub ${release.repo}` });
  else {
    if (existing) {
      if (existing.sourceType !== "local") {
        conflict(
          `marketplace ${mkt}`,
          `registered from ${existing.source ?? existing.root ?? "an unknown source"}, not GitHub ${release.repo}; left alone, nothing installed, nothing removed`,
        );
        return out;
      }
      // the old tool registered the library folder itself (~/.skills-sync); Codex keeps the plugins installed from it
      out.push({ kind: "uninstall", path: where(`marketplace ${mkt}`), note: `was the local folder ${existing.root}` });
      if (!plan && !removeMarketplace(h, run, mkt)) {
        conflict(
          `marketplace ${mkt}`,
          `codex plugin marketplace remove failed; nothing installed, nothing removed`,
          run,
        );
        return out;
      }
    }
    out.push({ kind: "install", path: where(`marketplace ${mkt}`), note: `from GitHub ${release.repo}` });
    if (!plan) {
      const added = addMarketplace(h, run, release.repo);
      if (!added) {
        conflict(
          `marketplace ${mkt}`,
          `codex plugin marketplace add ${release.repo} failed; nothing installed, nothing removed`,
          run,
        );
        return out;
      }
      if (added.name && added.name !== mkt) {
        conflict(
          `marketplace ${mkt}`,
          `GitHub ${release.repo} names its marketplace ${added.name}, not ${mkt}; nothing installed, nothing removed`,
        );
        return out;
      }
    }
    marketplaceChanged = true;
  }

  // 2. the plugins: every plugin of the release, until tools#154 reads the selection from skills-sync.json at the release
  const wanted = Object.values(release.plugins).sort((a, b) => a.id.localeCompare(b.id));
  let have = marketplaceChanged && !plan ? inventory(h, run) : fromProbe(state);
  if (!have) {
    conflict(form, "codex could not list its plugins after the marketplace change; nothing installed, nothing removed");
    return out;
  }
  const mine = (list: Have[], p: ReleasePlugin) => list.find((x) => x.name === p.id && x.marketplace === mkt);
  const v = (x: string | null) => x ?? "no version";
  /** plugins whose install or upgrade is only planned: under --plan they count as verified, so the plan lists every removal */
  const assumed = new Set<string>();
  /** plugins not to verify: a failed add, or left disabled */
  const skipped = new Set<string>();
  const behind: ReleasePlugin[] = [];
  let wrote = false;
  for (const p of wanted) {
    const id = `${p.id}@${mkt}`;
    for (const other of have.filter((x) => x.name === p.id && x.marketplace !== mkt))
      out.push({
        kind: "note",
        path: where(`plugin ${p.id}@${other.marketplace}`),
        note: `lists every skill of ${p.id} a second time beside ${id}; uninstall it by hand: ChatGPT > Plugins > Installed > Uninstall plugin, or codex plugin remove ${p.id}@${other.marketplace}`,
      });
    const current = mine(have, p);
    if (!current) {
      out.push({ kind: "install", path: where(`plugin ${id}`), note: p.version ?? "unversioned" });
      if (plan) assumed.add(p.id);
      else if (installPlugin(h, run, id)) wrote = true;
      else {
        conflict(`plugin ${id}`, "codex plugin add failed; its copies stay", run);
        skipped.add(p.id);
      }
      continue;
    }
    if (!current.enabled) {
      out.push({
        kind: "note",
        path: where(`plugin ${id}`),
        note: `installed but disabled; left as it is, its copies stay`,
      });
      skipped.add(p.id);
      continue;
    }
    if (isBehind(current, p)) behind.push(p);
    else out.push({ kind: "skip", path: where(`plugin ${id}`), note: `installed ${v(current.version)}` });
  }

  // 3. one upgrade for the harness when any plugin is behind, or right after the marketplace moved from a folder to
  // GitHub: Codex kept those plugins, so their caches are reinstalled from the GitHub snapshot
  const replaced = marketplaceChanged && !!existing && have.some((x) => x.marketplace === mkt);
  if (behind.length || replaced) {
    const what = behind.length
      ? behind
          .map((p) => {
            const now = mine(have!, p)!;
            return p.version !== null && now.version !== p.version
              ? `${p.id} ${v(now.version)} -> ${p.version}`
              : `${p.id} missing ${missing(now.skills ?? [], p).join(", ")}`;
          })
          .join(", ")
      : "caches reinstalled from GitHub";
    out.push({ kind: "install", path: where(`marketplace ${mkt}`), note: `upgrade: ${what}` });
    if (plan) for (const p of behind) assumed.add(p.id);
    else if (upgradeMarketplace(h, run, mkt)) wrote = true;
    else {
      conflict(
        `marketplace ${mkt}`,
        "codex plugin marketplace upgrade failed; the plugins behind the release and their copies stay",
        run,
      );
      for (const p of behind) skipped.add(p.id);
    }
  }

  // 4. verify: listed from the library's marketplace, enabled, at the release's version, loading every skill the
  // release gives it. Nothing of a plugin that fails this is removed (ADR-0007)
  const after = wrote ? inventory(h, run) : have;
  if (!after) {
    conflict(form, "codex could not list its plugins after installing; nothing removed");
    return out;
  }
  const verified = new Set<string>();
  for (const p of wanted) {
    if (skipped.has(p.id)) continue;
    if (assumed.has(p.id)) {
      verified.add(p.id);
      continue;
    }
    const now = mine(after, p);
    const reason = !now
      ? "codex does not list it"
      : !now.enabled
        ? "codex lists it disabled"
        : p.version !== null && now.version !== p.version
          ? `installed ${v(now.version)}, the release has ${p.version}`
          : now.skills === null
            ? "codex cannot list its plugin skills"
            : missing(now.skills, p).length
              ? `does not load ${missing(now.skills, p).join(", ")}`
              : null;
    if (reason) {
      conflict(`plugin ${p.id}@${mkt}`, `installed but not verified (${reason}); its copies stay`);
      continue;
    }
    verified.add(p.id);
  }

  // 5. the copies: links to a library copy and real copies of the release's SKILL.md go once their plugin verified;
  // everything else in Codex's skill folders is Justin's to adopt or delete
  const carrier = (skill: string) => wanted.find((p) => p.skills.includes(skill));
  for (const l of state.loose) {
    const copy = libraryCopy(l.target, release.repo);
    if (!copy) {
      out.push({
        kind: "note",
        path: l.path,
        note: `links to ${l.target}, not a library copy; adopt it into ${release.repo} or delete it by hand`,
      });
      continue;
    }
    const p = carrier(l.name);
    if (!p) {
      out.push({
        kind: "note",
        path: l.path,
        note: `links into a library copy, but no plugin in ${release.tag} carries ${l.name}; left alone`,
      });
      continue;
    }
    if (!verified.has(p.id)) continue;
    out.push({
      kind: "remove",
      path: l.path,
      note: `${copy === "dangling" ? "dangling link" : "library copy"}; carried by ${p.id}@${mkt}`,
    });
  }
  for (const f of state.folders) {
    const p = carrier(f.name);
    const sha = p?.files[`skills/${f.name}/SKILL.md`];
    if (!p || !sha || fileHash(path.join(f.path, "SKILL.md")) !== sha) {
      out.push({
        kind: "note",
        path: f.path,
        note: `not from the library; adopt it into ${release.repo} or delete it by hand`,
      });
      continue;
    }
    if (!verified.has(p.id)) continue;
    out.push({ kind: "delete", path: f.path, note: `library copy; carried by ${p.id}@${mkt}` });
  }
  return out;
};

/** What the probe found Codex listing, as the form compares it. */
function fromProbe(state: HarnessState): Have[] {
  return state.installed.map((p) => ({
    name: p.id,
    marketplace: p.marketplace,
    version: p.version,
    enabled: p.enabled,
    skills: p.skills,
  }));
}

/** Codex's listing right now, with the skills its prompt input shows each plugin loading; null when it cannot list. */
function inventory(h: HarnessState["harness"], run: Run): Have[] | null {
  const listed = listInstalled(h, run);
  if (!listed) return null;
  const skills = listed.length ? codexPluginSkills(run) : new Map<string, string[]>();
  return listed.map((i) => ({
    name: i.name,
    marketplace: i.marketplace,
    version: i.version,
    enabled: i.enabled,
    skills: skills ? (skills.get(i.name) ?? []) : null,
  }));
}

/** The release's skills the plugin does not load. */
function missing(loaded: string[], p: ReleasePlugin): string[] {
  return p.skills.filter((s) => !loaded.includes(s));
}

/**
 * Behind the release: another version (a plain string compare, Codex installs exactly the manifest's), or, for a plugin
 * without a version, or one whose skills were read, a release skill it does not load.
 */
function isBehind(have: Have, p: ReleasePlugin): boolean {
  if (p.version !== null && have.version !== p.version) return true;
  return have.skills !== null && missing(have.skills, p).length > 0;
}

/** `https://github.com/oneezy/skills.git`, `git@github.com:oneezy/skills.git` or `oneezy/skills` name the same repo. */
function sameRepo(source: string, repo: string): boolean {
  const m = /(?:github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(source.trim());
  return !!m && m[1].toLowerCase() === repo.toLowerCase();
}

/**
 * Is `target` a copy the tool, or an older sync, made from the library: inside ~/.skills-sync (the link or where it
 * points), inside a checkout of the release repo (a skills-sync.json naming it as the library at some ancestor), or
 * gone ("dangling": the tool's leftover). Null for anything else, which is never removed.
 */
function libraryCopy(target: string, repo: string): "library" | "dangling" | null {
  if (!target) return null;
  if (!lexists(target)) return "dangling";
  const home = homeLibrary(os.homedir());
  if (under(target, home)) return "library";
  // the link may name the folder one way and the target another (a Windows short name): compare the real paths too
  if (lexists(home) && (under(target, real(home)) || under(real(target), real(home)))) return "library";
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (isCheckoutOf(dir, repo)) return "library";
    if (path.dirname(dir) === dir) return null;
  }
}

/** A library checkout: skills-sync.json whose library.owner/name is the release repo. */
function isCheckoutOf(dir: string, repo: string): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, "skills-sync.json"), "utf8")) as {
      library?: { owner?: unknown; name?: unknown };
    };
    const owner = v?.library?.owner;
    const name = v?.library?.name;
    return (
      typeof owner === "string" && typeof name === "string" && `${owner}/${name}`.toLowerCase() === repo.toLowerCase()
    );
  } catch {
    return false;
  }
}

function fileHash(file: string): string | null {
  try {
    return toHash(fs.readFileSync(file));
  } catch {
    return null;
  }
}
