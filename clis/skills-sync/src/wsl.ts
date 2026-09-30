// Windows only: list WSL distros and run the same sync inside each one.
import { spawnSync } from "node:child_process";

export function wslDistros(): string[] {
  if (process.platform !== "win32") return [];
  const r = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, "").trim())
    .filter((s) => s && !s.startsWith("docker-desktop"));
}

/** V:\dev\skills -> /mnt/v/dev/skills */
export function toWslPath(win: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(win);
  if (!m) return win.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export interface WslRun {
  distro: string;
  ok: boolean;
  output: string;
}

/**
 * Run skills-sync inside a distro against the same library through /mnt. Only the user folders
 * are synced there (projects live on the Windows side). Needs Node in the distro.
 */
export function runInWsl(distro: string, libraryRoot: string, extraArgs: string[], plan: boolean): WslRun {
  const lib = toWslPath(libraryRoot);
  const bin = process.env.SKILLS_SYNC_WSL_BIN?.trim() || "npx --yes @oneezy/skills-sync";
  const args = [bin, "--repo", `'${lib}'`, "--global", "--no-projects", "--no-wsl", "--no-layers", "--no-restore", "-y", ...(plan ? ["--plan"] : []), ...extraArgs].join(" ");
  // -i: node is often only on PATH through the interactive profile (nvm, vite-plus); -l for login vars
  const r = spawnSync("wsl.exe", ["-d", distro, "--", "bash", "-lic", args], { encoding: "utf8" });
  return { distro, ok: r.status === 0, output: ((r.stdout ?? "") + (r.stderr ?? "")).trim() };
}
