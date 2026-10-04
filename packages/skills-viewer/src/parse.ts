import YAML from "yaml";
import type { Mode } from "./types.js";
import { basename, dirname, join, type FileSet } from "./vfs.js";

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

export interface MarkdownDoc {
  frontmatter: Record<string, unknown>;
  body: string[];
  bodyStart: number;
}

/** Split YAML frontmatter from a markdown body, keeping file line numbers. */
export function parseMarkdown(raw: string): MarkdownDoc {
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
  return { frontmatter, body: bodyText.split(/\r?\n/), bodyStart };
}

export function parseSkillFile(fs: FileSet, file: string): ParsedSkill {
  const raw = fs.read(file) ?? "";
  const dir = dirname(file);
  const folder = basename(dir);
  const { frontmatter, body, bodyStart } = parseMarkdown(raw);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : folder;
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  return {
    id: folder,
    name,
    description,
    dir,
    file,
    frontmatter,
    body,
    bodyStart,
    codex: readCodexPolicy(fs, dir),
    scripts: listFiles(fs, join(dir, "scripts")),
    references: listFiles(fs, join(dir, "references")),
  };
}

/** Codex keeps invocation policy in agents/openai.yaml next to SKILL.md. */
function readCodexPolicy(fs: FileSet, dir: string): { allowImplicitInvocation: boolean } {
  const text = fs.read(join(dir, "agents", "openai.yaml"));
  if (text === undefined) return { allowImplicitInvocation: true };
  try {
    const y = YAML.parse(text) as Record<string, unknown> | null;
    const policy = (y?.policy as Record<string, unknown> | undefined) ?? y ?? {};
    return { allowImplicitInvocation: policy.allow_implicit_invocation !== false };
  } catch {
    return { allowImplicitInvocation: true };
  }
}

/** Direct children of `dir`. */
function listFiles(fs: FileSet, dir: string): string[] {
  return fs.paths
    .filter((p) => dirname(p) === dir)
    .map(basename)
    .sort();
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
