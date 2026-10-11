// The table of harnesses: where each one keeps user-level and project-level skills.
// Adding a harness is one row. Paths follow each harness's own docs, not another tool's guess.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Harness {
  id: string;
  name: string;
  /** exists => the harness is installed for this user */
  configDir: string;
  /** user-level skills folder read by the harness */
  userSkills: string;
  /** older user-level skills folders the harness still reads (Codex's ~/.codex/skills); probed, never linked into */
  legacyUserSkills?: string[];
  /** project-level skills folder, relative to a repo root */
  projectSkills: string;
  /** the harness reads .agents/skills itself, so no project link layer is needed */
  universal: boolean;
  userInstructions?: string[];
  projectInstructions?: string[];
  /** the harness's user-level hooks file, where the session hook lives (ADR-0010); unset for a harness without hooks */
  userHooks?: string;
  note?: string;
}

export function harnessTable(home = os.homedir(), env = process.env, platform = process.platform): Harness[] {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const hermesHome = hermesHomeDir(home, env, platform);
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      configDir: claudeHome,
      userSkills: path.join(claudeHome, "skills"),
      projectSkills: path.join(".claude", "skills"),
      universal: false,
      userInstructions: ["CLAUDE.md"],
      projectInstructions: ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"],
      userHooks: path.join(claudeHome, "settings.json"),
    },
    {
      id: "codex",
      name: "Codex",
      configDir: codexHome,
      // Codex reads ~/.agents/skills; ~/.codex/skills is its deprecated location, still read
      userSkills: path.join(home, ".agents", "skills"),
      legacyUserSkills: [path.join(codexHome, "skills")],
      projectSkills: path.join(".agents", "skills"),
      universal: true,
      userInstructions: ["AGENTS.md", "AGENTS.override.md"],
      projectInstructions: ["AGENTS.md", "AGENTS.override.md"],
      userHooks: path.join(codexHome, "hooks.json"),
    },
    {
      id: "goose",
      name: "Goose",
      configDir: path.join(configHome, "goose"),
      userSkills: path.join(configHome, "goose", "skills"),
      projectSkills: path.join(".goose", "skills"),
      universal: false,
    },
    {
      // Hermes reads skills/ and plugins/ under its home; it has no global instructions file this tool knows of, so no
      // userInstructions and no block (docs/research/hermes-plugin-format.md in oneezy/skills)
      id: "hermes",
      name: "Hermes",
      configDir: hermesHome,
      userSkills: path.join(hermesHome, "skills"),
      projectSkills: path.join(".hermes", "skills"),
      universal: false,
    },
  ];
}

/**
 * Hermes's home, as Hermes itself resolves it (hermes_constants.py): HERMES_HOME when set, else the platform default:
 * %LOCALAPPDATA%\hermes on Windows (~/AppData/Local/hermes when LOCALAPPDATA is unset), ~/.hermes elsewhere, with
 * HERMES_DATA_DIR_SUFFIX appended to the default's folder name. A named profile (hermes -p <id>) is <home>/profiles/<id>,
 * a complete home of its own; this tool serves the default profile, which is the home itself.
 */
export function hermesHomeDir(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const set = env.HERMES_HOME?.trim();
  if (set) return set;
  const suffix = env.HERMES_DATA_DIR_SUFFIX ?? "";
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    return path.join(local || path.join(home, "AppData", "Local"), `hermes${suffix}`);
  }
  return path.join(home, `.hermes${suffix}`);
}

export function detected(table: Harness[]): Harness[] {
  return table.filter((h) => {
    try {
      return fs.statSync(h.configDir).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Names a harness must never see as a skill folder. */
export const RESERVED = new Set(["synced", ".system"]);
