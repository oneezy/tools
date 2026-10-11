// The pretend machine the machine-command tests run the built CLI on: a temp home with the harness folders a test
// asks for, the fake claude and codex CLIs on PATH (fixtures/fake-harness), the fake GitHub named through
// SKILLS_SYNC_GITHUB_API, and nothing of the session's own (no CLAUDE_CODE_REMOTE, no real harness folders). The
// helpers lay down what a machine may have before a run: account plugins, tool-installed plugins, loose links, real
// skill folders, an old ~/.skills-sync link and its answers file, a hook entry, a Codex trust record, a global block,
// and git checkouts of the tended repositories with a bare origin each. The fake wsl.exe (fixtures/fake-wsl) stands in
// for the real one on every pretend machine, so a sync never reaches the WSL distros of the machine running the tests;
// a test names the distros it should list. Tests assert only what a user sees: files and links, the fake CLIs' calls,
// the fake wsl's calls, the fake GitHub's requests, printed output, --json, exit codes, the checkouts' heads.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { blockSource, withBlock } from "../src/block.js";
import { HERMES_PATH, renderHermes } from "../src/build.js";
import { isLink, lexists, linkTarget, makeLink, samePath } from "../src/fs.js";
import type { HermesActivation } from "../src/hermes.js";
import { HOOK_COMMAND } from "../src/hooks.js";
import { fixtureRelease, type FakeGithub, type FixtureRelease } from "./fixtures/fake-github/fake-github.mjs";

const CLI = path.resolve(import.meta.dirname, "..", "dist", "src", "cli.js");
const FAKE_HARNESS = path.resolve(import.meta.dirname, "fixtures", "fake-harness", "fake-harness.mjs");
const FAKE_WSL = path.resolve(import.meta.dirname, "fixtures", "fake-wsl", "fake-wsl.mjs");

export type HarnessId = "claude-code" | "codex" | "hermes";
export type CliName = "claude" | "codex" | "hermes";

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
  /** FAKE_WSL_LOG: one JSON array [distro, command] per run inside a distro */
  wslLog: string;
  github: FakeGithub | null;
  /** the environment every run gets; a test may add to it */
  env: Record<string, string>;
  /** folders on PATH after the fake CLIs: the real git's (and what it needs beside it), when the machine was asked for it */
  extraPath: string[];
}

export interface MachineOptions {
  /** which harness config folders exist (default: Claude Code and Codex) */
  harnesses?: HarnessId[];
  /** which fake CLIs are on PATH (default: claude and codex) */
  clis?: CliName[];
  /** the fake GitHub the run talks to; null for a machine with no GitHub reachable */
  github?: FakeGithub | null;
  /** the WSL distros the fake wsl.exe lists (default: none, as on a Windows machine without WSL, or any other OS) */
  wsl?: string[];
  env?: Record<string, string>;
  /** the real git on PATH too (its folder after the fake CLIs), for a command that runs git on checkouts */
  git?: boolean;
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed, when it is JSON; otherwise null */
  json: Record<string, unknown> | null;
  /** the fake CLIs' calls, each as [host, ...args] */
  calls: string[][];
  /** the runs inside WSL distros, each as [distro, command] */
  wsl: string[][];
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
    // the pretend GitHub checkouts the fake hermes clones from: <owner>/<repo>/<commit>/<subdir> (see hermesSource);
    // apart from the fake codex's FAKE_HARNESS_GITHUB, whose checkouts are <owner>/<repo> at one revision
    FAKE_HERMES_GITHUB: path.join(base, "github-hermes"),
    // a machine with no GitHub reachable points at a port nothing listens on
    SKILLS_SYNC_GITHUB_API: github?.url ?? "http://127.0.0.1:9",
    // the fake wsl.exe always: the real one, on a Windows host, would run the sync inside the host's own distros
    SKILLS_SYNC_WSL_EXE: FAKE_WSL,
    FAKE_WSL_DISTROS: (options.wsl ?? []).join(","),
    FAKE_WSL_LOG: path.join(base, "wsl.log"),
    ...options.env,
  };
  return {
    base,
    home,
    claudeHome,
    codexHome,
    hermesHome,
    bin,
    log: env.FAKE_HARNESS_LOG,
    wslLog: env.FAKE_WSL_LOG,
    github,
    env,
    extraPath: options.git ? gitFolders() : [],
  };
}

