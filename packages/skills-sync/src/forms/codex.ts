// Codex's form: the library's plugins from the GitHub marketplace oneezy/skills (ADR-0007). The marketplace is added
// from GitHub (an old registration of the same name from a local folder, the ~/.skills-sync form, is replaced), every
// plugin the release's skills-sync.json gives Codex (desired.ts's pluginsFor) is installed through `codex plugin add`, a plugin behind the release is brought up with one
// `codex plugin marketplace upgrade` (it refreshes the snapshot and reinstalls every plugin from it), and each plugin is
// verified through Codex's own listing and the skills it loads. Only then do the copies of its skills go: loose links to
// a library copy (a checkout, ~/.skills-sync, or a target that is gone) in ~/.agents/skills and the deprecated
// ~/.codex/skills, and a real folder there whose SKILL.md is byte for byte the release's. `.system` is Codex's and is
// never listed; every other real folder, and every link to something that is not a library copy, is a line for Justin:
// adopt it into the library or delete it by hand. A plugin of the same name from another marketplace (a ChatGPT account
// plugin) lists every skill twice; it is never removed here, the line says how. Shapes: notes/skills-66.md and
// docs/research/codex-hook-trust-and-account-plugins.md in oneezy/skills.
import fs from "node:fs";
import path from "node:path";
import { catalogOf, pluginsFor, type FormFn } from "../desired.js";
import { lexists, toHash } from "../fs.js";
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
import { libraryCopy, type CliPlugin, type HarnessState } from "../machine.js";
import type { Action } from "../plan.js";
import type { ReleasePlugin } from "../release.js";
import { compareVersions, plainVersion } from "../versions.js";

