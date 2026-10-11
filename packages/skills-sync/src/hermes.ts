// Hermes's own records, read and never written (hermes writes them through its plugins commands): the plugins under
// <home>/plugins/<id>/ with their root plugin.json, the row plugins/.install-metadata.json keeps per install (the clone
// URL and subdirectory, the revision, whether --ref pinned it), and the activation lists in config.yaml (plugins.enabled
// is the opt-in list, plugins.disabled the deny-list that wins). Reading them needs no hermes on PATH and no network:
// `hermes plugins list` resolves the plugin catalog over the network on every call, so the probe reads the files and the
// form asks the CLI once, after it installed. Shapes from hermes-agent v0.21.6 (docs/research/hermes-plugin-format.md in
// oneezy/skills).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { isDir, skillsIn } from "./fs.js";

/** What hermes plugins list says about a plugin: in plugins.enabled, in plugins.disabled, or in neither. */
export type HermesActivation = "enabled" | "disabled" | "not enabled";

/** One row of plugins/.install-metadata.json: `{ pinned, revision, source: "<url>#<subdir>" }`. */
export interface HermesInstall {
  /** the clone URL, https://github.com/owner/repo.git for a GitHub install */
  url: string;
  /** the subdirectory of the repository the plugin was taken from (dist/hermes/<id> for the library's); null for its root */
  subdir: string | null;
  /** the commit hermes checked out; null when the row has none */
  revision: string | null;
  /** installed with --ref: `hermes plugins update` refuses it, `install --force --ref` moves it */
  pinned: boolean;
}

export interface HermesPlugin {
  /** plugin.json's name, else the folder name */
  id: string;
  version: string | null;
  skills: string[];
  /** <home>/plugins/<id> */
  path: string;
  /** the install row; null when hermes recorded none (a folder copied or linked there by hand, or another installer) */
  install: HermesInstall | null;
  activation: HermesActivation;
}

/** Every plugin folder under <home>/plugins, in name order; dot entries and the metadata file are not plugins. */
export function hermesPlugins(home: string): HermesPlugin[] {
  const root = path.join(home, "plugins");
  if (!isDir(root)) return [];
  const installs = readInstalls(home);
  const lists = readActivation(home);
  const out: HermesPlugin[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (name.startsWith(".") || !isDir(dir)) continue;
    const manifest = readJson(path.join(dir, "plugin.json"));
    // Hermes also loads its own plugin.yaml packages; this tool installs portable ones only, and lists those
    if (!manifest) continue;
    const id = typeof manifest.name === "string" && manifest.name ? manifest.name : name;
    out.push({
      id,
      version: typeof manifest.version === "string" && manifest.version ? manifest.version : null,
      skills: skillsIn(dir),
      path: dir,
      install: installs[name] ?? installs[id] ?? null,
      activation: activationOf(id, lists),
    });
  }
  return out;
}

/** The install rows by plugin name; none when the file is missing or not JSON (hermes would refuse to read it too). */
export function readInstalls(home: string): Record<string, HermesInstall> {
  const rows = readJson(path.join(home, "plugins", ".install-metadata.json"));
  const out: Record<string, HermesInstall> = {};
  if (!rows) return out;
  for (const [name, row] of Object.entries(rows)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const source = typeof r.source === "string" ? r.source : "";
    const at = source.indexOf("#");
    out[name] = {
      url: at < 0 ? source : source.slice(0, at),
      subdir: at < 0 ? null : source.slice(at + 1).replace(/^\/+|\/+$/g, "") || null,
      revision: typeof r.revision === "string" && r.revision ? r.revision : null,
      pinned: r.pinned === true,
    };
  }
  return out;
}

/** plugins.enabled and plugins.disabled from config.yaml; empty when the file or the keys are missing or malformed. */
export function readActivation(home: string): { enabled: Set<string>; disabled: Set<string> } {
  const out = { enabled: new Set<string>(), disabled: new Set<string>() };
  let config: unknown;
  try {
    config = YAML.parse(fs.readFileSync(path.join(home, "config.yaml"), "utf8"));
  } catch {
    return out;
  }
  const plugins = (config as { plugins?: unknown } | null)?.plugins;
  if (!plugins || typeof plugins !== "object") return out;
  for (const key of ["enabled", "disabled"] as const) {
    const list = (plugins as Record<string, unknown>)[key];
    if (Array.isArray(list)) for (const v of list) if (typeof v === "string") out[key].add(v);
  }
  return out;
}

/** Hermes's rule: an explicit disable wins, then the allow-list; a plugin in neither is discovered but not loaded. */
export function activationOf(id: string, lists: { enabled: Set<string>; disabled: Set<string> }): HermesActivation {
  if (lists.disabled.has(id)) return "disabled";
  return lists.enabled.has(id) ? "enabled" : "not enabled";
}

/** `owner/repo` of a GitHub clone URL (https, ssh or git@), lower-cased, without .git; null for any other URL. */
export function githubRepo(url: string): string | null {
  const m = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The namespace Hermes gives a portable plugin's skills: agent-plugin-<slug>-<sha256(key)[:8]> (plugins_manifest.py). */
export function hermesNamespace(id: string): string {
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]/gu, "-")
      .replace(/^[-_]+|[-_]+$/g, "") || "plugin";
  return `agent-plugin-${slug}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8)}`;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    // Hermes reads these utf-8-sig: a BOM a Windows editor left in front is not part of the JSON
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
