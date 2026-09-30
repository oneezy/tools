// Session hooks that run skills-sync when an agent starts, at user scope (this machine) and
// project scope (a repo, so cloud sandboxes and teammates get the same). Same JSON shape for both harnesses.
import fs from "node:fs";
import path from "node:path";
import type { Report } from "./plan.js";

export const HOOK_COMMAND = "npx --yes @oneezy/skills-sync --quiet";
const HOOK_MARK = "@oneezy/skills-sync";

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
interface HooksFile {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

function readJson(file: string): HooksFile {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as HooksFile;
  } catch {
    return {};
  }
}

function hasOurHook(doc: HooksFile): boolean {
  return (doc.hooks?.SessionStart ?? []).some((g) => g.hooks?.some((h) => h.command?.includes(HOOK_MARK)));
}

/** Add our SessionStart hook to a Claude Code settings file or a Codex hooks.json, keeping everything else. */
export function ensureHookFile(report: Report, file: string, kind: "claude" | "codex", statusMessage = "Syncing skills…"): void {
  const doc = readJson(file);
  if (hasOurHook(doc)) {
    report.add({ kind: "skip", path: file, note: "hook present" });
    return;
  }
  const handler: HookHandler = { type: "command", command: HOOK_COMMAND, timeout: 120 };
  if (kind === "claude") handler.statusMessage = statusMessage;
  const group: HookGroup = kind === "codex" ? { matcher: "startup|resume", hooks: [handler] } : { hooks: [handler] };
  doc.hooks = doc.hooks ?? {};
  doc.hooks.SessionStart = [...(doc.hooks.SessionStart ?? []), group];
  report.add({ kind: "write", path: file, payload: JSON.stringify(doc, null, 2) + "\n", note: `${kind === "claude" ? "Claude Code" : "Codex"} SessionStart hook` });
}

/** This machine: ~/.claude/settings.json and ~/.codex/hooks.json for the harnesses that are installed. */
export function ensureUserHooks(report: Report, home: string, installed: { claude: boolean; codex: boolean }): void {
  if (installed.claude) ensureHookFile(report, path.join(home, ".claude", "settings.json"), "claude");
  if (installed.codex) ensureHookFile(report, path.join(home, ".codex", "hooks.json"), "codex");
}

/** A project: committed .claude/settings.json and .codex/hooks.json, plus ignore entries for the generated skill folders. */
export function ensureProjectHooks(report: Report, repo: string): void {
  ensureHookFile(report, path.join(repo, ".claude", "settings.json"), "claude");
  ensureHookFile(report, path.join(repo, ".codex", "hooks.json"), "codex");
  const gi = path.join(repo, ".gitignore");
  const wanted = [".claude/skills/", ".agents/skills/"];
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((w) => !lines.has(w) && !lines.has(w.replace(/\/$/, "")) && !lines.has("/" + w));
  if (!missing.length) report.add({ kind: "skip", path: gi, note: "ignores present" });
  else report.add({ kind: "write", path: gi, payload: existing.replace(/\n?$/, existing ? "\n" : "") + "# skills are linked by skills-sync, never committed\n" + missing.join("\n") + "\n", note: `${missing.length} ignore entr${missing.length === 1 ? "y" : "ies"}` });
}
