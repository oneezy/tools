// The browser-safe core: a FileSet in, a Graph out. No node: imports here or below.

import { detect, type Doc } from "./edges.js";
import { asStringArray, claudeMode, parseMarkdown, parseSkillFile, unionMode, type ParsedSkill } from "./parse.js";
import type {
  Edge,
  Evidence,
  Graph,
  LinkType,
  Marketplace,
  Mode,
  PartKind,
  PartNode,
  PluginNode,
  SkillNode,
  Source,
} from "./types.js";
import { basename, dirname, join, normalize, relativeTo, type FileSet } from "./vfs.js";

export const VERSION = "0.2.0";

const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "worktrees"]);
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|py|js|mjs|cjs|ts|mts|cts|rb|pl|cmd|bat)$/i;
const TEXT_EXT = /\.(md|mdx|markdown|txt|rst)$/i;

export interface AnalyzeOptions {
  source?: Source;
  /** shown in meta.roots; defaults to the source's roots or repo */
  roots?: string[];
}

interface Plugin {
  dir: string;
  manifests: Array<{ file: string; json: Record<string, unknown> }>;
  /** name from a marketplace entry, used when no manifest names the plugin */
  listedName?: string;
  listedDescription?: string;
  node?: PluginNode;
}

interface PartDoc {
  part: PartNode;
  doc?: Doc;
}

