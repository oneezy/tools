// Hermes's form: the library's plugins from GitHub (ADR-0007; oneezy/skills#68 said go). For every plugin the release
// lists: `hermes plugins install <repo>/dist/hermes/<id> --no-enable --ref <release commit>` (the Hermes rendering build
// writes beside plugins/<id>: the same package without metadata.internal, which Hermes's portable loader rejects), then
// `hermes plugins enable <id>`, then verification: hermes itself lists the plugin enabled, the folder carries the
// release's version, skill set and NOTICE.md (its sha256 is in release.json; every file but the skills' SKILL.md is byte
// for byte the package's), and every skill passes Hermes's portable rules. Only then do the loose links in <home>/skills
// whose names the plugin carries, and whose targets are a library copy or gone, come out; a real folder or a foreign
// link of that name is reported and left. A plugin behind the release is re-installed at the new commit with --force
// (that is how a pinned install moves; `update` refuses one). A failed step is a conflict and the loose links stay;
// nothing hermes did not install for this library is ever touched. --plan runs no hermes command that changes anything.
// Hermes lists a plugin's skills as agent-plugin-<id>-<sha256(id)[:8]>:<skill>; the bare /<skill> is a loose skill's.
import fs from "node:fs";
import path from "node:path";
import { HERMES_PATH, hermesSkillProblems } from "../build.js";
import type { FormFn } from "../desired.js";
import { isDir, isLink, isSkillDir, toHash } from "../fs.js";
import { githubRepo, hermesNamespace, hermesPlugins, type HermesPlugin } from "../hermes.js";
import { hermes as cli, runner } from "../install.js";
import type { CliPlugin } from "../machine.js";
import type { Action } from "../plan.js";
import type { Release, ReleasePlugin } from "../release.js";
import { dangling, isLibraryCopy } from "./library-copy.js";

export const hermes: FormFn = (release, state, _machine, { plan }) => {
  const h = state.harness;
  const where = (what: string) => `${h.name}: ${what}`;
  const out: Action[] = [];
  if (!release)
    return [{ kind: "note", path: h.name, note: `${h.name}: plugins not compared; the latest release was not read` }];
  if (!state.cli)
    return [{ kind: "note", path: h.userSkills, note: `${h.name}: no ${cli.bin} on PATH; loose links kept` }];
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
  /** the plugins installed (or found installed and current) this run, to verify before any link goes */
  const candidates: ReleasePlugin[] = [];
  for (const p of Object.values(release.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
    const what = `plugin ${p.id}`;
    const folder = path.join(home, "plugins", p.id);
    const identifier = `${release.repo}/${HERMES_PATH}/${p.id}`;
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
    const why = have ? behind(have, p, release) : null;
    if (!have || why) {
      out.push({
        kind: "install",
        path: where(what),
        target: identifier,
        note: have
          ? `${have.version ?? "no version"} -> ${p.version ?? "no version"} at ${commit}; ${why}`
          : `${p.version ?? "no version"} at ${commit}`,
      });
      if (!plan) {
        // --force only over this tool's own install (checked above): it is how a pinned install moves to a new commit
        if (!cli.install(run, identifier, { ref: release.commit, force: !!have })) {
          fail(
            what,
            `${cli.bin} could not install it; loose links kept. If ${cli.bin} asked to confirm its security scan (a caution verdict), run once by hand: ${cli.bin} plugins install ${identifier} --no-enable --ref ${release.commit} --force`,
          );
          continue;
        }
      }
    } else out.push({ kind: "skip", path: where(what), note: `installed, ${p.version ?? "no version"}` });
    // a fresh install is "not enabled" (--no-enable); a re-install keeps the list entry it had
    const activation = have?.activation ?? "not enabled";
    if (activation !== "enabled") {
      out.push({ kind: "install", path: where(what), note: "enable" });
      if (!plan && !cli.enable(run, p.id)) {
        fail(what, `${cli.bin} could not enable it; loose links kept`);
        continue;
      }
    }
    candidates.push(p);
  }
  // the names Hermes gives the skills a plugin brings, said once, when a plugin was (or would be) installed
  const installs = out.filter((a) => a.kind === "install" && a.target).map((a) => a.path.slice(where("plugin ").length));
  if (installs.length)
    out.push({
      kind: "note",
      path: where("plugins"),
      note: `Hermes lists a plugin's skills as <namespace>:<skill>, the slash form /${hermesNamespace(installs[0])}:<skill>; namespaces: ${installs.map(hermesNamespace).join(", ")}`,
    });

  /** skill -> the plugin that carries it, once that plugin is verified (on plan: would be, after the installs) */
  const carried = new Map<string, string>();
  if (plan) {
    for (const p of candidates) for (const s of p.skills) carried.set(s, p.id);
  } else if (candidates.length) {
    // verify before any link goes: hermes's own listing says enabled, and the folder is the release's package
    const listed = cli.list(run);
    const now = listed ? hermesPlugins(home) : [];
    for (const p of candidates) {
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
            : (behind(disk, p, release) ?? skillsProblem(disk, p));
      if (reason) {
        fail(what, `installed but not verified (${reason}); loose links kept`, undefined);
        continue;
      }
      for (const s of p.skills) carried.set(s, p.id);
    }
  }

  // the loose links a verified plugin makes redundant: the tool's (a library copy, or gone) go; anything else is reported
  for (const [skill, id] of carried) {
    const link = state.loose.find((l) => l.name === skill);
    if (link) {
      if (dangling(link.target) || isLibraryCopy(link.target, release.repo))
        out.push({
          kind: "remove",
          path: link.path,
          note: `carried by plugin ${id}${plan ? ", once it verifies" : ""}`,
        });
      else
        out.push({
          kind: "conflict",
          path: link.path,
          note: `link points outside the library (${link.target}) and plugin ${id} also carries ${skill}; left alone`,
        });
      continue;
    }
    const folder = state.folders.find((f) => f.name === skill);
    if (folder)
      out.push({
        kind: "conflict",
        path: folder.path,
        note: `a real folder, and plugin ${id} also carries ${skill}; left alone (delete it by hand to keep ${skill} once)`,
      });
  }
  return out;
};

/**
 * Why an installed Hermes plugin is not the release's, or null when it is: taken from the Hermes rendering of this
 * plugin, the release's version, the release's skill set, and the release's NOTICE.md byte for byte (an upstream
 * snapshot can move without a version change; its NOTICE names the commit, so its sha256 in release.json tells).
 */
function behind(have: CliPlugin | HermesPlugin, p: ReleasePlugin, release: Release): string | null {
  const subdir = `${HERMES_PATH}/${p.id}`;
  if (have.install?.subdir !== subdir) return `installed from ${have.install?.subdir ?? "the repository root"}, not ${subdir}`;
  if (have.version !== p.version) return `version ${have.version ?? "none"}, the release has ${p.version ?? "none"}`;
  const skills = have.skills ?? [];
  if (!sameSet(skills, p.skills)) {
    const missing = p.skills.filter((s) => !skills.includes(s));
    const extra = skills.filter((s) => !p.skills.includes(s));
    return `skills differ: ${[missing.length ? `missing ${missing.join(", ")}` : "", extra.length ? `extra ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}`;
  }
  const want = p.files["NOTICE.md"];
  if (want && have.path) {
    const file = path.join(have.path, "NOTICE.md");
    let got: string | null = null;
    try {
      got = toHash(fs.readFileSync(file));
    } catch {
      /* no NOTICE.md: not the release's package */
    }
    if (got !== want) return `NOTICE.md is not ${release.tag}'s`;
  }
  return null;
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
