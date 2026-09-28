"""Agent-authored runner for the claude-code-graph SKILL (v1.0.2).

The skill ships no scripts; Phases 1-2 are bash one-liners (run separately, see NOTES.md),
Phases 3-4 are prose. This script does what the prose says and writes the four formats.

Two modes:
  literal      - skill->skill edges ONLY from the two rules the skill names:
                 `Task` tool usage with a skill reference, or `@skill-name` patterns.
  interpreted  - what a judgement-using agent would also count: `Skill tool with "X"`,
                 `/X` slash mentions, `$X`, "the X skill", `X` backticked names.
"""
import json, os, re, sys

PLUGIN = sys.argv[1] if len(sys.argv) > 1 else "plugin"
OUT = sys.argv[2] if len(sys.argv) > 2 else "out"
os.makedirs(OUT, exist_ok=True)

manifest = json.load(open(os.path.join(PLUGIN, ".claude-plugin", "plugin.json"), encoding="utf-8"))
skills_dir = os.path.join(PLUGIN, "skills")
names = sorted(d for d in os.listdir(skills_dir) if os.path.isfile(os.path.join(skills_dir, d, "SKILL.md")))
ALT = "|".join(sorted(map(re.escape, names), key=len, reverse=True))


def frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    fm = {}
    if m:
        for line in m.group(1).split("\n"):
            mm = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
            if mm:
                fm[mm.group(1)] = mm.group(2).strip()
    return fm


def naive_description(text):
    # Mirrors the skill's sed: first line starting with `description:`; no YAML unquoting.
    for line in text.split("\n"):
        if line.startswith("description:"):
            return line[len("description:"):].strip()
    return ""


def allowed_tools(fm):
    v = fm.get("allowed-tools", "")
    v = v.strip("[]")
    return [t.strip().strip("'\"") for t in v.split(",") if t.strip()] if v else []


# Rules the skill states (literal) vs. patterns actually used in the fixture (interpreted).
LITERAL = {
    "at-skill-name": re.compile(r"@(" + ALT + r")\b"),
    "Task-tool-ref": re.compile(r"\bTask\b[^\n]{0,80}?[\"'`/](" + ALT + r")\b"),
}
INTERPRETED = {
    "Skill-tool-quoted": None,  # handled line-wise below
    "slash": re.compile(r"(?<![\w/.])/(" + ALT + r")\b"),
    "dollar": re.compile(r"\$(" + ALT + r")\b"),
    "the-X-skill": re.compile(r"\bthe\s+[`'\"]?(" + ALT + r")[`'\"]?\s+skill\b", re.I),
    "backtick": re.compile(r"`(" + ALT + r")`"),
}
SKILL_TOOL_LINE = re.compile(r"Skill\s+tool", re.I)
QUOTED_NAME = re.compile(r"[\"'`](" + ALT + r")[\"'`]")

components = []
edges_literal = {}
edges_interp = {}
evidence = []

for n in names:
    folder = os.path.join(skills_dir, n)
    text = open(os.path.join(folder, "SKILL.md"), encoding="utf-8").read()
    fm = frontmatter(text)
    comp = {
        "name": n,
        "file": f"skills/{n}/SKILL.md",
        "description": naive_description(text),
        "allowedTools": allowed_tools(fm),
        # not in the skill's schema; added so the invocation-mode row can be judged
        "frontmatter": {k: v for k, v in fm.items() if k not in ("name", "description")},
    }
    components.append(comp)
    for dirpath, _, files in os.walk(folder):
        for f in files:
            if not f.endswith((".md", ".yaml", ".sh", ".cjs")):
                continue
            p = os.path.join(dirpath, f)
            t = open(p, encoding="utf-8", errors="replace").read()
            rel = os.path.relpath(p, skills_dir).replace(os.sep, "/")
            lines = t.splitlines()
            for kind, rx in LITERAL.items():
                for m in rx.finditer(t):
                    tgt = m.group(1)
                    if tgt == n:
                        continue
                    ln = t[: m.start()].count("\n") + 1
                    edges_literal.setdefault((n, tgt), set()).add(kind)
                    edges_interp.setdefault((n, tgt), set()).add(kind)
                    evidence.append((n, tgt, kind, rel, ln, lines[ln - 1].strip()[:120]))
            for kind, rx in INTERPRETED.items():
                if rx is None:
                    for i, line in enumerate(lines, 1):
                        if SKILL_TOOL_LINE.search(line):
                            for tgt in QUOTED_NAME.findall(line):
                                if tgt != n:
                                    edges_interp.setdefault((n, tgt), set()).add(kind)
                                    evidence.append((n, tgt, kind, rel, i, line.strip()[:120]))
                    continue
                for m in rx.finditer(t):
                    tgt = m.group(1)
                    if tgt == n:
                        continue
                    ln = t[: m.start()].count("\n") + 1
                    edges_interp.setdefault((n, tgt), set()).add(kind)
                    evidence.append((n, tgt, kind, rel, ln, lines[ln - 1].strip()[:120]))


def to_map(edges):
    out = {}
    for (s, t) in sorted(edges):
        out.setdefault(s, []).append(t)
    return out


