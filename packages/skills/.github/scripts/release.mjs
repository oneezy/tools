#!/usr/bin/env node
// The release record of one `main` commit, for the release job in .github/workflows/library.yml. It reads what
// `build --artifacts` wrote (artifacts/releases.json and the archives) and the committed packages under plugins/, and
// writes artifacts/release.json and artifacts/release-notes.md: the source commit and tree, the digests of
// skills-sync.json and skills-sync.lock.json, the npm version of the tool that built it, and per plugin its version,
// archive sha256 and every file with its sha256.
//
//   node release.mjs <library> [--previous <release.json>] [--tool-version <semver>] [--repo <owner/repo>]
//
// The release number is the previous one plus one (1 when there is none), and its tag is release-<n>. Nothing is
// released, and the step outputs say so (release=false), when the content is the previous release's: a promotion
// that changes no package, or a replay of the job. It exits 1, releasing nothing, when a plugin would go backwards:
// a lower authored version than the previous release, or unchanged authored versions for changed files.
// Locked upstream versions can remain unchanged across snapshots or move back in an intentional downgrade. With GITHUB_OUTPUT set it
// writes release, tag, number and reason as step outputs.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA = 3;
const VERSION_RE = /^0\.(\d+)\.0\+([0-9a-f]{12,40}|nogit)$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under dir, relative path with / separators -> sha256, sorted by path. */
export function inventory(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out[r] = sha256(fs.readFileSync(path.join(dir, r)));
    }
  };
  walk("");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => cmp(a, b)));
}

/** One digest for a file inventory: what "the same files" means between two releases. */
export function contentDigest(files) {
  return sha256(Object.entries(files).map(([p, h]) => `${p}\0${h}\n`).join(""));
}

/** The minor of a version of the rule; null for anything else. */
export function minor(version) {
  const m = VERSION_RE.exec(String(version ?? ""));
  return m ? Number(m[1]) : null;
}

/** Compare plain semantic precedence; build metadata in legacy records is ignored. */
function semver(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version ?? "");
  if (!m) return null;
  return { core: m.slice(1, 4).map(BigInt), pre: m[4]?.split(".") ?? [] };
}

function precedence(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return cmp(x.core[i], y.core[i]);
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return cmp(BigInt(p), BigInt(q));
    if (pn !== qn) return pn ? -1 : 1;
    return cmp(p, q);
  }
  return 0;
}

/** Authored releases advance deliberately; upstream packages retain the version of their locked snapshot. */
export function compare(previous, plugins) {
  const problems = [], changed = [], added = [], removed = [];
  const before = previous?.plugins ?? {};
  for (const [id, p] of Object.entries(plugins)) {
    const upstream = p.versionScheme === "upstream";
    const valid = upstream ? p.version === null || (semver(p.version) && !p.version.includes("+"))
      : /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(p.version ?? "");
    if (!valid) problems.push(`${id}: invalid ${upstream ? "upstream" : "authored"} semantic version ${p.version}`);
    const was = before[id];
    if (!was) { added.push(id); continue; }
    if (was.content === p.content) {
      if (was.version !== p.version) problems.push(`${id}: same files as ${previous.release} but version ${p.version} instead of ${was.version}`);
      continue;
    }
    changed.push(id);
    if (!upstream) {
      if (p.version === was.version) problems.push(`${id}: files changed since ${previous.release} but the version is still ${p.version}; bump library.version before releasing authored changes`);
      else if (precedence(p.version, was.version) === -1) problems.push(`${id}: version ${p.version} is lower than ${was.version} in ${previous.release}`);
    }
  }
  for (const id of Object.keys(before)) if (!plugins[id]) removed.push(id);
  return { problems, changed, added, removed };
}