/**
 * The folders the session's git needs on an otherwise bare PATH. On Linux, the one git is in. On Windows, Git for
 * Windows is three folders under one root, and the session's PATH may put any of them first (Git Bash puts mingw64\bin
 * and usr\bin ahead of cmd): cmd, the launcher; mingw64\bin, git itself; usr\bin, the sh that git runs to serve a
 * fetch from a local path. All three go on the run's PATH, cmd first, with System32 after them as on every Windows
 * PATH.
 */
function gitFolders(): string[] {
  const names = process.platform === "win32" ? ["git.exe", "git.cmd"] : ["git"];
  const found = (process.env.PATH ?? "")
    .split(path.delimiter)
    .find((dir) => dir && names.some((n) => fs.existsSync(path.join(dir, n))));
  if (!found) throw new Error("git is not on PATH");
  if (process.platform !== "win32") return [found];
  const folders: string[] = [];
  for (const root of [path.dirname(found), path.dirname(path.dirname(found))])
    if (!folders.length && fs.existsSync(path.join(root, "cmd", "git.exe")))
      for (const sub of [["cmd"], ["mingw64", "bin"], ["usr", "bin"]]) {
        const dir = path.join(root, ...sub);
        if (fs.existsSync(dir)) folders.push(dir);
      }
  if (!folders.some((f) => samePath(f, found))) folders.push(found);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.windir;
  if (systemRoot) folders.push(path.join(systemRoot, "System32"), systemRoot);
  return folders;
}

export function destroy(m: PretendMachine): void {
  fs.rmSync(m.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  for (const k of [
    "CLAUDE_CODE_REMOTE",
    "SKILLS_REPO",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NODE_USE_ENV_PROXY",
    "SKILLS_SYNC_WSL_BIN",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
  ])
    delete env[k];
  // only the fake CLIs (and git when asked); on Windows the .cmd shims still run, because the shell comes from ComSpec
  env[pathKey] = [m.bin, ...m.extraPath].join(path.delimiter);
  Object.assign(env, m.env, extra);
  for (const log of [m.log, m.wslLog]) if (fs.existsSync(log)) fs.rmSync(log);
  const before = m.github?.requests.length ?? 0;
  const r = await spawnCli(args, env, cwd);
  const lines = (log: string): string[][] =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  const calls = lines(m.log);
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
    wsl: lines(m.wslLog),
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
 * a link to a library copy, which the tool made and may remove (ADR-0007). Nothing makes ~/.skills-sync point at it; no
 * command looks for a library on the machine any more (ADR-0012). Returns the clone's root.
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
 * instruction entrypoint the real library had): a leftover every machine command names in one note and never reads.
 * Returns the link.
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

/** The harness's user hooks file: Claude Code's ~/.claude/settings.json, Codex's ~/.codex/hooks.json. */
export function hooksFile(m: PretendMachine, harness: "claude-code" | "codex"): string {
  return path.join(configDir(m, harness), harness === "claude-code" ? "settings.json" : "hooks.json");
}

/**
 * A session hook entry as a user (or an older setup) wrote it, in the shape both harnesses read: one SessionStart
 * group `{ matcher, hooks: [{ type: "command", command, timeout }] }` appended to Claude Code's settings.json or Codex's
 * hooks.json, the file written as the harnesses write theirs (two spaces, a trailing newline). `group` replaces the
 * default group when a test needs another shape. Other entries in the file are kept. Returns the file.
 */
export function hookEntry(
  m: PretendMachine,
  harness: "claude-code" | "codex",
  command: string,
  group?: Record<string, unknown>,
): string {
  const file = hooksFile(m, harness);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionStart.push(
    group ?? { matcher: "startup|resume", hooks: [{ type: "command", command, timeout: 30 }] },
  );
  write(file, JSON.stringify(settings, null, 2) + "\n");
  return file;
}

/**
 * Codex's record of a trusted user hook, as its TUI writes it into ~/.codex/config.toml:
 * `[hooks.state."<hooks.json>:session_start:<group>:<handler>"]` with a `trusted_hash`. The path is a TOML basic
 * string, so a Windows path has its backslashes doubled. Appended to the file. Returns the file.
 */
export function codexTrust(m: PretendMachine, group: number, handler = 0): string {
  const file = path.join(m.codexHome, "config.toml");
  const key = `${hooksFile(m, "codex").replace(/\\/g, "\\\\")}:session_start:${group}:${handler}`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  write(
    file,
    `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}[hooks.state."${key}"]\ntrusted_hash = "sha256:${"ab".repeat(32)}"\n`,
  );
  return file;
}

/** git for the pretend machine's repositories, isolated from the session's own config; throws on failure. */
export function git(m: PretendMachine, cwd: string, args: string[]): string {
  const config = path.join(m.base, "gitconfig");
  if (!fs.existsSync(config)) fs.writeFileSync(config, "");
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input: "",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: config,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr || r.error?.message}`);
  return r.stdout.trim();
}

/** Where the pretend GitHub keeps its bare repositories: <base>/github/<owner>/<name>.git. */
function githubRoot(m: PretendMachine): string {
  return path.join(m.base, "github");
}

/**
 * A pretend GitHub repository on disk: a bare origin for owner/name under <base>/github/, HEAD on dev, one commit on
 * dev and main. Made once per machine. Returns the bare repository.
 */
export function bareOrigin(m: PretendMachine, repo: string): string {
  const dir = path.join(githubRoot(m), ...repo.split("/")) + ".git";
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  git(m, dir, ["init", "--quiet", "--bare"]);
  git(m, dir, ["symbolic-ref", "HEAD", "refs/heads/dev"]);
  const work = fs.mkdtempSync(path.join(scratch(m), "init-"));
  git(m, work, ["init", "--quiet"]);
  git(m, work, ["symbolic-ref", "HEAD", "refs/heads/dev"]);
  write(path.join(work, "README.md"), `# ${repo}\n`);
  git(m, work, ["add", "."]);
  git(m, work, ["commit", "--quiet", "-m", "first"]);
  git(m, work, ["remote", "add", "origin", dir]);
  git(m, work, ["push", "--quiet", "origin", "dev", "dev:main"]);
  return dir;
}