def build_json(mode, edges):
    return {
        "plugin": {"name": manifest.get("name"), "version": manifest.get("version"), "path": os.path.abspath(PLUGIN)},
        "components": {"commands": [], "skills": components, "hooks": [], "agents": []},
        "dependencies": {
            "commandToSkill": {},
            "skillToTools": {c["name"]: c["allowedTools"] for c in components if c["allowedTools"]},
            "skillToSkill": to_map(edges),
            "hookToEvent": {},
        },
        "stats": {"totalCommands": 0, "totalSkills": len(components), "totalHooks": 0, "totalAgents": 0},
        "_mode": mode,
        "_edgeKinds": {f"{s}->{t}": sorted(k) for (s, t), k in sorted(edges.items())},
    }


def nid(n):
    return "skill_" + re.sub(r"[^A-Za-z0-9_]", "_", n)


def mermaid(edges):
    L = ["graph TD"]
    L.append("    subgraph Commands")
    L.append("    end")
    L.append("    subgraph Skills")
    for c in components:
        L.append(f'        {nid(c["name"])}["{c["name"]}"]')
    L.append("    end")
    L.append("    subgraph Hooks")
    L.append("    end")
    L.append("    subgraph Events")
    L.append("    end")
    tools = sorted({t for c in components for t in c["allowedTools"]})
    if tools:
        L.append("    subgraph Tools")
        for t in tools:
            L.append(f'        tool_{t}["{t}"]')
        L.append("    end")
    for c in components:
        for t in c["allowedTools"]:
            L.append(f"    {nid(c['name'])} --> tool_{t}")
    for (s, t) in sorted(edges):
        L.append(f"    {nid(s)} --> {nid(t)}")
    return "\n".join(L) + "\n"


def pad(s, w):
    return s + " " * max(0, w - len(s))


def terminal(edges):
    W = 78
    L = []
    L.append("╭" + "─" * W + "╮")
    L.append("│" + pad(f"  {manifest.get('name')} v{manifest.get('version')}", W) + "│")
    L.append("│" + pad(f"  {manifest.get('description') or ''}", W) + "│")
    L.append("╰" + "─" * W + "╯")
    L += ["", "COMPONENTS", "─" * 80]
    L.append("  📁 Commands    0")
    L.append(f"  ⚡ Skills      {len(components)}")
    L.append("  🪝 Hooks       0 scripts (across 0 events)")
    L.append("  🤖 Agents      0")
    L += ["", "HOOK EVENTS", "─" * 80, "  (none)", "", "ALL HOOKS", "─" * 80, "  (none)"]
    L += ["", "COMMANDS (0)", "─" * 80, "  (none)"]
    L += ["", f"SKILLS ({len(components)})", "─" * 80]
    for c in components:
        L.append(f"  {pad(c['name'], 27)}{c['description']}")
    L += ["", "AGENTS (0)", "─" * 80, "  (none)"]
    L += ["", f"SKILL -> SKILL ({len(edges)})", "─" * 80]
    for (s, t) in sorted(edges):
        L.append(f"  {pad(s, 30)}→ {t}")
    if not edges:
        L.append("  (none)")
    return "\n".join(L) + "\n"


def markdown(edges, mmd):
    L = [f"## Plugin Analysis: {manifest.get('name')} v{manifest.get('version')}", ""]
    L += ["| Type | Count |", "|------|-------|", "| Commands | 0 |", f"| Skills | {len(components)} |", "| Hooks | 0 |", "| Agents | 0 |", ""]
    L += ["| Skill | Description |", "|-------|-------------|"]
    for c in components:
        L.append(f"| {c['name']} | {c['description'].replace('|', '\\|')} |")
    L += ["", f"### Skill → Skill ({len(edges)})", "", "| Source | Target |", "|--------|--------|"]
    for (s, t) in sorted(edges):
        L.append(f"| {s} | {t} |")
    L += ["", "<details>", "<summary>Mermaid Diagram</summary>", "", "```mermaid", mmd.rstrip(), "```", "", "</details>", ""]
    return "\n".join(L)


for mode, edges in (("literal", edges_literal), ("interpreted", edges_interp)):
    d = os.path.join(OUT, mode)
    os.makedirs(d, exist_ok=True)
    mmd = mermaid(edges)
    open(os.path.join(d, "graph.json"), "w", encoding="utf-8").write(json.dumps(build_json(mode, edges), indent=2))
    open(os.path.join(d, "graph.mmd"), "w", encoding="utf-8").write(mmd)
    open(os.path.join(d, "inventory.txt"), "w", encoding="utf-8").write(terminal(edges))
    open(os.path.join(d, "graph.md"), "w", encoding="utf-8").write(markdown(edges, mmd))
    print(f"[{mode}] skills={len(components)} skill->skill edges={len(edges)} skill->tools={sum(len(c['allowedTools']) for c in components)}")

with open(os.path.join(OUT, "edge-evidence.txt"), "w", encoding="utf-8") as fh:
    for r in sorted(set(evidence)):
        fh.write(" | ".join(map(str, r)) + "\n")
print("evidence rows:", len(set(evidence)))
print("interpreted edges:")
for (s, t), k in sorted(edges_interp.items()):
    print(f"  {s:30s} -> {t:30s} {sorted(k)}")
