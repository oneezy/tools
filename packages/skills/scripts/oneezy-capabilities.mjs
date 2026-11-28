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
    // A self-contained script skill has no connector/skill routing to bundle.
    if (entry.capabilityReferences === false && entry.dependencies.length) errors.push(`${name}: standalone scripts cannot declare routed dependencies`);
    for (const file of entry.capabilityReferences === false ? [] : files) {
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
/**
 * Every authored skill (`skills/<group>/<skill>/SKILL.md`) whose frontmatter `description` holds `<` or `>`. claude.ai
 * strips angle brackets from a plugin skill's description and warns on the marketplace sync ("cannot contain XML
 * tags"), so a placeholder such as `<branch>` loses its word there. Write the placeholder as plain words instead.
 */
export function descriptionProblems(repo = root) {
  const errors = [];
  const skills = path.join(repo, "skills");
  for (const group of fs.existsSync(skills) ? fs.readdirSync(skills).sort() : []) {
    if (!fs.statSync(path.join(skills, group)).isDirectory()) continue;
    for (const name of fs.readdirSync(path.join(skills, group)).sort()) {
      const file = path.join(skills, group, name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "";
      // the description line and its indented continuation lines; a folded `>-` or `|` indicator is YAML, not text
      const block = /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(frontmatter)?.[1] ?? "";
      const text = block.replace(/^[>|][-+]?[ \t]*(?=\r?\n|$)/, "");
      if (/[<>]/.test(text)) errors.push(`${group}/${name}: description holds angle brackets, which claude.ai strips; write the placeholder as plain words`);
    }
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const errors = [...bundle(root, write), ...descriptionProblems(root)];
  if (errors.length) { process.stderr.write(errors.join("\n") + "\n"); process.exitCode = 1; }
  else process.stdout.write("Oneezy capability references current; skill descriptions hold no angle brackets\n");
}