export function analyze(fs: FileSet, opts: AnalyzeOptions = {}): Graph {
  const warnings: string[] = [];
  const paths = fs.paths.filter((p) => !p.split("/").some((seg) => SKIP.has(seg)));
  const has = new Set(paths);
  const read = (p: string): string | undefined => (has.has(p) ? fs.read(p) : undefined);
  const readJson = (p: string): Record<string, unknown> | undefined => {
    const text = read(p);
    if (text === undefined) return undefined;
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
    } catch {
      warnings.push(`${p}: not valid JSON`);
      return undefined;
    }
  };

  /* ---------- plugins and marketplaces ---------- */

  const plugins = new Map<string, Plugin>();
  const pluginAt = (dir: string): Plugin => {
    let p = plugins.get(dir);
    if (!p) plugins.set(dir, (p = { dir, manifests: [] }));
    return p;
  };
  for (const p of paths) {
    if (basename(p) !== "plugin.json") continue;
    const d = dirname(p);
    let root: string | null = null;
    if (basename(d) === ".claude-plugin" || basename(d) === ".codex-plugin") root = dirname(d);
    // the neutral agent-plugins manifest sits in the plugin root, next to a harness manifest
    else if (has.has(join(d, ".claude-plugin", "plugin.json")) || has.has(join(d, ".codex-plugin", "plugin.json")))
      root = d;
    if (root === null) continue;
    const plugin = pluginAt(root);
    const json = readJson(p);
    plugin.manifests.push({ file: p, json: json ?? {} });
  }

  const marketplaces: Marketplace[] = [];
  for (const p of paths) {
    if (basename(p) !== "marketplace.json") continue;
    const d = dirname(p);
    let base: string | null = null;
    if (basename(d) === ".claude-plugin") base = dirname(d);
    else if (basename(d) === "plugins" && basename(dirname(d)) === ".agents") base = dirname(dirname(d));
    if (base === null) continue;
    const json = readJson(p);
    if (!json) continue;
    const meta = (json.metadata as Record<string, unknown> | undefined) ?? {};
    const pluginRoot = typeof meta.pluginRoot === "string" ? meta.pluginRoot : "";
    const listed = Array.isArray(json.plugins) ? (json.plugins as Array<Record<string, unknown>>) : [];
    const market: Marketplace = {
      name: str(json.name) || basename(base) || "marketplace",
      description: str(json.description) || str(meta.description),
      file: p,
      plugins: [],
    };
    for (const entry of listed) {
      const name = str(entry.name);
      const src = entry.source;
      const item: Marketplace["plugins"][number] = {
        name,
        description: str(entry.description),
        source: typeof src === "string" ? src : sourceLabel(src),
      };
      if (typeof src === "string") {
        const dir = /^\.{1,2}\//.test(src) || !pluginRoot ? join(base, src) : join(base, pluginRoot, src);
        if (paths.some((x) => x.startsWith(dir === "" ? "" : dir + "/"))) {
          const plugin = pluginAt(normalize(dir));
          plugin.listedName ??= name;
          plugin.listedDescription ??= item.description;
          item.pluginId = normalize(dir); // replaced by the plugin id below
        }
      }
      market.plugins.push(item);
    }
    marketplaces.push(market);
  }

  // name every plugin; ownership below checks the deepest plugin folder first, so nested plugins win
  const pluginList = [...plugins.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  const usedPluginIds = new Set<string>();
  for (const pl of pluginList) {
    const field = (k: string) => pl.manifests.map((m) => m.json[k]).find((v) => v !== undefined);
    const name = str(field("name")) || pl.listedName || basename(pl.dir) || repoName(opts.source) || "plugin";
    const id = unique(`plugin:${name}`, usedPluginIds);
    pl.node = {
      id,
      name,
      description: str(field("description")) || pl.listedDescription || "",
      dir: pl.dir,
      manifests: pl.manifests.map((m) => m.file),
      skills: [],
      parts: [],
    };
    const version = str(field("version"));
    if (version) pl.node.version = version;
  }
  for (const m of marketplaces)
    for (const item of m.plugins) if (item.pluginId !== undefined) item.pluginId = plugins.get(item.pluginId)?.node?.id;
  const byDepth = [...pluginList].sort((a, b) => b.dir.length - a.dir.length);
  const ownerPlugin = (p: string): Plugin | undefined => byDepth.find((pl) => relativeTo(pl.dir, p) !== null);

  /* ---------- skills, deduped by id ---------- */

  const skillFiles = paths.filter((p) => basename(p) === "SKILL.md");
  const parsedAll = skillFiles.map((f) => parseSkillFile({ paths, read }, f));
  const groups = new Map<string, ParsedSkill[]>();
  for (const s of parsedAll) groups.set(s.id, [...(groups.get(s.id) ?? []), s]);
  const canonical: Array<{ skill: ParsedSkill; copies: ParsedSkill[] }> = [];
  for (const group of groups.values()) {
    // the authored copy (outside any plugin) wins over a built plugin copy, then the shortest path
    const ranked = [...group].sort(
      (a, b) =>
        Number(!!ownerPlugin(a.dir)) - Number(!!ownerPlugin(b.dir)) ||
        a.file.length - b.file.length ||
        a.file.localeCompare(b.file),
    );
    canonical.push({ skill: ranked[0], copies: ranked.slice(1) });
  }
  canonical.sort((a, b) => a.skill.id.localeCompare(b.skill.id));
  const skillDirs = canonical.map((c) => c.skill.dir);
  const allSkillDirs = parsedAll.map((s) => s.dir);

  /* ---------- parts ---------- */

  const parts: PartDoc[] = [];
  const usedPartIds = new Set<string>();
  const addPart = (
    kind: PartKind,
    scope: string,
    name: string,
    fields: Omit<PartNode, "id" | "kind" | "name">,
    doc?: Omit<Doc, "id">,
  ): PartNode => {
    const part: PartNode = { id: unique(`${kind}:${scope}/${name}`, usedPartIds), kind, name, ...fields };
    parts.push({ part, doc: doc ? { ...doc, id: part.id, part: true } : undefined });
    return part;
  };
  const inSkill = (p: string) => allSkillDirs.some((d) => relativeTo(d, p) !== null);

  const markdownParts = (
    kind: "command" | "agent",
    files: string[],
    scope: string,
    plugin: PluginNode | undefined,
    base: string,
  ) => {
    for (const f of files) {
      const raw = read(f) ?? "";
      const md = parseMarkdown(raw);
      const fm = md.frontmatter;
      const stem = basename(f).replace(/\.md$/i, "");
      const name = kind === "agent" ? str(fm.name) || stem : stem;
      const ns = dirname(relativeTo(base, f) ?? "");
      const details: Record<string, unknown> = { ...fm };
      if (ns) details.namespace = ns.split("/").join(":");
      const description = str(fm.description) || firstLine(md.body);
      addPart(
        kind,
        scope,
        name,
        { description, ...(plugin ? { plugin: plugin.id } : {}), file: f, details },
        { name, body: md.body, bodyStart: md.bodyStart },
      );
    }
  };
  const mdUnder = (dirOrFile: string) =>
    has.has(dirOrFile) ? [dirOrFile] : paths.filter((p) => relativeTo(dirOrFile, p) && /\.md$/i.test(p) && !inSkill(p));

  const hookParts = (file: string, json: unknown, scope: string, plugin: PluginNode | undefined) => {
    const root = (json as Record<string, unknown> | undefined)?.hooks ?? json;
    if (!root || typeof root !== "object") return [] as PartNode[];
    const text = read(file) ?? "";
    const out: PartNode[] = [];
    for (const [event, entries] of Object.entries(root as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries as Array<Record<string, unknown>>) {
        const matcher = str(entry?.matcher);
        const hooks = Array.isArray(entry?.hooks) ? (entry.hooks as Array<Record<string, unknown>>) : [];
        for (const h of hooks) {
          const command = str(h.command);
          const prompt = str(h.prompt);
          const details: Record<string, unknown> = { event, type: str(h.type) || "command" };
          if (matcher) details.matcher = matcher;
          if (command) details.command = command;
          if (prompt) details.prompt = prompt;
          if (typeof h.timeout === "number") details.timeout = h.timeout;
          details.line = lineIn(text, command || prompt || event);
          const name = matcher ? `${event} (${matcher})` : event;
          out.push(
            addPart("hook", scope, name, {
              description: clip(command || prompt),
              ...(plugin ? { plugin: plugin.id } : {}),
              file,
              details,
            }),
          );
        }
      }
    }
    return out;
  };

  const mcpParts = (file: string, json: unknown, scope: string, plugin: PluginNode | undefined) => {
    const obj = json as Record<string, unknown> | undefined;
    const servers = (obj?.mcpServers as Record<string, unknown> | undefined) ?? obj;
    if (!servers || typeof servers !== "object") return [] as PartNode[];
    const text = read(file) ?? "";
    const out: PartNode[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const cfg = raw as Record<string, unknown>;
      const url = str(cfg.url);
      const transport = str(cfg.type) || (url ? "http" : "stdio");
      const details: Record<string, unknown> = { transport };
      if (str(cfg.command)) details.command = str(cfg.command);
      if (Array.isArray(cfg.args)) details.args = cfg.args.map(String);
      if (url) details.url = url;
      // keys only: values are often secrets
      if (cfg.env && typeof cfg.env === "object") details.envKeys = Object.keys(cfg.env);
      if (cfg.headers && typeof cfg.headers === "object") details.headerKeys = Object.keys(cfg.headers);
      details.line = lineIn(text, `"${name}"`);
      const description = url || [details.command, ...((details.args as string[]) ?? [])].filter(Boolean).join(" ");
      out.push(
        addPart("mcp", scope, name, {
          description: clip(description),
          ...(plugin ? { plugin: plugin.id } : {}),
          file,
          details,
        }),
      );
    }
    return out;
  };

  const runners: Array<{ part: PartNode; text: string }> = [];
  const pluginScripts = new Map<string, PartNode[]>();

  for (const pl of pluginList) {
    const node = pl.node!;
    const scope = node.name;
    const field = (k: string) =>
      pl.manifests.map((m) => ({ file: m.file, v: m.json[k] })).find((x) => x.v !== undefined);
    const extraPaths = (k: string) =>
      (asStringArray(field(k)?.v) ?? []).filter((x) => typeof x === "string").map((x) => join(pl.dir, x));
    const own = (p: string) => ownerPlugin(p) === pl;

    const commandDirs = [join(pl.dir, "commands"), ...extraPaths("commands")];
    markdownParts("command", unique2(commandDirs.flatMap(mdUnder)).filter(own), scope, node, join(pl.dir, "commands"));
    const agentDirs = [join(pl.dir, "agents"), ...extraPaths("agents")];
    markdownParts("agent", unique2(agentDirs.flatMap(mdUnder)).filter(own), scope, node, join(pl.dir, "agents"));

    const hooks = field("hooks");
    const hookFiles = [
      join(pl.dir, "hooks", "hooks.json"),
      ...(typeof hooks?.v === "string" || Array.isArray(hooks?.v) ? extraPaths("hooks") : []),
    ];
    for (const f of unique2(hookFiles))
      if (has.has(f))
        for (const h of hookParts(f, readJson(f), scope, node)) runners.push({ part: h, text: str(h.details.command) });
    if (hooks && typeof hooks.v === "object" && !Array.isArray(hooks.v))
      for (const h of hookParts(hooks.file, hooks.v, scope, node))
        runners.push({ part: h, text: str(h.details.command) });

    const mcp = field("mcpServers");
    const mcpFiles = [
      join(pl.dir, ".mcp.json"),
      ...(typeof mcp?.v === "string" || Array.isArray(mcp?.v) ? extraPaths("mcpServers") : []),
    ];
    for (const f of unique2(mcpFiles))
      if (has.has(f))
        for (const m of mcpParts(f, readJson(f), scope, node)) runners.push({ part: m, text: mcpCommandLine(m) });
    if (mcp && typeof mcp.v === "object" && !Array.isArray(mcp.v))
      for (const m of mcpParts(mcp.file, { mcpServers: mcp.v }, scope, node))
        runners.push({ part: m, text: mcpCommandLine(m) });

    const scripts: PartNode[] = [];
    for (const p of paths) {
      const rel = relativeTo(pl.dir, p);
      if (!rel || !/^(scripts|bin)\//.test(rel) || !own(p) || inSkill(p)) continue;
      scripts.push(addPart("script", scope, rel, { description: "", plugin: node.id, file: p, details: {} }));
    }
    pluginScripts.set(node.id, scripts);
  }

  // project-level Claude Code config outside any plugin
  const projectMd = (kind: "command" | "agent") =>
    paths.filter((p) => /\.md$/i.test(p) && !ownerPlugin(p) && new RegExp(`(^|/)\\.claude/${kind}s/`).test(p));
  for (const kind of ["command", "agent"] as const) {
    for (const f of projectMd(kind))
      markdownParts(
        kind,
        [f],
        "project",
        undefined,
        f.slice(0, f.indexOf(`.claude/${kind}s/`) + `.claude/${kind}s`.length),
      );
  }
  for (const p of paths) {
    if (ownerPlugin(p)) continue;
    if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p))
      for (const h of hookParts(p, readJson(p), "project", undefined))
        runners.push({ part: h, text: str(h.details.command) });
    else if (basename(p) === ".mcp.json")
      for (const m of mcpParts(p, readJson(p), "project", undefined))
        runners.push({ part: m, text: mcpCommandLine(m) });
  }

  // files next to each skill: scripts, references (context), assets
  const skillFileParts = new Map<string, PartNode[]>();
  for (const { skill } of canonical) {
    const nested = skillDirs.filter((d) => d !== skill.dir && relativeTo(skill.dir, d) !== null);
    const list: PartNode[] = [];
    for (const p of paths) {
      const rel = relativeTo(skill.dir, p);
      if (!rel || rel === "SKILL.md" || /^agents\/[^/]+\.ya?ml$/.test(rel)) continue;
      if (nested.some((d) => relativeTo(d, p) !== null)) continue;
      const kind: PartKind =
        /^(scripts|bin)\//.test(rel) || SCRIPT_EXT.test(rel)
          ? "script"
          : /^references\//.test(rel) || TEXT_EXT.test(rel)
            ? "reference"
            : "asset";
      list.push(addPart(kind, skill.id, rel, { description: "", skill: skill.id, file: p, details: {} }));
    }
    skillFileParts.set(skill.id, list);
  }

  /* ---------- skill nodes ---------- */

  const modes = new Map<string, Mode>();
  const nodes: SkillNode[] = canonical.map(({ skill: s, copies }) => {
    const claude = claudeMode(s.frontmatter);
    const codex = s.codex.allowImplicitInvocation ? "auto" : "manual";
    const mode = unionMode(claude, codex);
    modes.set(s.id, mode);
    const node: SkillNode = {
      id: s.id,
      name: s.name,
      description: s.description,
      mode,
      invocation: { claude, codex },
      entry: false,
      subSkill: false,
      dir: s.dir,
      file: s.file,
      bodyLines: s.body.length,
      scripts: s.scripts,
      references: s.references,
      frontmatter: s.frontmatter,
    };
    if (typeof s.frontmatter["argument-hint"] === "string")
      node.argumentHint = s.frontmatter["argument-hint"] as string;
    const tools = asStringArray(s.frontmatter["allowed-tools"]);
    if (tools) node.allowedTools = tools;
    if (typeof s.frontmatter.context === "string") node.context = s.frontmatter.context;
    if (typeof s.frontmatter.model === "string") node.model = s.frontmatter.model;
    const pl = [s, ...copies].map((x) => ownerPlugin(x.dir)).find(Boolean);
    if (pl?.node) {
      node.plugin = pl.node.id;
      pl.node.skills.push(s.id);
    }
    if (copies.length) node.copies = copies.map((c) => c.file);
    return node;
  });
  for (const { part } of parts)
    if (part.plugin) pluginList.find((p) => p.node!.id === part.plugin)!.node!.parts.push(part.id);

  /* ---------- relations ---------- */

  const docs: Doc[] = [...canonical.map((c) => c.skill), ...parts.flatMap((p) => (p.doc ? [p.doc] : []))];
  const { edges: all, flows, unresolved } = detect(docs, modes);
  const skillIds = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = [];
  const links: Edge<LinkType>[] = [];
  for (const e of all) (skillIds.has(e.source) && skillIds.has(e.target) ? edges : links).push(e);

  // a skill runs its scripts and reads its references when its body names them
  for (const { skill } of canonical) {
    for (const part of skillFileParts.get(skill.id) ?? []) {
      const rel = part.name;
      const base = basename(rel);
      const needles = [rel, ...(base !== rel && base.includes(".") && base.length >= 5 ? [base] : [])];
      const evidence: Evidence[] = [];
      skill.body.forEach((text, i) => {
        if (evidence.length < 5 && needles.some((n) => text.includes(n)))
          evidence.push({ line: skill.bodyStart + i, snippet: clip(text.trim(), 220), pattern: "file" });
      });
      if (evidence.length)
        links.push({ source: skill.id, target: part.id, type: part.kind === "script" ? "runs" : "reads", evidence });
    }
  }
  // hooks and MCP servers that start a plugin script
  for (const { part, text } of runners) {
    if (!text || !part.plugin) continue;
    for (const script of pluginScripts.get(part.plugin) ?? []) {
      const base = basename(script.name);
      if (
        text.includes(script.name) ||
        (base.includes(".") && new RegExp(`[/\\\\\\s"']${escapeRe(base)}\\b`).test(text))
      ) {
        links.push({
          source: part.id,
          target: script.id,
          type: "runs",
          evidence: [{ line: Number(part.details.line) || 1, snippet: clip(text, 220), pattern: "file" }],
        });
      }
    }
  }
  links.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));

  // entry points and sub-skills count callers of every kind: a command that runs a skill is its entry
  const incomingAny = new Map<string, number>();
  const incomingCalls = new Map<string, number>();
  for (const e of [...edges, ...links]) {
    if (!skillIds.has(e.target)) continue;
    if (e.evidence.some((v) => v.type === "calls" || v.type === "suggests"))
      incomingAny.set(e.target, (incomingAny.get(e.target) ?? 0) + 1);
    if (e.type === "calls" || e.type === "prerequisite")
      incomingCalls.set(e.target, (incomingCalls.get(e.target) ?? 0) + 1);
  }
  for (const n of nodes) {
    n.entry = n.mode === "manual" && (incomingAny.get(n.id) ?? 0) === 0;
    n.subSkill = n.mode !== "manual" && (incomingCalls.get(n.id) ?? 0) > 0;
  }

  const source: Source = opts.source ?? { kind: "local", roots: opts.roots ?? [] };
  const partNodes = parts.map((p) => p.part).sort((a, b) => a.id.localeCompare(b.id));
  return {
    meta: {
      generatedAt: new Date().toISOString(),
      roots:
        opts.roots ??
        (source.kind === "local"
          ? source.roots
          : [`${source.owner}/${source.repo}${source.subpath ? "/" + source.subpath : ""}`]),
      skillCount: nodes.length,
      edgeCount: edges.length,
      flowCount: flows.length,
      partCount: partNodes.length,
      pluginCount: pluginList.length,
      version: VERSION,
      source,
      warnings,
    },
    nodes,
    edges,
    flows,
    unresolved,
    plugins: pluginList.map((p) => p.node!),
    marketplaces,
    parts: partNodes,
    links,
  };
}

