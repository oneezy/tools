// The few pieces of Codex's config.toml that development setup reads and writes, by text, as hooks.ts reads it: which
// plugin switches a file sets ([plugins."<name>@<marketplace>"] enabled = ...), which projects the user trusted, and
// the two marked blocks skills-sync owns in a project's .codex/config.toml: `pnpm skills:dev`'s (develop.ts) and develop
// setup's (develop-codex.ts). Anything this cannot read is reported, never rewritten.

/** `pnpm skills:dev`'s block in a workspace's .codex/config.toml (develop.ts). */
export const SKILLS_DEV_START = "# skills-sync:development:start";
export const SKILLS_DEV_END = "# skills-sync:development:end";
/** develop setup's block in a Development project's .codex/config.toml (develop-codex.ts). */
export const PLUGINS_START = "# skills-sync:development-plugins:start";
export const PLUGINS_END = "# skills-sync:development-plugins:end";

/** The block between `start` and `end`, markers included; null when there is none. Throws on unpaired markers. */
export function blockIn(text: string, start: string, end: string): string | null {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 !== e < 0 || (s >= 0 && e < s)) throw new Error(`incomplete ${start} markers`);
  if (s >= 0 && (text.indexOf(start, s + 1) >= 0 || text.indexOf(end, e + 1) >= 0))
    throw new Error(`duplicate ${start} markers`);
  return s < 0 ? null : text.slice(s, e + end.length);
}

/** The text without that block (and the line break after it). */
export function withoutBlock(text: string, start: string, end: string): string {
  const block = blockIn(text, start, end);
  if (block === null) return text;
  const s = text.indexOf(block);
  return text.slice(0, s) + text.slice(s + block.length).replace(/^\r?\n/, "");
}

/** The text with `block` in place of the old one (or appended, on a line of its own); without it for null. */
export function withBlock(text: string, start: string, end: string, block: string | null): string {
  const rest = withoutBlock(text, start, end);
  if (block === null) return rest;
  const head = rest && !rest.endsWith("\n") ? `${rest}\n` : rest;
  return `${head}${block}\n`;
}

// a TOML key: a basic or literal string, or a bare key
const KEY = String.raw`(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))`;
const keyText = (m: RegExpExecArray, at: number) =>
  m[at] !== undefined ? JSON.parse(`"${m[at]}"`) : (m[at + 1] ?? m[at + 2]);

/**
 * The plugin switches a config.toml text sets, by plugin id (`<name>@<marketplace>`): true or false for a plain
 * `enabled = <bool>`, null when the id is set in a form this does not read (an inline table, another key). `*` stands
 * for a plugins setting this cannot pin to one id (`plugins = {...}`, `[[plugins]]`).
 */
export function pluginSwitches(toml: string): Map<string, boolean | null> {
  const out = new Map<string, boolean | null>();
  const set = (id: string, v: boolean | null) => {
    if (!out.has(id) || v !== null) out.set(id, v);
  };
  const header = new RegExp(String.raw`^\s*\[\s*plugins\s*\.\s*${KEY}\s*(\.[^\]]*)?\]`);
  const enabled = /^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/;
  // under [plugins]: "<id>".enabled = ... or "<id>" = { ... }; at the top: the same behind plugins.
  const keyed = (prefix: string) =>
    new RegExp(String.raw`^\s*${prefix}${KEY}\s*(?:\.\s*enabled\s*=\s*(true|false)|[.=])`);
  let table: string | null = "";
  let id: string | null = null;
  let sub = false;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    let m = header.exec(line);
    if (m) {
      id = keyText(m, 1);
      sub = !!m[4];
      set(id!, null);
      table = null;
      continue;
    }
    if (/^\s*\[\[\s*plugins\b/.test(line)) {
      set("*", null);
      table = id = null;
      continue;
    }
    const any = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
    if (any) {
      table = any[1].replace(/\s/g, "");
      id = null;
      continue;
    }
    if (id !== null) {
      if (!sub && (m = enabled.exec(line))) set(id, m[1] === "true");
      continue;
    }
    if (table === "" && /^\s*plugins\s*=/.test(line)) set("*", null);
    const form = table === "plugins" ? keyed("") : table === "" ? keyed(String.raw`plugins\s*\.\s*`) : null;
    if (form && (m = form.exec(line))) set(keyText(m, 1), m[4] !== undefined ? m[4] === "true" : null);
  }
  return out;
}

/** The project folders a user config.toml trusts ([projects."<path>"] trust_level = "trusted"). */
export function trustedProjects(toml: string): string[] {
  const out: string[] = [];
  const header = new RegExp(String.raw`^\s*\[\s*projects\s*\.\s*${KEY}\s*\]`);
  let project: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const m = header.exec(line);
    if (m) project = keyText(m, 1);
    else if (/^\s*\[/.test(line)) project = null;
    else if (project !== null && /^\s*trust_level\s*=\s*"trusted"/.test(line)) out.push(project);
  }
  return out;
}

/**
 * The text with [plugins."<id>"]'s `enabled = true` set to false in place, everything else (comments, order) as it
 * was, as `codex plugin add` itself rewrites the value; the table appended when there is none. Null when the id is
 * set in another form (an inline table, a dotted key), which is left for a person.
 */
export function disabledIn(toml: string, id: string): string | null {
  const lines = toml.split("\n");
  const header = new RegExp(String.raw`^\s*\[\s*plugins\s*\.\s*${KEY}\s*\]\s*(?:#.*)?\r?$`);
  const at = lines.findIndex((l) => {
    const m = header.exec(l);
    return !!m && keyText(m, 1) === id;
  });
  const switches = pluginSwitches(toml);
  if (at < 0) {
    if (switches.has(id) || switches.has("*")) return null;
    const head = toml && !toml.endsWith("\n") ? `${toml}\n` : toml;
    return `${head}${head.trim() ? "\n" : ""}[plugins.${JSON.stringify(id)}]\nenabled = false\n`;
  }
  let end = lines.findIndex((l, i) => i > at && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const e = lines.findIndex((l, i) => i > at && i < end && /^\s*enabled\s*=/.test(l));
  if (e < 0) lines.splice(at + 1, 0, "enabled = false");
  else if (/^\s*enabled\s*=\s*(true|false)\b/.test(lines[e]))
    lines[e] = lines[e].replace(/^(\s*enabled\s*=\s*)(true|false)/, "$1false");
  else return null;
  return lines.join("\n");
}
