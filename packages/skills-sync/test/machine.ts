// The pretend machine the machine-command tests run the built CLI on: a temp home with the harness folders a test
// asks for, the fake claude and codex CLIs on PATH (fixtures/fake-harness), the fake GitHub named through
// SKILLS_SYNC_GITHUB_API, and nothing of the session's own (no CLAUDE_CODE_REMOTE, no real harness folders). The
// helpers lay down what a machine may have before a run: account plugins, tool-installed plugins, loose links, real
// skill folders, an old ~/.skills-sync link, a hook entry, a global block. Tests assert only what a user sees: files
// and links, the fake CLIs' calls, the fake GitHub's requests, printed output, --json, exit codes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLink, lexists, linkTarget, makeLink } from "../src/fs.js";
import { fixtureRelease, type FakeGithub } from "./fixtures/fake-github/fake-github.mjs";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const FAKE_HARNESS = path.resolve(import.meta.dirname, "fixtures", "fake-harness", "fake-harness.mjs");

export type HarnessId = "claude-code" | "codex" | "hermes";
export type CliName = "claude" | "codex";

export interface PretendMachine {
  base: string;
  home: string;
  claudeHome: string;
  codexHome: string;
  hermesHome: string;
  /** the fake CLIs' folder, the only PATH entry a run sees */
  bin: string;
  /** FAKE_HARNESS_LOG: one JSON array per CLI call */
  log: string;
  github: FakeGithub | null;
  /** the environment every run gets; a test may add to it */
  env: Record<string, string>;
}

export interface MachineOptions {
  /** which harness config folders exist (default: Claude Code and Codex) */
  harnesses?: HarnessId[];
  /** which fake CLIs are on PATH (default: both) */
  clis?: CliName[];
  /** the fake GitHub the run talks to; null for a machine with no GitHub reachable */
  github?: FakeGithub | null;
  env?: Record<string, string>;
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed, when it is JSON; otherwise null */
  json: Record<string, unknown> | null;
  /** the fake CLIs' calls, each as [host, ...args] */
  calls: string[][];
  /** the fake GitHub's requests during this run */
  requests: FakeGithub["requests"];
}

export function write(file: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

export function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`;
}

export function pretendMachine(options: MachineOptions = {}): PretendMachine {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "skills-sync-machine-"));
  const home = path.join(base, "home");
  const claudeHome = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(home, { recursive: true });
  const harnesses = options.harnesses ?? ["claude-code", "codex"];
  if (harnesses.includes("claude-code")) fs.mkdirSync(claudeHome, { recursive: true });
  if (harnesses.includes("codex")) fs.mkdirSync(codexHome, { recursive: true });
  if (harnesses.includes("hermes")) fs.mkdirSync(hermesHome, { recursive: true });
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  for (const h of options.clis ?? ["claude", "codex"]) {
    if (process.platform === "win32")
      write(path.join(bin, `${h}.cmd`), `@"${process.execPath}" "${FAKE_HARNESS}" ${h} %*\r\n`);
    else {
      write(path.join(bin, h), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HARNESS}" ${h} "$@"\n`);
      fs.chmodSync(path.join(bin, h), 0o755);
    }
  }
  const github = options.github ?? null;
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    FAKE_HARNESS_LOG: path.join(base, "calls.log"),
    // a machine with no GitHub reachable points at a port nothing listens on
    SKILLS_SYNC_GITHUB_API: github?.url ?? "http://127.0.0.1:9",
    ...options.env,
  };
  return { base, home, claudeHome, codexHome, hermesHome, bin, log: env.FAKE_HARNESS_LOG, github, env };
}

