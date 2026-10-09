import fs from "node:fs";
import path from "node:path";
import { hasLinkedParent, toHash, lexists, real, under, isLink, samePath } from "./fs.js";
import type { Harness } from "./harnesses.js";
import type { Library } from "./library.js";
import { Report, type Action } from "./plan.js";
import { shippedSchema, validate } from "./schema.js";
import { pluginDependency, nativePluginRoute } from "./install.js";

export const ENTRYPOINTS_NAME = "skills-sync.entrypoints.json";

interface Entry {
  source: string;
  skill: string;
  agents: string[];
  requiredFiles?: string[];
}

export interface EntryStatus {
  path: string;
  block: string;
  state: "current" | "missing" | "drift" | "conflict";
  reason?: string;
}

const ignored_dirs = new Set([
  ".git",
  "node_modules",
  "upstream",
  "plugins",
  "dist",
  "build",
  ".svelte-kit",
  ".vercel",
]);

function read_entries(lib: Library): Record<string, Entry> {
  const file = path.join(lib.root, ENTRYPOINTS_NAME);
  if (!lexists(file)) return {};
  if (hasLinkedParent(file)) throw new Error(`${file}: entrypoint config is a link; left alone`);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; blocks: Record<string, Entry> };
  const errors = validate(shippedSchema("skills-sync.entrypoints"), parsed);
  if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
  return parsed.blocks;
}

function read_source(lib: Library, entry: Entry): string {
  const source = path.resolve(lib.root, entry.source);
  if (path.isAbsolute(entry.source) || entry.source.includes("\\") || !under(source, lib.root))
    throw new Error(`${entry.source}: source must be a relative file inside the library`);
  if (hasLinkedParent(source) || !under(real(source), lib.root))
    throw new Error(`${entry.source}: linked source is left alone`);
  const bytes = fs.readFileSync(source);
  const body = bytes.toString("utf8");
  if (!Buffer.from(body).equals(bytes) || body.includes("\0") || bytes.length > 32_768 || !body.trim())
    throw new Error(`${entry.source}: expected nonempty UTF-8 instructions, at most 32768 bytes`);
  if (body.includes("<!-- skills-sync:")) throw new Error(`${entry.source}: template cannot contain managed markers`);
  if (!lib.scanOwn().skills.some((skill) => skill.name === entry.skill))
    throw new Error(`${entry.skill}: required own skill is missing; entrypoints are not propagated`);
  const skill = lib.scanOwn().skills.find((item) => item.name === entry.skill)!;
  for (const name of ["SKILL.md", ...(entry.requiredFiles ?? [])]) {
    const file = path.resolve(skill.dir, name);
    if (path.isAbsolute(name) || !under(file, skill.dir) || hasLinkedParent(file) || !fs.statSync(file).isFile())
      throw new Error(`${entry.skill}/${name}: required skill file is unavailable; entrypoints are not propagated`);
  }
  return body
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function entrypointProblems(lib: Library): string[] {
  try {
    for (const entry of Object.values(read_entries(lib))) read_source(lib, entry);
    return [];
  } catch (error) {
    return [String(error instanceof Error ? error.message : error)];
  }
}

export function instructionDependencies(lib: Library): Array<{ skill: string; files: string[] }> {
  return Object.values(read_entries(lib)).map((entry) => {
    read_source(lib, entry);
    return { skill: entry.skill, files: entry.requiredFiles ?? [] };
  });
}

function instruction_targets(
  root: string,
  names: string[],
  nested: boolean,
  failed: (dir: string, error: unknown) => void,
): string[] {
  const targets = new Set([path.join(root, names[0])]);
  for (const name of names.slice(1)) if (lexists(path.join(root, name))) targets.add(path.join(root, name));
  if (nested && !hasLinkedParent(root)) {
    const filenames = new Set(names.map((name) => path.basename(name)));
    const visit = (dir: string): boolean => {
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        failed(dir, error);
        return false;
      }
      for (const file of files) {
        const next = path.join(dir, file.name);
        if (file.isDirectory() && !ignored_dirs.has(file.name) && file.name !== "skills") visit(next);
        else if (filenames.has(file.name)) targets.add(next);
      }
      return true;
    };
    if (!visit(root)) return [];
  }
  return [...targets].sort();
}

