# Discovery and Parsing (Phases 1-2)

## Phase 1: Discover Components

**Plugin Manifest:**

```bash
PLUGIN_PATH="${1:-.}"
cat "$PLUGIN_PATH/.claude-plugin/plugin.json" | jq '{name, version, description}'
```

**Commands:**

```bash
ls "$PLUGIN_PATH/commands/"*.md 2>/dev/null | wc -l
```

**Skills:**

```bash
ls -d "$PLUGIN_PATH/skills/"*/ 2>/dev/null | wc -l
```

**Hooks:**

```bash
cat "$PLUGIN_PATH/hooks/hooks.json" 2>/dev/null | jq '.hooks | keys'
```

**Agents:**

```bash
ls "$PLUGIN_PATH/agents/"*.md 2>/dev/null | wc -l
```

## Phase 2: Parse Metadata

For each component, extract name and description dynamically:

**Command Descriptions:**

```bash
for f in "$PLUGIN_PATH/commands/"*.md; do
  name=$(basename "$f" .md)
  desc=$(sed -n '/^description:/s/description: *//p' "$f" | head -1)
  printf "%-28s %s\n" "$name" "$desc"
done
```

**Skill Descriptions:**

```bash
for d in "$PLUGIN_PATH/skills/"*/; do
  name=$(basename "$d")
  desc=$(sed -n '/^description:/s/description: *//p' "$d/SKILL.md" | head -1)
  printf "%-28s %s\n" "$name" "$desc"
done
```

**Hook Scripts:**

```bash
jq -r '.hooks | to_entries[] | .key as $event | .value[] | .hooks[] |
  "\($event)|\(.matcher // "*")|\(.command | split("/") | last)"' \
  "$PLUGIN_PATH/hooks/hooks.json"
```

**Agent Descriptions:**

```bash
for f in "$PLUGIN_PATH/agents/"*.md; do
  name=$(basename "$f" .md)
  desc=$(sed -n '/^description:/s/description: *//p' "$f" | head -1)
  echo "$name|$desc"
done
```