export function destroy(m: PretendMachine): void {
  fs.rmSync(m.base, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Run the built CLI on the pretend machine. PATH holds only the fake CLIs, so the session's real ones are never seen.
 * The child runs asynchronously: the fake GitHub lives in this process, and a blocking spawn would never let it answer.
 */
export async function cli(
  m: PretendMachine,
  args: string[],
  extra: Record<string, string> = {},
  cwd: string = m.home,
): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  for (const k of ["CLAUDE_CODE_REMOTE", "SKILLS_REPO", "GITHUB_TOKEN", "GH_TOKEN", "NODE_USE_ENV_PROXY"])
    delete env[k];
  // only the fake CLIs; on Windows the .cmd shims still run, because the shell comes from ComSpec, not PATH
  env[pathKey] = m.bin;
  Object.assign(env, m.env, extra);
  if (fs.existsSync(m.log)) fs.rmSync(m.log);
  const before = m.github?.requests.length ?? 0;
  const r = await spawnCli(args, env, cwd);
  const calls = fs.existsSync(m.log)
    ? fs
        .readFileSync(m.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];
  let json: Run["json"] = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text output, or a failure the assertion on status explains */
  }
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    json,
    calls,
    requests: m.github ? m.github.requests.slice(before) : [],
  };
}

/**
 * The built CLI as a child process, awaited: a test that stands a server in its own process (the fake GitHub) must
 * not block its event loop while the CLI talks to it.
 */
export function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/**
 * Every entry under `dir`, relative: links as `name -> target`, folders as `name/`, files as `name <size> <sha256>`,
 * so a test can say "nothing changed", content included. `names()` strips a snapshot back to its paths.
 */