/** The release record and its notes, or why there is none. */
export function plan({ library, previous, toolVersion, repo, commit, tree }) {
  const record = JSON.parse(fs.readFileSync(path.join(library, "artifacts", "releases.json"), "utf8"));
  const plugins = {};
  for (const [id, r] of Object.entries(record.plugins).sort(([a], [b]) => cmp(a, b))) {
    const archive = path.join(library, r.archive);
    if (sha256(fs.readFileSync(archive)) !== r.sha256) throw new Error(`${r.archive}: sha256 differs from artifacts/releases.json`);
    const files = inventory(path.join(library, "plugins", id));
    const listed = r.files.map((f) => f.slice(id.length + 1)).sort(cmp);
    if (JSON.stringify(listed) !== JSON.stringify(Object.keys(files))) throw new Error(`plugins/${id}: the committed package and ${r.archive} hold different files; run build --check`);
    plugins[id] = { version: r.version, versionScheme: r.versionScheme, commit: r.commit, archive: path.basename(r.archive), sha256: r.sha256, content: contentDigest(files), files };
  }
  const digest = (f) => (fs.existsSync(path.join(library, f)) ? sha256(fs.readFileSync(path.join(library, f))) : null);
  const content = contentDigest(Object.fromEntries(Object.entries(plugins).map(([id, p]) => [id, p.content])));
  if (previous && previous.source?.commit === commit) return { release: false, reason: `${commit.slice(0, 12)} is already ${previous.release}` };
  if (previous && previous.content === content) return { release: false, reason: `no package changed since ${previous.release}` };
  const diff = compare(previous, plugins);
  if (diff.problems.length) return { release: false, problems: diff.problems, reason: "invalid plugin version transition" };
  const number = (previous?.number ?? 0) + 1;
  const tag = `release-${number}`;
  const out = {
    schema: SCHEMA,
    release: tag,
    number,
    previous: previous?.release ?? null,
    source: { repo, commit, tree },
    tool: { repo: "oneezy/tools", package: "@oneezy/skills-sync", version: toolVersion || null },
    digests: { "skills-sync.json": digest("skills-sync.json"), "skills-sync.lock.json": digest("skills-sync.lock.json") },
    content,
    changes: { added: diff.added, changed: diff.changed, removed: diff.removed },
    plugins,
  };
  return { release: true, tag, number, record: out, notes: notes(out) };
}

function notes(r) {
  const mark = (id) => (r.changes.added.includes(id) ? "new" : r.changes.changed.includes(id) ? "changed" : "");
  return [
    `Release ${r.number} of [${r.source.repo}](https://github.com/${r.source.repo}) at ${r.source.commit}${r.previous ? `, after ${r.previous}` : ""}. Every package is checked (\`refresh --frozen\`, \`build --check\`, \`check\`) before this job runs; \`release.json\` holds every file's sha256.`,
    "",
    "| Plugin | Version | | Archive sha256 |",
    "|---|---|---|---|",
    ...Object.entries(r.plugins).map(([id, p]) => `| ${id} | \`${p.version ?? "unversioned"}\` | ${mark(id)} | \`${p.sha256.slice(0, 16)}…\` |`),
    "",
    ...(r.changes.removed.length ? [`Removed: ${r.changes.removed.join(", ")}.`, ""] : []),
    "Install or update:",
    "",
    "- Claude Code: switch each plugin on at https://claude.ai/customize/plugins; it arrives as `<plugin>@synced` (ADR-0007). Do not `claude plugin install` it on a machine that runs Skills Sync: a CLI install hides the account plugin and `status` reports it red.",
    "- Every machine with Skills Sync (Claude Code, Codex, Hermes): `npx --yes @oneezy/skills-sync@latest`. It reads the latest release from GitHub, clones nothing and keeps nothing of its own; `npx --yes @oneezy/skills-sync@latest status` lists the manual steps still open.",
    "- ChatGPT: type `@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release` in a ChatGPT chat (`docs/agents/chatgpt-upload.md`).",
    "",
  ].join("\n");
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const prevFile = opt("--previous");
  const toolVersion = opt("--tool-version");
  const repo = opt("--repo") ?? process.env.GITHUB_REPOSITORY ?? "oneezy/skills";
  const library = path.resolve(argv[0] ?? ".");
  const git = (...a) => execFileSync("git", ["-C", library, ...a], { encoding: "utf8" }).trim();
  const previous = prevFile && fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, "utf8")) : null;
  const r = plan({ library, previous, toolVersion, repo, commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") });
  const outputs = { release: String(r.release), tag: r.tag ?? "", number: String(r.number ?? ""), reason: r.reason ?? "" };
  if (r.release) {
    fs.writeFileSync(path.join(library, "artifacts", "release.json"), JSON.stringify(r.record, null, 2) + "\n");
    fs.writeFileSync(path.join(library, "artifacts", "release-notes.md"), r.notes);
    console.log(`${r.tag}: ${Object.keys(r.record.plugins).length} plugins, changed: ${[...r.record.changes.added, ...r.record.changes.changed].join(", ") || "none"}`);
  } else console.log(`no release: ${r.reason}`);
  for (const p of r.problems ?? []) console.log(`::error title=release refused::${p}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
  return r.problems?.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