export const codex: FormFn = (release, state, _machine, options) => {
  const plan = options.plan;
  const h = state.harness;
  const where = (what: string) => `${h.name}: ${what}`;
  const mkt = catalogOf(release);
  const out: Action[] = [];
  const conflict = (what: string, note: string, run?: Run): void => {
    out.push({ kind: "conflict", path: where(what), note, ...(run?.failure ? { diagnostic: run.failure } : {}) });
  };
  const form = "plugins from GitHub";
  if (!release)
    return [{ kind: "note", path: where(form), note: "latest release not read; nothing installed, nothing removed" }];
  if (!state.cli)
    return [{ kind: "note", path: where(form), note: "no codex on PATH; nothing installed, nothing removed" }];
  // the probe's note for a codex that cannot list its plugins; its other note (the prompt input) leaves the listing
  // usable, and shows per plugin at verification
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
    const add: Action = { kind: "install", path: where(`marketplace ${mkt}`), note: `from GitHub ${release.repo}` };
    out.push(add);
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
      // registered already, from this source (the probe's listing failed, or said nothing of it): nothing changed
      if (added.alreadyAdded) {
        add.kind = "skip";
        add.note = `from GitHub ${release.repo} (already registered)`;
      } else marketplaceChanged = true;
    } else marketplaceChanged = true;
  }

  // 2. the plugins: the release's, narrowed to what its skills-sync.json names for Codex (ADR-0012)
  const wanted = pluginsFor(release, h.id);
  const have = marketplaceChanged && !plan ? inventory(h, run) : state.installed;
  if (!have) {
    conflict(form, "codex could not list its plugins after the marketplace change; nothing installed, nothing removed");
    return out;
  }
  const mine = (list: CliPlugin[], p: ReleasePlugin) => list.find((x) => x.id === p.id && x.marketplace === mkt);
  const shown = (version: string | null) => version ?? "no version";
  /** plugins whose install or upgrade is only planned: under --plan they count as verified, so the plan lists every removal */
  const assumed = new Set<string>();
  /** plugins not to verify: a failed add, or left disabled */
  const skipped = new Set<string>();
  const behind: Array<{ p: ReleasePlugin; now: CliPlugin }> = [];
  let wrote = false;
  for (const p of wanted) {
    const id = `${p.id}@${mkt}`;
    for (const other of have.filter((x) => x.id === p.id && x.marketplace !== mkt))
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
        note: "installed but disabled; left as it is, its copies stay",
      });
      skipped.add(p.id);
      continue;
    }
    const gap = versionGap(current, p);
    if (gap === "ahead")
      // the marketplace snapshot is main, which runs ahead of releases/latest after every push: nothing to upgrade to
      out.push({
        kind: "note",
        path: where(`plugin ${id}`),
        note: `${p.id} ${shown(current.version)} is ahead of the latest release (${p.version}); nothing to do`,
      });
    else if (gap === "behind" || (current.skills !== null && missing(current.skills, p).length))
      behind.push({ p, now: current });
    else out.push({ kind: "skip", path: where(`plugin ${id}`), note: `installed ${shown(current.version)}` });
  }

  // 3. one upgrade for the harness when any plugin is behind, or right after the marketplace moved from a folder to
  // GitHub: Codex kept those plugins, so their caches are reinstalled from the GitHub snapshot
  const replaced = marketplaceChanged && !!existing && have.some((x) => x.marketplace === mkt);
  if (behind.length || replaced) {
    const what = behind.length
      ? behind
          .map(({ p, now }) =>
            p.version !== null && now.version !== p.version
              ? `${p.id} ${shown(now.version)} -> ${p.version}`
              : `${p.id} missing ${missing(now.skills ?? [], p).join(", ")}`,
          )
          .join(", ")
      : "caches reinstalled from GitHub";
    out.push({ kind: "install", path: where(`marketplace ${mkt}`), note: `upgrade: ${what}` });
    if (plan) for (const { p } of behind) assumed.add(p.id);
    else {
      const upgraded = upgradeMarketplace(h, run, mkt);
      if (!upgraded) {
        conflict(
          `marketplace ${mkt}`,
          "codex plugin marketplace upgrade failed; the plugins behind the release and their copies stay",
          run,
        );
        for (const { p } of behind) skipped.add(p.id);
      } else {
        wrote = true;
        // a plugin it could not reinstall fails verification below, and keeps its copies
        if (upgraded.errors.length)
          conflict(`marketplace ${mkt}`, `codex plugin marketplace upgrade reported: ${upgraded.errors.join("; ")}`);
      }
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
        : versionGap(now, p) === "behind"
          ? `installed ${shown(now.version)}, the release has ${p.version}`
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

  // 5. the copies: links to a library copy and real folders holding exactly the release's files for the skill go once
  // their plugin verified; everything else in Codex's skill folders is Justin's to adopt or delete
  const carrier = (skill: string) => wanted.find((p) => p.skills.includes(skill));
  for (const l of state.loose) {
    if (!l.target) {
      out.push({ kind: "note", path: l.path, note: "a link whose target cannot be read; left alone" });
      continue;
    }
    const copy = libraryCopy(l.target, release.repo) ? (lexists(l.target) ? "library" : "dangling") : null;
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
        note:
          copy === "dangling"
            ? `dangling link; no plugin in ${release.tag} carries ${l.name}; left alone`
            : `links into a library copy, but no plugin in ${release.tag} carries ${l.name}; left alone`,
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
    if (!p) {
      out.push({
        kind: "note",
        path: f.path,
        note: `not in the latest release; adopt it into ${release.repo} or delete it by hand`,
      });
      continue;
    }
    if (!sameFiles(f.path, p, `skills/${f.name}/`)) {
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

/**
 * Codex's listing right now, as the probe shapes it, with the skills its prompt input shows each plugin loading (null
 * when it cannot render them); null when Codex cannot list.
 */
function inventory(h: HarnessState["harness"], run: Run): CliPlugin[] | null {
  const listed = listInstalled(h, run);
  if (!listed) return null;
  const skills = listed.length ? codexPluginSkills(run) : new Map<string, string[]>();
  return listed.map((i) => ({
    id: i.name,
    marketplace: i.marketplace,
    version: i.version,
    enabled: i.enabled,
    skills: skills ? (skills.get(i.name) ?? []) : null,
    path: i.folder,
  }));
}

/** The release's skills the plugin does not load. */
function missing(loaded: string[], p: ReleasePlugin): string[] {
  return p.skills.filter((s) => !loaded.includes(s));
}

/**
 * The installed plugin's version against the release's: "behind" (semver precedence when both parse; otherwise any
 * difference, Codex installs exactly the manifest's), "ahead" (the marketplace snapshot is main, which runs ahead of
 * releases/latest after every push until the release job finishes), "same", or "unversioned" when the release's plugin
 * has no version and its skill set alone decides.
 */
export function versionGap(
  have: Pick<CliPlugin, "version">,
  p: ReleasePlugin,
): "behind" | "ahead" | "same" | "unversioned" {
  if (p.version === null) return "unversioned";
  if (have.version === p.version) return "same";
  const a = have.version === null ? null : plainVersion(have.version);
  const b = plainVersion(p.version);
  if (a === null || b === null) return "behind";
  const c = compareVersions(a, b);
  return c < 0 ? "behind" : c > 0 ? "ahead" : "same";
}

/**
 * `https://github.com/oneezy/skills.git`, `git@github.com:oneezy/skills.git`, `ssh://git@github.com/oneezy/skills` or
 * `oneezy/skills` name the same repo; another host never does.
 */
function sameRepo(source: string, repo: string): boolean {
  const m = /^(?:(?:https?:\/\/|ssh:\/\/(?:git@)?|git@)github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(
    source.trim(),
  );
  return !!m && m[1].toLowerCase() === repo.toLowerCase();
}

/**
 * Does the folder hold exactly the release's files for the skill (the plugin's `skills/<name>/...` entries), each with
 * the release's sha256: nothing missing, nothing added, nothing edited. Anything else is the user's.
 */
function sameFiles(folder: string, p: ReleasePlugin, prefix: string): boolean {
  const want = new Map(
    Object.entries(p.files)
      .filter(([rel]) => rel.startsWith(prefix))
      .map(([rel, sha]) => [rel.slice(prefix.length), sha]),
  );
  if (!want.size) return false;
  const have = filesIn(folder);
  if (!have || have.length !== want.size) return false;
  return have.every((rel) => fileHash(path.join(folder, ...rel.split("/"))) === want.get(rel));
}

/** Every file under `dir`, as `/`-joined paths relative to it; null when something there is neither a file nor a folder. */
function filesIn(dir: string): string[] | null {
  const out: string[] = [];
  const walk = (d: string, rel: string): boolean => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) out.push(r);
      else if (!e.isDirectory() || !walk(path.join(d, e.name), r)) return false;
    }
    return true;
  };
  try {
    return walk(dir, "") ? out : null;
  } catch {
    return null;
  }
}

function fileHash(file: string): string | null {
  try {
    return toHash(fs.readFileSync(file));
  } catch {
    return null;
  }
}