export function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const rel = path.relative(dir, full).replace(/\\/g, "/");
      // a junction on Windows is a directory to readdir; isLink knows better
      if (isLink(full)) out.push(`${rel} -> ${linkTarget(full) ?? "?"}`);
      else if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        const bytes = fs.readFileSync(full);
        out.push(`${rel} ${bytes.length} ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
      }
    }
  };
  walk(dir);
  return out;
}

/** The paths of a snapshot's entries, without link targets, sizes or hashes. */
export function names(entries: string[]): string[] {
  return entries.map((e) => e.replace(/ -> .*$/, "").replace(/ \d+ [0-9a-f]{16}$/, ""));
}

function userSkills(m: PretendMachine, harness: HarnessId): string {
  if (harness === "claude-code") return path.join(m.claudeHome, "skills");
  if (harness === "codex") return path.join(m.home, ".agents", "skills");
  return path.join(m.hermesHome, "skills");
}

function configDir(m: PretendMachine, harness: "claude-code" | "codex"): string {
  return harness === "claude-code" ? m.claudeHome : m.codexHome;
}

/** Codex's deprecated user skills folder, still read by Codex. */
export function codexLegacySkills(m: PretendMachine): string {
  return path.join(m.codexHome, "skills");
}

export interface PluginFiles {
  version?: string | null;
  skills?: string[];
  /** the exact bytes of a fixture release's plugin, laid down as they are */
  files?: Map<string, Buffer>;
}

/** The plugin's files on disk: a fixture release's bytes as they are, or the same shapes built for `version` and `skills`. */
function writePlugin(dir: string, id: string, p: PluginFiles): void {
  const files =
    p.files ??
    fixtureRelease({
      number: 0,
      commit: "0".repeat(40),
      plugins: { [id]: { version: p.version ?? null, skills: p.skills ?? [] } },
    }).plugins[id].files;
  for (const [rel, bytes] of files) write(path.join(dir, ...rel.split("/")), bytes);
}

/**
 * An account plugin as claude.ai delivers it: <claudeHome>/plugins/synced/<org>_<bucket>/<id>/ beside the bucket's
 * manifest.json and <id>.meta.json. `marketplace` is the claude.ai marketplace label (Justin's library is "skills";
 * Anthropic's directory is "anthropic-plugin-directory"). `enabled: false` is a plugin switched off at claude.ai, which
 * the fake claude then lists as disabled. Returns the plugin folder.
 */
export function syncedPlugin(
  m: PretendMachine,
  id: string,
  p: PluginFiles & { marketplace?: string; folder?: string; enabled?: boolean } = {},
): string {
  const bucket = path.join(m.claudeHome, "plugins", "synced", "org-1111_bucket-2222");
  const dir = path.join(bucket, p.folder ?? id);
  writePlugin(dir, id, p);
  const stateFile = path.join(m.claudeHome, "fake-harness.json");
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : { marketplaces: {}, plugins: {} };
  state.synced ??= {};
  if (p.enabled === false) state.synced[`${p.folder ?? id}@synced`] = { enabled: false };
  else delete state.synced[`${p.folder ?? id}@synced`];
  write(stateFile, JSON.stringify(state, null, 2));
  fs.mkdirSync(path.join(dir, ".in_use"), { recursive: true });
  const marketplace = p.marketplace ?? "skills";
  write(
    path.join(bucket, `${p.folder ?? id}.meta.json`),
    JSON.stringify({
      server_plugin_id: `plugin_${id}`,
      marketplace_name: marketplace,
      installation_preference: "available",
    }),
  );
  const manifestFile = path.join(bucket, "manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : { lastUpdated: 1791681239182, plugins: [] };
  manifest.plugins = manifest.plugins.filter((x: { name: string }) => x.name !== (p.folder ?? id));
  manifest.plugins.push({
    pluginId: `plugin_${id}`,
    name: p.folder ?? id,
    description: `${id} plugin`,
    version: "0002",
    updatedAt: "2026-10-10T01:32:21.164589Z",
    marketplaceName: marketplace,
    installationPreference: "available",
  });
  write(manifestFile, JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * A plugin installed through the harness's own CLI, as the fake CLI's state records it: the plugin's folder (its
 * skills, its manifests) under the machine, registered as <id>@<marketplace> (default: the library's catalog name).
 * Returns the plugin folder.
 */
export function installedPlugin(
  m: PretendMachine,
  harness: "claude-code" | "codex",
  id: string,
  p: PluginFiles & { marketplace?: string; enabled?: boolean } = {},
): string {
  const marketplace = p.marketplace ?? "oneezy-skills";
  const root = path.join(m.base, "marketplaces", harness, marketplace);
  const dir = path.join(root, "plugins", id);
  writePlugin(dir, id, p);
  const file = path.join(configDir(m, harness), "fake-harness.json");
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: {}, plugins: {} };
  state.marketplaces[marketplace] = root;
  const skills = fs.existsSync(path.join(dir, "skills"))
    ? fs.readdirSync(path.join(dir, "skills")).filter((n) => fs.existsSync(path.join(dir, "skills", n, "SKILL.md")))
    : [];
  state.plugins[`${id}@${marketplace}`] = { version: p.version ?? "unknown", enabled: p.enabled ?? true, dir, skills };
  write(file, JSON.stringify(state, null, 2));
  return dir;
}

/**
 * A loose link in the harness's user skills folder (or in `dir`), pointing at `target`; without one, at a skill
 * folder of that name in a pretend old library clone under the machine. Returns the link.
 */
export function looseLink(
  m: PretendMachine,
  harness: HarnessId,
  name: string,
  target?: string,
  dir = userSkills(m, harness),
): string {
  const to = target ?? path.join(m.base, "old-library", ".agents", "skills", name);
  if (!fs.existsSync(to)) write(path.join(to, "SKILL.md"), skillMd(name));
  const link = path.join(dir, name);
  makeLink(to, link);
  return link;
}

/** A real skill folder (a SKILL.md inside) in the harness's user skills folder, or in `dir`. Returns the folder. */
export function skillFolder(m: PretendMachine, harness: HarnessId, name: string, dir = userSkills(m, harness)): string {
  const folder = path.join(dir, name);
  write(path.join(folder, "SKILL.md"), skillMd(name));
  return folder;
}

/**
 * The pretend old library clone under the machine (where `looseLink` points by default), marked as a checkout of
 * `repo`: a skills-sync.json naming library.owner and library.name, as the real library's does. A link into it is then
 * a link to a library copy, which the tool made and may remove (ADR-0007). Nothing makes ~/.skills-sync point at it, so
 * the old library-based run does not find it. Returns the clone's root.
 */
export function libraryCopy(m: PretendMachine, repo = "oneezy/skills"): string {
  const root = path.join(m.base, "old-library");
  const [owner, name] = repo.split("/");
  write(
    path.join(root, "skills-sync.json"),
    JSON.stringify({ version: 1, library: { name, owner, homepage: `https://github.com/${repo}` } }, null, 2) + "\n",
  );
  return root;
}