function to_block(id: string, body: string, newline: string): string {
  return `<!-- skills-sync:${id}:start -->\n${body}\n<!-- skills-sync:${id}:end -->`.replace(/\n/g, newline);
}

function replace_block(text: string, id: string, body: string): string {
  const start = `<!-- skills-sync:${id}:start -->`;
  const end = `<!-- skills-sync:${id}:end -->`;
  const starts = text.split(start).length - 1;
  const ends = text.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && text.indexOf(end) < text.indexOf(start)))
    throw new Error("duplicate or incomplete managed block; left alone");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const block = to_block(id, body, newline);
  if (starts) return text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length);
  const gap = !text || text.endsWith(newline + newline) ? "" : text.endsWith(newline) ? newline : newline + newline;
  return text + gap + block + newline;
}

export function entrypoints(
  lib: Library,
  harnesses: Harness[],
  global: boolean,
  projects: string[],
  report: Report,
  verifySkills = false,
  planned?: Report,
  projectCopies = false,
  nativePlugins = false,
  onlySkill?: string,
): EntryStatus[] {
  const statuses: EntryStatus[] = [];
  let entries: Record<string, Entry>;
  try {
    entries = read_entries(lib);
  } catch (error) {
    report.add({ kind: "conflict", path: path.join(lib.root, ENTRYPOINTS_NAME), note: String(error) });
    return [{ path: path.join(lib.root, ENTRYPOINTS_NAME), block: "", state: "conflict", reason: String(error) }];
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (onlySkill && entry.skill !== onlySkill) continue;
    let body: string;
    try {
      body = read_source(lib, entry);
    } catch (error) {
      report.add({ kind: "conflict", path: entry.source, note: String(error) });
      statuses.push({ path: entry.source, block: id, state: "conflict", reason: String(error) });
      continue;
    }
    const targets = new Map<string, NonNullable<Action["dependencies"]>>();
    const failedDiscovery = (dir: string, error: unknown): void => {
      const reason = `instruction discovery failed: ${error instanceof Error ? error.message : String(error)}; independent destinations continue`;
      report.add({ kind: "conflict", path: dir, note: reason });
      statuses.push({ path: dir, block: id, state: "conflict", reason });
    };
    for (const harness of harnesses.filter((item) => entry.agents.includes(item.id))) {
      if (!harness.userInstructions || !harness.projectInstructions) {
        report.add({
          kind: "conflict",
          path: harness.configDir,
          note: `${harness.id}: instruction paths are unsupported`,
        });
        statuses.push({
          path: harness.configDir,
          block: id,
          state: "conflict",
          reason: "instruction paths are unsupported",
        });
        continue;
      }
      const routes = [
        ...(global
          ? [{ root: harness.configDir, names: harness.userInstructions, nested: false, skills: harness.userSkills }]
          : []),
        ...projects.map((project) => ({
          root: project,
          names: harness.projectInstructions!,
          nested: true,
          skills: path.join(project, harness.projectSkills),
        })),
      ];
      for (const route of routes) {
        const dependencies: NonNullable<Action["dependencies"]> = [];
        if (verifySkills) {
          const own = lib.scanOwn().skills.find((item) => item.name === entry.skill)!;
          const pluginRequested = !route.nested && nativePlugins && nativePluginRoute(lib, harness, entry.skill);
          const pluginRoot = pluginRequested
            ? pluginDependency(lib, harness, entry.skill, entry.requiredFiles ?? [], !!planned)
            : null;
          const installed = pluginRoot ?? path.join(route.skills, entry.skill);
          const action = planned?.actions.find(
            (item) =>
              samePath(item.path, installed) &&
              ["link", "relink", "copy"].includes(item.kind) &&
              !item.failed &&
              item.target &&
              samePath(real(item.target), real(own.dir)),
          );
          const projected = action && !planned?.conflicts().some((item) => samePath(item.path, installed));
          let available = false;
          try {
            const owned =
              !!pluginRoot ||
              (isLink(installed) && samePath(real(installed), real(own.dir))) ||
              (route.nested && projectCopies && !isLink(installed));
            available = pluginRequested
              ? !!pluginRoot
              : !!projected ||
                (owned &&
                  ["SKILL.md", ...(entry.requiredFiles ?? [])].every((name) => {
                    const file = path.join(installed, name);
                    return (
                      lexists(file) &&
                      !isLink(file) &&
                      ((projectCopies && route.nested) || samePath(real(file), real(path.join(own.dir, name)))) &&
                      fs.readFileSync(file).equals(fs.readFileSync(path.join(own.dir, name)))
                    );
                  }));
          } catch {
            /* Independent destinations can continue when this installed dependency is unreadable. */
          }
          if (!available) {
            const reason = `${entry.skill}: installed instructions differ from the reviewed library or are not canonically owned; repair its link conflict before claiming the route`;
            report.add({ kind: "conflict", path: installed, note: reason });
            statuses.push({ path: installed, block: id, state: "conflict", reason });
            continue;
          }
          dependencies.push({
            path: installed,
            target: pluginRoot || (route.nested && projectCopies) ? null : real(own.dir),
            files: ["SKILL.md", ...(entry.requiredFiles ?? [])].map((name) => ({
              name,
              hash: toHash(fs.readFileSync(path.join(pluginRoot ?? own.dir, name))),
            })),
          });
          if (pluginRoot || (route.nested && projectCopies))
            dependencies.push({
              path: own.dir,
              target: null,
              files: ["SKILL.md", ...(entry.requiredFiles ?? [])].map((name) => ({
                name,
                hash: toHash(fs.readFileSync(path.join(own.dir, name))),
              })),
            });
          const template = path.resolve(lib.root, entry.source);
          dependencies.push({
            path: path.dirname(template),
            target: null,
            files: [{ name: path.basename(template), hash: toHash(fs.readFileSync(template)) }],
          });
        }
        for (const file of instruction_targets(route.root, route.names, route.nested, failedDiscovery))
          targets.set(file, dependencies);
      }
    }
    for (const [file, dependencies] of targets) {
      try {
        if (hasLinkedParent(file)) throw new Error("linked instruction file or parent; left alone");
        const exists = lexists(file);
        const bytes = exists ? fs.readFileSync(file) : null;
        const text = bytes?.toString("utf8") ?? "";
        if (bytes && (!Buffer.from(text).equals(bytes) || text.includes("\0")))
          throw new Error("not UTF-8 text; left alone");
        const prior = report.actions.find((action) => action.kind === "write" && action.path === file);
        const imports =
          !exists && path.basename(file) === "CLAUDE.md"
            ? ["AGENTS.md", ".claude/AGENTS.md"]
                .filter((name) => lexists(path.join(path.dirname(file), name)))
                .map((name) => `@${name}\n`)
                .join("")
            : "";
        const next = replace_block(prior ? String(prior.payload) : imports + text, id, body);
        const state = text === next ? "current" : exists ? "drift" : "missing";
        statuses.push({ path: file, block: id, state });
        if (prior) {
          prior.payload = next;
          prior.dependencies = [...(prior.dependencies ?? []), ...dependencies];
        } else if (state === "current") report.add({ kind: "skip", path: file, note: `${id} instructions current` });
        else
          report.add({
            kind: "write",
            path: file,
            payload: next,
            expectedHash: bytes ? toHash(bytes) : null,
            dependencies,
            note: `${id} managed instructions`,
          });
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        report.add({ kind: "conflict", path: file, note: reason });
        statuses.push({ path: file, block: id, state: "conflict", reason });
      }
    }
  }
  return statuses;
}
