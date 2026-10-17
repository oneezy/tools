#!/usr/bin/env node
// The land commit of one run of .github/workflows/run.yml (run.sh): the report `update` or `add` printed with --json,
// turned into the commit's subject and body, and the config change a hold needs applied to skills-sync.json.
//
//   node run-report.mjs apply-config <library> <report.json>
//   node run-report.mjs message <library> <report.json> --command <update|add|rename> [--args "<args>"]
//                               [--tool-version <semver>] [--run <url>] [--out <file>]
//
// apply-config: for each entry of the report's `config` (what `update <source> --to <version>` asks the caller to land)
// sets sources.<id>.version in skills-sync.json, or removes it for null, the way references/changes.md tells an agent
// to; the tool never writes the config itself. Prints one line per change; a report with no `config` changes nothing.
//
// message: the commit message, printed and written to --out. Subject `🔧 chore(repo): <command> <ids>` (the ids
// the report moved), then per moved source its version, commit and commits past that version before and after, the
// upstream changelog range the move brings (an upgrade) or undoes (a downgrade), the lines of it that speak of a
// breaking change, a migration or a deprecation flagged for /oneezy-migrate, the config changes, the tool's version
// and the run. A report that moved nothing describes a rebuild of the packages alone (the tree still changed, or
// run.sh would not ask for a message); a report with no `updated` at all (a command the tool prints no report for) names
// the command and its arguments and leaves the diff as the report. land.yml squashes the branch onto dev with this
// message, so it is what dev's history and /oneezy-migrate read.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG = "skills-sync.json";
const FLAG = /\b(breaking|migrat\w*|deprecat\w*)\b/i;
/** Changelog lines kept per source in the body; the rest is a count, the upstream file has it all. */
const CHANGELOG_LINES = 120;

const short = (c) => (c ? String(c).slice(0, 7) : "none");

/** A source's place as the body shows it: `1.3.1 (7a030a8, +5)`, `(new)` for a source new to the lock. */
export function position(p) {
  if (!p) return "(new)";
  const past = p.ahead ? `, +${p.ahead}` : "";
  return `${p.version ?? "no version"} (${short(p.commit)}${past})`;
}

/** Apply the report's config entries to a parsed skills-sync.json: the new config and one line per change. */
export function applyConfig(config, entries) {
  const lines = [];
  const next = structuredClone(config);
  for (const { source, version } of entries ?? []) {
    const src = next.sources?.[source];
    if (!src) {
      lines.push(`${CONFIG}: no source ${source}; its hold is not written`);
      continue;
    }
    if (version === null) {
      if ("version" in src) {
        delete src.version;
        lines.push(`${CONFIG}: removed sources.${source}.version (follows latest)`);
      }
    } else if (src.version !== version) {
      src.version = version;
      lines.push(`${CONFIG}: sources.${source}.version = "${version}"`);
    }
  }
  return { config: next, lines };
}

/** The changelog lines that speak of a breaking change, a migration or a deprecation; headings are not lines. */
export function flagged(changelog) {
  return String(changelog ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l) && FLAG.test(l));
}

/** The commit message for a run's report. */
export function message({ command, args = "", report = {}, toolVersion = "", run = "", configLines = [] }) {
  const tool = `@oneezy/skills-sync${toolVersion ? ` ${toolVersion}` : ""}`;
  const asked = `${command}${args.trim() ? ` ${args.trim()}` : ""}`;
  const by = `\`${asked}\`, run by .github/workflows/run.yml with ${tool},`;
  if (!Array.isArray(report.updated)) {
    const body = [`${by} changed the library; the diff is the report.`, ...(run ? ["", `Run: ${run}`] : [])];
    return `🔧 chore(repo): ${asked}\n\n${body.join("\n")}\n`;
  }
  const updated = report.updated;
  const ids = updated.map((u) => u.id);
  const subject = ids.length
    ? `🔧 chore(repo): ${command} ${ids.join(", ")}`
    : `🔧 chore(repo): rebuild plugins with ${tool.replace(/^@oneezy\//, "")}`;
  const body = [
    ids.length
      ? `${by} moved ${ids.length} source${ids.length === 1 ? "" : "s"} and rebuilt the packages.`
      : `${by} moved no source; the packages it rebuilt differ from the committed ones, so this commit carries the rebuild alone.`,
  ];
  const flags = [];
  for (const u of updated) {
    body.push("", `${u.id}: ${position(u.from)} → ${position(u.to)}, ${u.direction}`);
    if (u.changelog === null || u.changelog === undefined) {
      body.push(`  changelog: none (${u.changelogReason ?? "not given"})`);
      continue;
    }
    const [low, high] = u.direction === "upgrade" ? [u.from, u.to] : [u.to, u.from];
    body.push(`  ${u.direction === "upgrade" ? "changelog" : "undoes the changelog"} after ${low?.version} up to ${high?.version}:`);
    const lines = u.changelog.replace(/\n+$/, "").split("\n");
    for (const l of lines.slice(0, CHANGELOG_LINES)) body.push(l ? `    ${l}` : "");
    if (lines.length > CHANGELOG_LINES) body.push(`    … ${lines.length - CHANGELOG_LINES} more lines in the upstream CHANGELOG.md`);
    for (const l of flagged(u.changelog)) flags.push(`  ${u.id}: ${l}`);
  }
  body.push("");
  if (flags.length) body.push(`Flagged for /oneezy-migrate (${flags.length} line${flags.length === 1 ? "" : "s"}):`, ...flags);
  else body.push("Flagged for /oneezy-migrate: nothing; no changelog line names a breaking change, a migration or a deprecation.");
  if (configLines.length) body.push("", "Config:", ...configLines.map((l) => `  ${l}`));
  if (run) body.push("", `Run: ${run}`);
  return `${subject}\n\n${body.join("\n")}\n`;
}

/** The config lines apply-config wrote, recomputed against the committed config so the body says what changed. */
function committedConfigLines(library, report) {
  try {
    const text = execFileSync("git", ["-C", library, "show", `HEAD:${CONFIG}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return applyConfig(JSON.parse(text), report.config).lines;
  } catch {
    return [];
  }
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv.splice(i, 2)[1] : undefined;
  };
  const command = opt("--command");
  const args = opt("--args") ?? "";
  const toolVersion = opt("--tool-version") ?? "";
  const run = opt("--run") ?? "";
  const out = opt("--out");
  const [mode, lib, reportFile] = argv;
  if (!["apply-config", "message"].includes(mode ?? "") || !lib || !reportFile || (mode === "message" && !command)) {
    process.stderr.write(
      "usage: run-report.mjs apply-config <library> <report.json>\n       run-report.mjs message <library> <report.json> --command <c> [--args <a>] [--tool-version <v>] [--run <url>] [--out <file>]\n",
    );
    return 2;
  }
  const library = path.resolve(lib);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const configFile = path.join(library, CONFIG);
  if (mode === "apply-config") {
    const { config, lines } = applyConfig(JSON.parse(fs.readFileSync(configFile, "utf8")), report.config);
    if (lines.length) fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    for (const l of lines) console.log(l);
    return 0;
  }
  const text = message({ command, args, report, toolVersion, run, configLines: committedConfigLines(library, report) });
  if (out) fs.writeFileSync(out, text);
  process.stdout.write(text);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
