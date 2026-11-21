#!/usr/bin/env node
// publish-mirror: copies this package (oneezy/tools packages/skills) into a checkout of oneezy/skills, the release
// mirror (ADR-0021), builds it there with the published @oneezy/skills-sync, commits, and with --push pushes
// land/mirror-<tools sha>. oneezy/skills' own land.yml then squashes that branch into its dev, promotes main and cuts
// release-<n>, exactly as before the library moved here.
//
//   node packages/skills/scripts/publish-mirror.mjs [--skills <checkout>] [--push] [--no-build] [--source <dir>]
//
// --skills   an oneezy/skills checkout on dev to write into; without it, a fresh clone of dev in a temporary folder.
// --push     push the commit as land/mirror-<sha>. Without it the commit stays local and the folder is printed.
// --no-build skip refresh, build and check (tests only: the land run refuses an unbuilt tree).
// --source   the package folder to copy (default: this script's package). Tracked files only, from a clean tree.
//
// What moves: every file git tracks in the package, except the tools-only files below. Files under mirror/ are the
// mirror's own root files (README.md, AGENTS.md, CLAUDE.md) and land at the mirror's root. A tracked file in the
// mirror that the package no longer has is deleted, unless the mirror owns it (its .github/, .legacy/, .gitignore)
// or the build writes it (plugins/, dist/, the two marketplace catalogs).
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIRROR_REPO = "https://github.com/oneezy/skills";

/** Package files that stay in tools: its workspace wiring, its own docs, and the inert copy of the mirror's workflows. */
const TOOLS_ONLY = [
  /^package\.json$/,
  /^vite\.config\.ts$/,
  /^\.gitignore$/,
  /^README\.md$/,
  /^AGENTS\.md$/,
  /^CLAUDE\.md$/,
  /^DEVELOPMENT\.md$/,
  /^\.github\//,
  /^scripts\/publish-mirror\./,
];

/** Mirror paths the copy never deletes: the mirror's own files and what the build writes. */
const MIRROR_KEEPS = [
  /^\.github\//,
  /^\.legacy\//,
  /^\.gitignore$/,
  /^plugins\//,
  /^dist\//,
  /^\.claude-plugin\//,
  /^\.agents\/plugins\//,
];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const lines = (text) => (text ? text.split("\n").filter(Boolean) : []);

/**
 * Where each tracked package file lands in the mirror. Returns a Map of mirror path → package path.
 * @param {string[]} files package-relative tracked paths
 */
export function mirrorPlan(files) {
  const plan = new Map();
  for (const file of files) {
    if (file.startsWith("mirror/")) plan.set(file.slice("mirror/".length), file);
    else if (!TOOLS_ONLY.some((re) => re.test(file))) plan.set(file, file);
  }
  return plan;
}

/** Mirror files to delete: tracked there, absent from the plan, and not kept. */
export function mirrorDeletions(mirrorFiles, plan) {
  return mirrorFiles.filter((file) => !plan.has(file) && !MIRROR_KEEPS.some((re) => re.test(file)));
}

function parseArgs(argv) {
  const args = { push: false, build: true, skills: undefined, source: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--push") args.push = true;
    else if (a === "--no-build") args.build = false;
    else if (a === "--skills") args.skills = argv[++i];
    else if (a === "--source") args.source = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

export function publishMirror({ source, skills, build = true, push = false, log = console.log }) {
  source = resolve(source ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const dirty = git(source, "status", "--porcelain", "--", ".");
  if (dirty) throw new Error(`the package has uncommitted changes; commit them first:\n${dirty}`);
  const sha = git(source, "rev-parse", "HEAD");
  const short = sha.slice(0, 7);

  if (!skills) {
    skills = join(mkdtempSync(join(tmpdir(), "skills-mirror-")), "skills");
    execFileSync("git", ["clone", "--quiet", "--branch", "dev", MIRROR_REPO, skills], { stdio: "inherit" });
  }
  skills = resolve(skills);
  if (git(skills, "status", "--porcelain")) throw new Error(`the mirror checkout ${skills} has uncommitted changes`);

  const plan = mirrorPlan(lines(git(source, "ls-files", "--", ".")));
  const deletions = mirrorDeletions(lines(git(skills, "ls-files")), plan);
  for (const file of deletions) rmSync(join(skills, file));
  for (const [to, from] of plan) {
    mkdirSync(dirname(join(skills, to)), { recursive: true });
    cpSync(join(source, from), join(skills, to));
  }
  log(`copied ${plan.size} files from oneezy/tools ${short}, deleted ${deletions.length}`);

  if (build) {
    const cli = ["--yes", "@oneezy/skills-sync@latest"];
    for (const step of [["refresh", "--frozen"], ["build"], ["check"]]) {
      // npx is a .cmd shim on Windows, which execFileSync starts only through a shell.
      execFileSync("npx", [...cli, ...step, "--repo", "."], { cwd: skills, stdio: "inherit", shell: process.platform === "win32" });
    }
  }

  git(skills, "add", "-A");
  if (!git(skills, "status", "--porcelain")) {
    log("nothing to mirror: oneezy/skills dev already matches");
    return { skills, branch: null, sha };
  }
  const version = JSON.parse(readFileSync(join(source, "skills-sync.json"), "utf8")).library?.version ?? "unversioned";
  const branch = `land/mirror-${short}`;
  git(skills, "checkout", "-B", branch);
  git(
    skills,
    "commit",
    "--quiet",
    "-m",
    `🔁 chore(mirror): publish oneezy/tools ${short} (library ${version})`,
    "-m",
    `Generated from https://github.com/oneezy/tools/tree/${sha}/packages/skills by packages/skills/scripts/publish-mirror.mjs. Edit there, not here.`,
  );
  if (push) {
    git(skills, "push", "--quiet", "-u", "origin", branch);
    log(`pushed ${branch}; oneezy/skills land.yml lands it and cuts the release`);
  } else log(`committed ${branch} in ${skills}; run again with --push to publish`);
  return { skills, branch, sha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishMirror(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`publish-mirror: ${error.message}`);
    process.exit(1);
  }
}

