#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const header =
  /^(?:(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)\s+)?([a-z]+)(?:\([^\r\n()]+\))?(!)?: ([^\r\n]+)$/u;
const breakingFooter = /^BREAKING[ -]CHANGE: \S/m;
const priorities = { none: 0, patch: 1, minor: 2, major: 3 };

export function commitBump(message, { requireEmoji = false } = {}) {
  if (typeof message !== "string") throw new TypeError("A commit message must be a string");
  const title = message.split(/\r?\n/, 1).at(0);
  const match = header.exec(title);
  if (!match || (requireEmoji && !/^\p{Extended_Pictographic}/u.test(title))) {
    throw new Error(`Invalid conventional commit title: ${title}`);
  }
  if (match.at(2) || breakingFooter.test(message)) return "major";
  if (match.at(1) === "feat") return "minor";
  if (match.at(1) === "fix") return "patch";
  return "none";
}

export function releaseVersion(current, messages, options = {}) {
  const match = typeof current === "string" && stableVersion.exec(current);
  if (!match) throw new Error("The current version must be plain MAJOR.MINOR.PATCH");
  if (!Array.isArray(messages)) throw new TypeError("Commit messages must be an array");
  let bump = "none";
  for (const message of messages) {
    const next = commitBump(message, options);
    if (priorities[next] > priorities[bump]) bump = next;
  }
  const [major, minor, patch] = match.slice(1).map(BigInt);
  const version =
    bump === "major"
      ? `${major + 1n}.0.0`
      : bump === "minor"
        ? `${major}.${minor + 1n}.0`
        : bump === "patch"
          ? `${major}.${minor}.${patch + 1n}`
          : current;
  return { version, bump };
}

if (import.meta.url === pathToFileURL(process.argv.at(1) ?? "").href) {
  try {
    const args = process.argv.slice(2);
    const requireEmoji = args.includes("--require-emoji");
    const values = args.filter((value) => value !== "--require-emoji");
    const [version, ...messages] = values;
    process.stdout.write(`${JSON.stringify(releaseVersion(version, messages, { requireEmoji }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
