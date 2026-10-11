// Windows only: the machine sync runs itself inside every WSL distro (ADR-0010: a distro is a machine of its own, with
// its own harness folders, block and hook), through the published package, so each distro installs what its own read
// of the release says. The distros are a machine fact read on every run (`wsl.exe -l -q`), never remembered. A distro
// without Node has no npx: that is one note in the report, not a failure. SKILLS_SYNC_WSL_EXE names the executable (a
// test's fake; a Node script runs on this process's node), SKILLS_SYNC_WSL_BIN the command that runs inside the distro.
import { spawnSync } from "node:child_process";
import { VERSION } from "./version.js";

export interface WslRun {
  distro: string;
  ok: boolean;
  /** the distro has no npx (no Node) on its PATH: nothing could run there */
  noNode: boolean;
  /** stdout then stderr, trimmed */
  output: string;
}

/** The wsl executable to use; null where there is none (not Windows, and no fake named). */
export function wslExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const named = env.SKILLS_SYNC_WSL_EXE?.trim();
  if (named) return named;
  return process.platform === "win32" ? "wsl.exe" : null;
}

function spawnWsl(exe: string, args: string[], encoding: "utf8" | "utf16le") {
  // a test's fake is a Node script: it runs on this process's node, so no shell and no PATH lookup is involved
  return /\.(mjs|cjs|js)$/i.test(exe)
    ? spawnSync(process.execPath, [exe, ...args], { encoding, windowsHide: true, timeout: 600_000 })
    : spawnSync(exe, args, { encoding, windowsHide: true, timeout: 600_000 });
}

/** The installed distros, docker-desktop's excluded; none where wsl is not available or lists nothing. */
export function wslDistros(env: NodeJS.ProcessEnv = process.env): string[] {
  const exe = wslExe(env);
  if (!exe) return [];
  const r = spawnWsl(exe, ["-l", "-q"], "utf16le");
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, "").trim())
    .filter((s) => s && !s.startsWith("docker-desktop"));
}

/** Run the machine sync inside a distro with the flags given (--plan, --json, --quiet). */
export function runInWsl(distro: string, flags: string[], env: NodeJS.ProcessEnv = process.env): WslRun {
  const exe = wslExe(env) ?? "wsl.exe";
  const bin = env.SKILLS_SYNC_WSL_BIN?.trim() || `npx --yes @oneezy/skills-sync@${VERSION}`;
  const command = [bin, "sync", ...flags].join(" ");
  // -i: node is often only on PATH through the interactive profile (nvm, vite-plus); -l for login vars
  const r = spawnWsl(exe, ["-d", distro, "--", "bash", "-lic", command], "utf8");
  const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  const noNode = r.status === 127 || /\b(npx|node|npm): (command )?not found/.test(output);
  return { distro, ok: r.status === 0, noNode, output };
}
