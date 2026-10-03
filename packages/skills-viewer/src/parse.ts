import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Mode } from "./types.js";

export interface ParsedSkill {
  id: string;
  name: string;
  description: string;
  dir: string;
  file: string;
  frontmatter: Record<string, unknown>;
  /** body lines; body[i] is line number bodyStart + i in the file */
  body: string[];
  bodyStart: number;
  codex: { allowImplicitInvocation: boolean };
  scripts: string[];
  references: string[];
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillFile(file: string): ParsedSkill {
  const raw = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  const folder = path.basename(dir);
  let frontmatter: Record<string, unknown> = {};
  let bodyText = raw;
  let bodyStart = 1;
  const m = raw.match(FM_RE);
  if (m) {
    try {
      const parsed = YAML.parse(m[1]);
      if (parsed && typeof parsed === "object") frontmatter = parsed as Record<string, unknown>;
    } catch {
      frontmatter = { _error: "frontmatter did not parse as YAML" };
    }
    bodyText = raw.slice(m[0].length);
    bodyStart = m[0].split("\n").length;
  }
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : folder;
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  return {
    id: folder,
    name,
    description,
    dir,
    file,
    frontmatter,
    body: bodyText.split(/\r?\n/),
    bodyStart,
    codex: readCodexPolicy(dir),
    scripts: listFiles(path.join(dir, "scripts")),
    references: listFiles(path.join(dir, "references")),
  };
}

/** Codex keeps invocation policy in agents/openai.yaml next to SKILL.md. */
function readCodexPolicy(dir: string): { allowImplicitInvocation: boolean } {
  const f = path.join(dir, "agents", "openai.yaml");
  if (!fs.existsSync(f)) return { allowImplicitInvocation: true };
  try {
    const y = YAML.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown> | null;
    const policy = (y?.policy as Record<string, unknown> | undefined) ?? y ?? {};
    return { allowImplicitInvocation: policy.allow_implicit_invocation !== false };
  } catch {
    return { allowImplicitInvocation: true };
  }
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function claudeMode(fm: Record<string, unknown>): Mode {
  if (fm["user-invocable"] === false) return "background";
  if (fm["disable-model-invocation"] === true) return "manual";
  return "auto";
}

export function unionMode(claude: Mode, codex: "auto" | "manual"): Mode {
  if (claude === "background") return "background";
  if (claude === "manual" || codex === "manual") return "manual";
  return "auto";
}

export function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[\s,]+/).filter(Boolean);
  return undefined;
}
