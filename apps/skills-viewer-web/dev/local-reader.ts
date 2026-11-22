import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { analyze, memoryFileSet, readLocal, type Graph } from "skills-viewer/node";

export function localSnapshot(root: string) {
  const local = readLocal([path.join(root, "skills"), path.join(root, ".agents", "skills")]);
  const files = new Map<string, string>();
  const hash = createHash("sha256");
  for (const file of local.paths.sort()) {
    const text = local.read(file);
    if (text === undefined) continue;
    const relative = path.relative(root, file).replaceAll("\\", "/");
    files.set(relative, text);
    hash.update(relative).update("\0").update(text).update("\0");
  }
  for (const name of ["skills-sync.json", "skills-sync.lock.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    files.set(name, text);
    hash.update(name).update("\0").update(text).update("\0");
  }
  return { files, revision: hash.digest("hex") };
}

function libraryOwnership(files: Map<string, string>): Record<string, string> {
  const config = JSON.parse(files.get("skills-sync.json") ?? "{}") as {
    sources?: Record<string, { rename?: Record<string, string> }>;
    plugins?: Record<string, { source?: string; group?: string }>;
  };
  const lock = JSON.parse(files.get("skills-sync.lock.json") ?? "{}") as {
    sources?: Record<string, { skills?: Record<string, unknown> }>;
  };
  const plugins = Object.entries(config.plugins ?? {});
  const dependencies = new Map<string, string>();
  for (const [source, entry] of Object.entries(lock.sources ?? {})) {
    const group = plugins.find(([, p]) => p.source === source)?.[0] ?? source;
    for (const name of Object.keys(entry.skills ?? {})) {
      dependencies.set(config.sources?.[source]?.rename?.[name] ?? name, group);
    }
  }
  return Object.fromEntries(
    [...files.keys()]
      .filter((f) => f.endsWith("/SKILL.md"))
      .map((file) => {
        const dir = path.posix.dirname(file);
        const parts = dir.split("/");
        const group = parts[0] === "skills" && parts.length > 2 ? parts[1] : undefined;
        return [
          dir,
          group
            ? (plugins.find(([, p]) => p.group === group)?.[0] ?? group)
            : (dependencies.get(path.posix.basename(dir)) ?? "Loose skills"),
        ];
      }),
  );
}

export function createLocalReader(root: string) {
  let revision = "";
  let graph: Graph;
  return () => {
    const snapshot = localSnapshot(root);
    if (snapshot.revision !== revision) {
      graph = analyze(memoryFileSet(snapshot.files), {
        source: { kind: "local", roots: ["packages/skills"] },
        roots: ["skills", ".agents/skills"],
        skillLibraries: libraryOwnership(snapshot.files),
      });
      revision = snapshot.revision;
    }
    return { graph, revision, folder: "packages/skills" };
  };
}
