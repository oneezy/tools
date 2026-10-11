// Hermes's form: the library's plugins from GitHub (ADR-0007; oneezy/skills#68 said go). For every plugin the release
// lists: `hermes plugins install <repo>/dist/hermes/<id> --no-enable --ref <release commit>` (the Hermes rendering build
// writes beside plugins/<id>: the same package without metadata.internal, which Hermes's portable loader rejects), then
// `hermes plugins enable <id>`, then verification: hermes itself lists the plugin enabled, the folder carries the
// release's version, skill set and NOTICE.md (its sha256 is in release.json; every file but the skills' SKILL.md is byte
// for byte the package's), and every skill passes Hermes's portable rules. Only then do the loose links in <home>/skills
// whose names the plugin carries, and whose targets are a library copy or gone, come out; a real folder or a foreign
// link of that name is reported and left, and so is every link or folder no plugin of the release carries (one line
// each, adopt or delete by hand). A plugin behind the release is re-installed at the new commit with --force (that is
// how a pinned install moves; `update` refuses one); one ahead of it (installed by hand from main) is a note and stays.
// Before the first install of a run, GitHub is asked once whether the release commit carries dist/hermes at all: until
// the library's first release built with this tool it does not, and that is one note, not seven failed clones. A
// failed step is a conflict and the loose links stay; nothing hermes did not install for this library is ever touched.
// --plan runs no hermes command that changes anything; a steady-state sync (every plugin current, nothing redundant)
// asks hermes nothing but its --help probe and GitHub nothing beyond the release.
// Hermes lists a plugin's skills as agent-plugin-<id>-<sha256(id)[:8]>:<skill>; the bare /<skill> is a loose skill's.
import fs from "node:fs";
import path from "node:path";
import { HERMES_PATH, hermesSkillProblems } from "../build.js";
import type { FormFn } from "../desired.js";
import { isDir, isLink, isSkillDir, toHash } from "../fs.js";
import { GitHubError, type GitHub } from "../github.js";
import { githubRepo, hermesNamespace, hermesPlugins, type HermesPlugin } from "../hermes.js";
import { hermes as cli, runner } from "../install.js";
import type { CliPlugin } from "../machine.js";
import type { Action } from "../plan.js";
import type { Release, ReleasePlugin } from "../release.js";
import { versionGap } from "./codex.js";
import { dangling, isLibraryCopy } from "./library-copy.js";