/**
 * The old ~/.skills-sync link to a library clone (default: a pretend clone under the machine, with the `brain`
 * instruction entrypoint the real library had, so the old run would write that block). Returns the link.
 */
export function oldLibraryLink(m: PretendMachine, target?: string): string {
  const to = target ?? path.join(m.base, "old-library");
  if (!fs.existsSync(to)) {
    write(path.join(to, "skills", "oneezy", "oneezy-status", "SKILL.md"), skillMd("oneezy-status"));
    write(path.join(to, "skills", "oneezy", "oneezy-brain", "SKILL.md"), skillMd("oneezy-brain"));
    write(path.join(to, "brain-routing.md"), "## Brain\nLoad /oneezy-brain.\n");
    write(
      path.join(to, "skills-sync.entrypoints.json"),
      JSON.stringify({
        version: 1,
        blocks: { brain: { source: "brain-routing.md", skill: "oneezy-brain", agents: ["claude-code", "codex"] } },
      }) + "\n",
    );
    write(path.join(to, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }) + "\n");
  }
  const link = path.join(m.home, ".skills-sync");
  makeLink(to, link);
  return link;
}

/**
 * A session hook entry as a user wrote it: Claude Code's ~/.claude/settings.json (hooks.SessionStart), Codex's
 * ~/.codex/hooks.json. Other entries in the file are kept. Returns the file.
 */
export function hookEntry(m: PretendMachine, harness: "claude-code" | "codex", command: string): string {
  const file = path.join(configDir(m, harness), harness === "claude-code" ? "settings.json" : "hooks.json");
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command }] });
  write(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

/** The harness's global instructions file: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md. */
export function globalFile(m: PretendMachine, harness: "claude-code" | "codex"): string {
  return path.join(configDir(m, harness), harness === "claude-code" ? "CLAUDE.md" : "AGENTS.md");
}

/**
 * A managed block appended to `file` between the markers skills-sync writes (`<!-- skills-sync:<id>:start -->` ...
 * `<!-- skills-sync:<id>:end -->`; the old tool's id was `brain`); text already in the file stays above it. Returns the file.
 */
export function blockIn(file: string, id: string, body: string): string {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  write(
    file,
    `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}<!-- skills-sync:${id}:start -->\n${body}\n<!-- skills-sync:${id}:end -->\n`,
  );
  return file;
}

/** A managed block in the harness's global instructions file. Returns the file. */
export function globalBlock(m: PretendMachine, harness: "claude-code" | "codex", id: string, body: string): string {
  return blockIn(globalFile(m, harness), id, body);
}

/**
 * The old tool's per-machine answers, ~/.skills-sync/skills-sync.local.json (the link made by `oldLibraryLink` when it
 * is not there yet): `dev` and `projects` are where it wrote repository instruction blocks. Returns the file.
 */
export function oldLocalFile(m: PretendMachine, local: Record<string, unknown>): string {
  const link = path.join(m.home, ".skills-sync");
  if (!lexists(link)) oldLibraryLink(m);
  const file = path.join(linkTarget(link) ?? link, "skills-sync.local.json");
  write(
    file,
    JSON.stringify({ agents: ["claude-code", "codex"], global: true, mode: "link", wsl: [], ...local }, null, 2) + "\n",
  );
  return file;
}