function scratch(m: PretendMachine): string {
  const dir = path.join(m.base, "scratch");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A checkout of that repository at <base>/dev/<name> (or `dir`), on dev at origin's head. Its origin URL is the real
 * GitHub one; a url.insteadOf rewrite in its own config sends every fetch to the bare repository instead. Returns the
 * checkout.
 */
export function checkoutOf(m: PretendMachine, repo: string, dir?: string): string {
  const origin = bareOrigin(m, repo);
  const to = dir ?? path.join(m.base, "dev", repo.split("/")[1]);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  git(m, m.base, ["clone", "--quiet", origin, to]);
  git(m, to, ["remote", "set-url", "origin", `https://github.com/${repo}.git`]);
  git(m, to, ["config", `url.${githubRoot(m).replace(/\\/g, "/")}/.insteadOf`, "https://github.com/"]);
  return to;
}

/** One more commit on origin's dev, through a scratch clone, so a checkout behind it can fast-forward. Returns its sha. */
export function advanceOrigin(m: PretendMachine, repo: string, file = "CHANGES.md"): string {
  const work = fs.mkdtempSync(path.join(scratch(m), "advance-"));
  git(m, m.base, ["clone", "--quiet", "--branch", "dev", bareOrigin(m, repo), work]);
  fs.appendFileSync(path.join(work, file), `${new Date().toISOString()} ${Math.random()}\n`);
  git(m, work, ["add", "."]);
  git(m, work, ["commit", "--quiet", "-m", `change ${file}`]);
  git(m, work, ["push", "--quiet", "origin", "dev"]);
  return git(m, work, ["rev-parse", "HEAD"]);
}

/**
 * A branch on origin named `name`, from dev's head with `commits` commits of its own (0: dev's head itself), made
 * through a scratch clone. Returns the branch's sha.
 */
export function originBranch(m: PretendMachine, repo: string, name: string, commits = 1): string {
  const work = fs.mkdtempSync(path.join(scratch(m), "branch-"));
  git(m, m.base, ["clone", "--quiet", "--branch", "dev", bareOrigin(m, repo), work]);
  git(m, work, ["checkout", "--quiet", "-b", name]);
  for (let i = 0; i < commits; i++) {
    fs.appendFileSync(path.join(work, `${name.replace(/\//g, "-")}.md`), `${i} ${Math.random()}\n`);
    git(m, work, ["add", "."]);
    git(m, work, ["commit", "--quiet", "-m", `${name} ${i + 1}`]);
  }
  git(m, work, ["push", "--quiet", "origin", name]);
  return git(m, work, ["rev-parse", "HEAD"]);
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

/**
 * The pretend GitHub the fake codex clones a marketplace from: <base>/github/<owner>/<repo> is a checkout of the
 * library at `release`, with the Codex catalog (named `marketplace`), every plugin's files, the config that names it
 * as the library (so a link into it is a library copy) and `.git-revision` = the release's commit, so a newer release
 * laid down here is a moved remote for `codex plugin marketplace upgrade`. Returns the checkout.
 */
export function githubClone(
  m: PretendMachine,
  release: FixtureRelease,
  repo = "oneezy/skills",
  marketplace = "oneezy-skills",
): string {
  const [owner, name] = repo.split("/");
  const github = path.join(m.base, "github");
  const dir = path.join(github, owner, name);
  fs.rmSync(dir, { recursive: true, force: true });
  const plugins = Object.keys(release.plugins)
    .sort()
    .map((id) => ({
      name: id,
      source: `./plugins/${id}`,
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    }));
  write(
    path.join(dir, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: marketplace, interface: { displayName: repo }, plugins }, null, 2) + "\n",
  );
  for (const [id, p] of Object.entries(release.plugins))
    for (const [rel, bytes] of p.files) write(path.join(dir, "plugins", id, ...rel.split("/")), bytes);
  write(path.join(dir, "skills-sync.json"), JSON.stringify({ version: 1, library: { owner, name } }, null, 2) + "\n");
  write(path.join(dir, ".git-revision"), `${release.commit}\n`);
  m.env.FAKE_HARNESS_GITHUB = github;
  return dir;
}

/**
 * A checkout of the library somewhere on the machine (default: <base>/checkout), as far as the tool tells one: the
 * config naming `repo` as the library. A link into it is a library copy. Returns the folder.
 */
export function libraryCheckout(
  m: PretendMachine,
  dir = path.join(m.base, "checkout"),
  repo = "oneezy/skills",
): string {
  const [owner, name] = repo.split("/");
  write(path.join(dir, "skills-sync.json"), JSON.stringify({ version: 1, library: { owner, name } }, null, 2) + "\n");
  return dir;
}

/**
 * A real folder in the harness's user skills folder (or `dir`) holding exactly the release's own files of the skill:
 * the copy an older sync or Codex's skill installer left. Returns the folder.
 */
export function releaseCopy(
  m: PretendMachine,
  harness: HarnessId,
  name: string,
  release: FixtureRelease,
  dir = userSkills(m, harness),
): string {
  const prefix = `skills/${name}/`;
  const plugin = Object.values(release.plugins).find((p) => p.files.has(`${prefix}SKILL.md`));
  if (!plugin) throw new Error(`${name}: no plugin of ${release.tag} carries it`);
  const folder = path.join(dir, name);
  for (const [rel, bytes] of plugin.files)
    if (rel.startsWith(prefix)) write(path.join(folder, ...rel.slice(prefix.length).split("/")), bytes);
  return folder;
}

/** One of Codex's own bundled skills, ~/.codex/skills/.system/<name>: Codex's, never the tool's. Returns the folder. */
export function systemSkill(m: PretendMachine, name: string): string {
  const folder = path.join(codexLegacySkills(m), ".system", name);
  write(path.join(folder, "SKILL.md"), skillMd(name));
  return folder;
}

/**
 * A fake CLI run directly on the pretend machine, as a user would at a prompt (`codex plugin list --json` after a
 * sync): its exit code, output and the JSON it printed. Not logged as one of the tool's calls.
 */
export function fakeCli(
  m: PretendMachine,
  host: CliName,
  args: string[],
): { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null } {
  const r = spawnSync(process.execPath, [FAKE_HARNESS, host, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...m.env, FAKE_HARNESS_LOG: "" },
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    /* text, or a failure the caller reads from status */
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** Switch a plugin the fake codex has installed on or off, as the user would through Codex. */
export function codexPluginEnabled(m: PretendMachine, id: string, enabled: boolean): void {
  const file = path.join(m.codexHome, "fake-harness.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state.plugins[id]) throw new Error(`${id}: not installed on the fake codex`);
  state.plugins[id].enabled = enabled;
  write(file, JSON.stringify(state, null, 2));
}

/**
 * The skills block as sync writes it, in the harness's global instructions file (appended to what is there): the state
 * status calls current. The text is `shared` of `release`; by default the fixture library's latest release, which has
 * no SHARED.md, so the tool's built-in text. Returns the file.
 */
export function currentBlock(
  m: PretendMachine,
  harness: "claude-code" | "codex",
  release = "release-17",
  shared: string | null = null,
): string {
  const file = globalFile(m, harness);
  write(file, withBlock(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", blockSource(release, shared)));
  return file;
}

/**
 * The tool's own session hook entry in the harness's user hooks file, as sync writes it (appended). Returns the index
 * of its SessionStart group, which is what Codex's trust record names.
 */
export function ownHook(m: PretendMachine, harness: "claude-code" | "codex"): number {
  const file = hookEntry(m, harness, HOOK_COMMAND);
  const groups = JSON.parse(fs.readFileSync(file, "utf8")).hooks.SessionStart as Array<{
    hooks: Array<{ command: string }>;
  }>;
  return groups.findIndex((g) => g.hooks.some((h) => h.command === HOOK_COMMAND));
}

/**
 * A harness whose machine-side setup is done: the current block, the own hook entry and, on Codex, the trust record for
 * it. What status paints green when the plugins are right too.
 */
export function doneHarness(m: PretendMachine, harness: "claude-code" | "codex"): void {
  currentBlock(m, harness);
  const group = ownHook(m, harness);
  if (harness === "codex") codexTrust(m, group);
}

/**
 * The release's Hermes renderings as GitHub would serve them to `hermes plugins install owner/repo/dist/hermes/<id>
 * --ref <commit>`: <base>/github-hermes/<owner>/<repo>/<commit>/<rendering>/<id>/ for every plugin of the release, built
 * from the fixture's package files exactly as build does (renderHermes). `rendering` is the library folder the release's
 * config names (renderings.hermes), dist/hermes by default. Returns the checkout folder.
 */
export function hermesSource(
  m: PretendMachine,
  release: FixtureRelease,
  repo = "oneezy/skills",
  rendering = HERMES_PATH,
): string {
  const checkout = path.join(m.env.FAKE_HERMES_GITHUB, ...repo.split("/"), release.commit);
  // the fake GitHub's contents API answers for the same commit: the tool asks it whether the rendering is there at all
  const contents = m.github ? ((m.github.fixture.contents ??= {})[release.commit] ??= {}) : null;
  for (const [id, p] of Object.entries(release.plugins))
    for (const [rel, bytes] of renderHermes(p.files)) {
      write(path.join(checkout, ...rendering.split("/"), id, ...rel.split("/")), bytes);
      if (contents) contents[`${rendering}/${id}/${rel}`] = bytes.toString("utf8");
    }
  return checkout;
}

/** Hermes's config.yaml on the pretend machine. */
export function hermesConfig(m: PretendMachine): string {
  return path.join(m.hermesHome, "config.yaml");
}

/**
 * A plugin installed in Hermes as `hermes plugins install` leaves it: <hermesHome>/plugins/<id>/ holding the Hermes
 * rendering of the plugin's files, its row in plugins/.install-metadata.json (default: the library's dist/hermes/<id>
 * at `revision`, pinned) and its place in config.yaml's lists (`activation`, default enabled). `recorded: false` lays
 * the folder down without a row, as a copy by hand would. Returns the plugin folder.
 */
export function hermesPlugin(
  m: PretendMachine,
  id: string,
  p: PluginFiles & {
    source?: string;
    revision?: string;
    pinned?: boolean;
    activation?: HermesActivation;
    recorded?: boolean;
  } = {},
): string {
  const dir = path.join(m.hermesHome, "plugins", id);
  const files =
    p.files ??
    fixtureRelease({
      number: 0,
      commit: "0".repeat(40),
      plugins: { [id]: { version: p.version ?? null, skills: p.skills ?? [] } },
    }).plugins[id].files;
  for (const [rel, bytes] of renderHermes(files)) write(path.join(dir, ...rel.split("/")), bytes);
  const metaFile = path.join(m.hermesHome, "plugins", ".install-metadata.json");
  const meta: Record<string, unknown> = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
  if (p.recorded === false) delete meta[id];
  else
    meta[id] = {
      pinned: p.pinned ?? true,
      revision: p.revision ?? "1717171717171717171717171717171717171717",
      source: p.source ?? `https://github.com/oneezy/skills.git#${HERMES_PATH}/${id}`,
    };
  write(metaFile, JSON.stringify(meta, null, 2) + "\n");
  const activation = p.activation ?? "enabled";
  const configFile = hermesConfig(m);
  const config = (fs.existsSync(configFile) ? YAML.parse(fs.readFileSync(configFile, "utf8")) : {}) ?? {};
  config.plugins ??= {};
  const enabled = new Set<string>(config.plugins.enabled ?? []);
  const disabled = new Set<string>(config.plugins.disabled ?? []);
  enabled.delete(id);
  disabled.delete(id);
  if (activation === "enabled") enabled.add(id);
  if (activation === "disabled") disabled.add(id);
  config.plugins.enabled = [...enabled].sort();
  config.plugins.disabled = [...disabled].sort();
  write(configFile, YAML.stringify(config));
  return dir;
}
