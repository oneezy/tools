// The report of one `branches` run, for .github/workflows/branches.yml: reads the --json report the command wrote and
// prints the text a user would have read (the same lines as the command's text mode, then its summary line), one
// ::error annotation per problem, and, with GITHUB_STEP_SUMMARY set, appends a table (one row per repository) with
// every line under it. Nothing here reaches GitHub or reads a token; it reads the one file named as its argument.
//
// Usage: node branches-report.mjs <report.json>. Environment, optional, named in the heading: TOOL_VERSION (what npm
// installed), TOKEN_USER (the login the token check printed). A file that is not a JSON report (the command exited
// before writing one: exit 2 on bad usage, a crash) is printed as it is and the heading says so. The command's exit
// code is the workflow's to carry; this script exits 0 whenever it could read the file, 2 without an argument.
import { appendFileSync, readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node branches-report.mjs <report.json>");
  process.exit(2);
}
const raw = readFileSync(file, "utf8");
const tool = process.env.TOOL_VERSION ? `@oneezy/skills-sync ${process.env.TOOL_VERSION}` : "";
const user = process.env.TOKEN_USER ? `token user \`${process.env.TOKEN_USER}\`` : "";
const meta = [tool, user].filter(Boolean).join(", ");

/** Append to the step summary when there is one; a local run prints to the terminal only. */
const summary = (...lines) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
};

let report;
try {
  report = JSON.parse(raw);
  if (!report || !Array.isArray(report.repos)) throw new Error("not a branches report");
} catch {
  process.stdout.write(raw);
  console.log("::error title=branches::the command wrote no JSON report; its own message is in the run log above");
  const why = `No JSON report: the command exited before writing one; its message is in the run log.`;
  summary("## branches", "", `${why}${meta ? ` (${meta})` : ""}`, "");
  process.exit(0);
}

const count = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
const sum = (key) => report.repos.reduce((n, r) => n + r[key].length, 0);
const [del, tag] = report.plan ? ["to delete", "to tag"] : ["deleted", "tagged"];
const tally = (r) =>
  `${r.deleted.length} ${del}, ${r.archived.length} ${tag}, ${r.left.length} left alone, ${r.kept.length} kept` +
  (r.problems.length ? `, ${count(r.problems.length, "problem")}` : "");
const total = {
  deleted: sum("deleted"),
  archived: sum("archived"),
  left: sum("left"),
  kept: sum("kept"),
  problems: sum("problems"),
};
const summaryLine =
  `${report.plan ? "plan" : "branches"}: ${total.deleted} ${del}, ${total.archived} ${tag}, ` +
  `${total.left} left alone, ${total.kept} kept${total.problems ? `, ${count(total.problems, "problem")}` : ""}`;

// 1. The run log: what the command's text mode prints, so the log reads the same by hand and from the workflow.
const text = [];
for (const r of report.repos) if (r.lines.length) text.push(r.repo, ...r.lines.map((l) => `${l.mark} ${l.text}`));
text.push(summaryLine);
process.stdout.write(text.join("\n") + "\n");
for (const r of report.repos) for (const p of r.problems) console.log(`::error title=branches ${r.repo}::${p}`);

// 2. The step summary: the heading, one table row per repository, then every repository's lines, folded.
const cell = (s) => String(s).replaceAll("|", "\\|");
const rows = report.repos.map(
  (r) =>
    `| \`${cell(r.repo)}\` | ${r.deleted.length} | ${r.archived.length} | ${r.left.length} | ${r.kept.length} | ` +
    `${r.problems.length} | ${r.skipped ? `skipped: ${cell(r.skipped)}` : ""} |`,
);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
summary(
  `## ${report.plan ? "branches --plan" : "branches"}`,
  "",
  `**${summaryLine}**${meta ? ` (${meta})` : ""}`,
  "",
  `| Repository | ${cap(del)} | ${cap(tag)} | Left alone | Kept | Problems | Note |`,
  "|---|---:|---:|---:|---:|---:|---|",
  ...rows,
  "",
  ...report.repos.flatMap((r) => [
    `<details><summary><code>${r.repo}</code>: ${tally(r)}</summary>`,
    "",
    "```text",
    ...r.lines.map((l) => `${l.mark} ${l.text}`),
    "```",
    "",
    "</details>",
    "",
  ]),
);