export const hermes: FormFn = async (release, state, _machine, { plan, github }) => {
  const h = state.harness;
  const where = (what: string) => `${h.name}: ${what}`;
  const out: Action[] = [];
  if (!release)
    return [{ kind: "note", path: where("plugins"), note: "not compared; the latest release was not read" }];
  // no hermes to run: a note, as Codex's form says it (the harness folder is there; whether Hermes is is not for this run)
  if (!state.cli)
    return [
      { kind: "note", path: where("plugins"), note: `no ${cli.bin} on PATH; nothing installed, loose links kept` },
    ];
  const run = runner(state.cli);
  if (!cli.supports(run))
    return [
      {
        kind: "conflict",
        path: where("plugins"),
        note: `this ${cli.bin} has no plugins command; loose links kept`,
        ...(run.failure ? { diagnostic: run.failure } : {}),
      },
    ];
  const fail = (what: string, why: string, diagnostic = run.failure) =>
    out.push({ kind: "conflict", path: where(what), note: why, ...(diagnostic ? { diagnostic } : {}) });

  const home = h.configDir;
  const commit = release.commit.slice(0, 7);
  const plugins = Object.values(release.plugins).sort((a, b) => a.id.localeCompare(b.id));

  // 1. what each plugin needs, from the probe alone: nothing runs yet
  type Need = { p: ReleasePlugin; have: CliPlugin | undefined; install: string | null; ahead: boolean };
  const needs: Need[] = [];
  for (const p of plugins) {
    const what = `plugin ${p.id}`;
    const folder = path.join(home, "plugins", p.id);
    const have = state.installed.find((x) => x.id === p.id);
    if (isLink(folder)) {
      fail(what, `${folder} is a link, not a plugin hermes installed; left alone, loose links kept`);
      continue;
    }
    if (have && !have.install) {
      fail(what, `${folder} was not installed through hermes plugins; left alone, loose links kept`);
      continue;
    }
    if (have?.install && githubRepo(have.install.url) !== release.repo.toLowerCase()) {
      fail(what, `installed from ${have.install.url}, not ${release.repo}; left alone, loose links kept`);
      continue;
    }
    if (have?.activation === "disabled") {
      fail(what, "installed but disabled (plugins.disabled in config.yaml); left alone, loose links kept");
      continue;
    }
    if (have && isAhead(have, p)) {
      // installed by hand from main, which runs ahead of releases/latest: nothing to pin it back to
      out.push({
        kind: "note",
        path: where(what),
        note: `${have.version} is ahead of the latest release (${p.version}); left as it is`,
      });
      needs.push({ p, have, install: null, ahead: true });
      continue;
    }
    needs.push({ p, have, install: have ? behind(have, p, release) : "not installed", ahead: false });
  }

  // 2. the release commit must carry the rendering before anything is installed from it: one GitHub question, asked
  // only when an install is due (the library's releases before the first one built with this tool have none)
  if (needs.some((n) => n.install) && !(await hasRendering(github, release))) {
    out.push({
      kind: "note",
      path: where("plugins"),
      note: `${release.tag} carries no Hermes rendering yet, no ${HERMES_PATH}/ at ${commit}; nothing installed, loose links kept`,
    });
    return out;
  }

  // 3. install and enable, in id order
  /** the plugins installed (or found installed and current) this run, to verify before any link goes */
  const candidates: Need[] = [];
  /** the plugins installed (or, on --plan, that would be) this run */
  const installed: string[] = [];
  for (const n of needs) {
    const { p, have } = n;
    const what = `plugin ${p.id}`;
    const identifier = `${release.repo}/${HERMES_PATH}/${p.id}`;
    if (n.install) {
      const action: Action = {
        kind: "install",
        path: where(what),
        target: identifier,
        note: have
          ? `${have.version ?? "no version"} -> ${p.version ?? "no version"} at ${commit}; ${n.install}`
          : `${p.version ?? "no version"} at ${commit}`,
      };
      // --force only over this tool's own install (checked above): it is how a pinned install moves to a new commit
      if (!plan && !cli.install(run, identifier, { ref: release.commit, force: !!have })) {
        fail(
          what,
          `${cli.bin} could not install it; loose links kept. If ${cli.bin} asked to confirm its security scan ` +
            `(a caution verdict), run once by hand: ${cli.bin} plugins install ${identifier} --no-enable ` +
            `--ref ${release.commit} --force`,
        );
        continue;
      }
      out.push(action);
      installed.push(p.id);
    } else if (!n.ahead) out.push({ kind: "skip", path: where(what), note: `installed, ${p.version ?? "no version"}` });
    // a fresh install is "not enabled" (--no-enable); a re-install keeps the list entry it had
    const activation = have?.activation ?? "not enabled";
    if (activation !== "enabled") {
      out.push({ kind: "install", path: where(what), note: "enable" });
      if (!plan && !cli.enable(run, p.id)) {
        fail(what, `${cli.bin} could not enable it; loose links kept`);
        continue;
      }
    }
    candidates.push(n);
  }
  // the names Hermes gives the skills a plugin brings, said once, when a plugin was (or would be) installed
  if (installed.length)
    out.push({
      kind: "note",
      path: where("plugins"),
      note:
        `Hermes lists a plugin's skills as <namespace>:<skill>, the slash form ` +
        `/${hermesNamespace(installed[0])}:<skill>; namespaces: ${installed.map(hermesNamespace).join(", ")}`,
    });

  // 4. verification. hermes is asked to list only when something hinges on it: a plugin was installed or enabled this
  // run, or a loose link or folder of a plugin's skill is there to judge; a steady-state sync asks nothing (list
  // resolves the catalog over the network on every call)
  /** skill -> the plugin that carries it, once that plugin is verified (on plan: would be, after the installs) */
  const carried = new Map<string, string>();
  const changed = out.some((a) => a.kind === "install");
  const redundant = candidates.some((n) =>
    n.p.skills.some((s) => state.loose.some((l) => l.name === s) || state.folders.some((f) => f.name === s)),
  );
  if (plan) {
    for (const n of candidates) for (const s of n.p.skills) carried.set(s, n.p.id);
  } else if (candidates.length && (changed || redundant)) {
    // verify before any link goes: hermes's own listing says enabled, and the folder is the release's package
    const listed = cli.list(run);
    const now = listed ? hermesPlugins(home) : [];
    for (const { p, ahead } of candidates) {
      const what = `plugin ${p.id}`;
      if (!listed) {
        fail(what, `${cli.bin} could not list its plugins; installed but not verified, loose links kept`);
        continue;
      }
      const row = listed.find((x) => x.name === p.id);
      const disk = now.find((x) => x.id === p.id);
      const reason = !row
        ? `${cli.bin} does not list it`
        : row.status !== "enabled"
          ? `${cli.bin} lists it ${row.status}`
          : !disk
            ? `no plugin.json under ${path.join(home, "plugins", p.id)}`
            : ahead
              ? null // a newer package than the release's: its own files, not the release's, are what it holds
              : (behind(disk, p, release) ?? skillsProblem(disk, p));
      if (reason) {
        fail(what, `installed but not verified (${reason}); loose links kept`, undefined);
        continue;
      }
      // an ahead plugin carries the release's skills it still has
      for (const s of p.skills) if (!ahead || disk!.skills.includes(s)) carried.set(s, p.id);
    }
  }

  // 5. what is in <home>/skills: the tool's own links (a library copy, or gone) go once their plugin verified; anything
  // else is reported, one line each, and left
  const carrier = (skill: string) => plugins.find((p) => p.skills.includes(skill));
  for (const l of state.loose) {
    if (!l.target) {
      out.push({ kind: "note", path: l.path, note: "a link whose target cannot be read; left alone" });
      continue;
    }
    const copy = dangling(l.target) ? "dangling" : isLibraryCopy(l.target, release.repo) ? "library" : null;
    const p = carrier(l.name);
    if (!p) {
      out.push({
        kind: "note",
        path: l.path,
        note: !copy
          ? `links to ${l.target}, not a library copy; adopt it into ${release.repo} or delete it by hand`
          : copy === "dangling"
            ? `dangling link; no plugin in ${release.tag} carries ${l.name}; left alone`
            : `links into a library copy, but no plugin in ${release.tag} carries ${l.name}; left alone`,
      });
      continue;
    }
    // the plugin did not verify this run: its lines said the links stay
    if (!carried.has(l.name)) continue;
    if (!copy) {
      out.push({
        kind: "conflict",
        path: l.path,
        note: `link points outside the library (${l.target}) and plugin ${p.id} also carries ${l.name}; left alone`,
      });
      continue;
    }
    out.push({ kind: "remove", path: l.path, note: `carried by plugin ${p.id}${plan ? ", once it verifies" : ""}` });
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
    if (!carried.has(f.name)) continue;
    out.push({
      kind: "conflict",
      path: f.path,
      note: `a real folder, and plugin ${p.id} also carries ${f.name}; left alone (delete it by hand to keep ${f.name} once)`,
    });
  }
  return out;
};

