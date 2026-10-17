import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function bundle(repo = root, write = false) {
  const source = path.join(repo, "docs/agents/capabilities");
  const catalog = JSON.parse(fs.readFileSync(path.join(source, "catalog.json"), "utf8"));
  const files = ["contract.md", "chatgpt.md", "claude.md", "codex.md", "catalog.json"];
  const errors = [];
  for (const [name, entry] of Object.entries(catalog.skills)) {
    const skill = path.join(repo, entry.path);
    if (!fs.existsSync(path.join(skill, "SKILL.md"))) { errors.push(`${name}: missing source skill`); continue; }
    for (const file of files) {
      const target = path.join(skill, "references/capabilities", file);
      const bytes = fs.readFileSync(path.join(source, file));
      if (write) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); }
      else if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) errors.push(`${name}/${file}: generated capability reference drift`);
    }
    for (const dependency of entry.dependencies) {
      if (!catalog.skills[dependency.id] && !catalog.capabilities[dependency.id]) errors.push(`${name}: unresolved dependency ${dependency.id}`);
      if (catalog.skills[dependency.id]?.invocation === "explicit-only") errors.push(`${name}: user-only dependency cannot be automatically chained: ${dependency.id}`);
    }
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const errors = bundle(root, write);
  if (errors.length) { process.stderr.write(errors.join("\n") + "\n"); process.exitCode = 1; }
  else process.stdout.write("Oneezy capability references current\n");
}
