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
  /** project-level skills folder, relative to a repo root */
  projectSkills: string;
  /** the harness reads .agents/skills itself, so no project link layer is needed */
  universal: boolean;
  note?: string;
}

export function harnessTable(home = os.homedir(), env = process.env): Harness[] {
  const codexHome = env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const hermesHome = env.HERMES_HOME?.trim() || path.join(home, ".hermes");
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      configDir: claudeHome,
      userSkills: path.join(claudeHome, "skills"),
      projectSkills: path.join(".claude", "skills"),
      universal: false,
    },
    {
      id: "codex",
      name: "Codex",
      configDir: codexHome,
      // Codex reads ~/.agents/skills; ~/.codex/skills is its deprecated location
      userSkills: path.join(home, ".agents", "skills"),
      projectSkills: path.join(".agents", "skills"),
      universal: true,
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
      id: "hermes",
      name: "Hermes",
      configDir: hermesHome,
      userSkills: path.join(hermesHome, "skills"),
      projectSkills: path.join(".hermes", "skills"),
      universal: false,
    },
  ];
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