/**
 * Does the release commit carry the Hermes rendering (dist/hermes/ in the library at that commit)? Asked of GitHub
 * once per run, before the first install: a 404 is a plain no; without a client, or when GitHub answers anything else,
 * the installs go ahead and hermes's own message tells.
 */
async function hasRendering(github: GitHub | null | undefined, release: Release): Promise<boolean> {
  if (!github) return true;
  try {
    await github.getJson(`/repos/${release.repo}/contents/${HERMES_PATH}?ref=${release.commit}`);
    return true;
  } catch (e) {
    return !(e instanceof GitHubError && e.status === 404);
  }
}

/**
 * Is the installed plugin this tool's kind of install (from the rendering) at a newer version than the release's: one
 * installed by hand from main, which runs ahead of releases/latest. Semver, as Codex's form reads it.
 */
function isAhead(have: CliPlugin, p: ReleasePlugin): boolean {
  return have.install?.subdir === `${HERMES_PATH}/${p.id}` && versionGap(have, p) === "ahead";
}

/**
 * Why an installed Hermes plugin is not the release's, or null when it is: taken from the Hermes rendering of this
 * plugin, the release's version (semver, as Codex's form reads it), the release's skill set, and the release's NOTICE.md
 * (an upstream snapshot can move without a version change; its NOTICE names the commit, so its sha256 in release.json
 * tells; a copy whose git turned its line endings to CRLF still counts).
 */
function behind(have: CliPlugin | HermesPlugin, p: ReleasePlugin, release: Release): string | null {
  const subdir = `${HERMES_PATH}/${p.id}`;
  if (have.install?.subdir !== subdir)
    return `installed from ${have.install?.subdir ?? "the repository root"}, not ${subdir}`;
  if (versionGap(have, p) === "behind")
    return `version ${have.version ?? "none"}, the release has ${p.version ?? "none"}`;
  const skills = have.skills ?? [];
  if (!sameSet(skills, p.skills)) {
    const missing = p.skills.filter((s) => !skills.includes(s));
    const extra = skills.filter((s) => !p.skills.includes(s));
    const parts = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      extra.length ? `extra ${extra.join(", ")}` : "",
    ];
    return `skills differ: ${parts.filter(Boolean).join("; ")}`;
  }
  const want = p.files["NOTICE.md"];
  if (want && have.path && !sameNotice(path.join(have.path, "NOTICE.md"), want))
    return `NOTICE.md is not ${release.tag}'s`;
  return null;
}

/**
 * Is the file the release's NOTICE.md (by sha256), as committed or as a git with core.autocrlf=true checks it out
 * (every LF turned CRLF; Git for Windows' installer default, and `hermes plugins install` clones through the user's
 * git)? A missing file is not.
 */
function sameNotice(file: string, sha: string): boolean {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return false;
  }
  if (toHash(bytes) === sha) return true;
  if (!bytes.includes(0x0d)) return false;
  return toHash(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")) === sha;
}

/** The first skill of the plugin Hermes would skip, with why; null when every one loads. */
function skillsProblem(disk: HermesPlugin, p: ReleasePlugin): string | null {
  for (const s of p.skills) {
    const dir = path.join(disk.path, "skills", s);
    if (!isDir(dir) || !isSkillDir(dir)) return `no skills/${s}/SKILL.md`;
    const problems = hermesSkillProblems(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"), s);
    if (problems.length) return `Hermes would skip ${s}: ${problems.join("; ")}`;
  }
  return null;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}