/**
 * The paths analyze() would read from `paths`, given what is already loaded. A fetcher that loads
 * file contents lazily (the GitHub tree source) calls this until it returns nothing new: the first
 * round finds SKILL.md files and manifests, the next finds what the manifests point at.
 */
export function filesToRead(paths: string[], read: (p: string) => string | undefined = () => undefined): string[] {
  const wanted = new Set<string>();
  analyze({ paths, read: (p) => (wanted.add(p), read(p)) });
  return [...wanted].filter((p) => read(p) === undefined);
}

/* ---------- helpers ---------- */

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clip(s: string, n = 160): string {
  return s.length > n ? s.slice(0, n - 3) + "..." : s;
}

function firstLine(body: string[]): string {
  const l = body.find((x) => x.trim() && !/^#{1,6}\s/.test(x)) ?? "";
  return clip(l.trim());
}

function lineIn(text: string, needle: string): number {
  if (!needle) return 1;
  const i = text.indexOf(needle);
  return i < 0 ? 1 : text.slice(0, i).split("\n").length;
}

function unique(id: string, used: Set<string>): string {
  let out = id;
  for (let i = 2; used.has(out); i++) out = `${id}~${i}`;
  used.add(out);
  return out;
}

function unique2<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mcpCommandLine(m: PartNode): string {
  return [str(m.details.command), ...(((m.details.args as string[]) ?? []) as string[])].join(" ");
}

function sourceLabel(src: unknown): string {
  if (!src || typeof src !== "object") return String(src ?? "");
  const o = src as Record<string, unknown>;
  return [str(o.source), str(o.repo) || str(o.url), str(o.path)].filter(Boolean).join(":");
}

function repoName(source?: Source): string {
  return source?.kind === "github" ? source.repo : "";
}
