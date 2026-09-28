# Dependency Graph (Phase 3)

## Build Dependency Graph

**Command to Skill:**

Look for `See skills/*/SKILL.md` patterns in command files.

**Skill to Tools:**

Extract `allowed-tools` from frontmatter.

**Skill to Skill:**

Look for `Task` tool usage with skill references, or `@skill-name` patterns.

**Hook to Event:**

Parse hooks.json structure:

```json
{
  "hooks": {
    "EVENT_TYPE": [
      { "matcher": "...", "hooks": ["script.sh"] }
    ]
  }
}
```

## JSON Structure

```json
{
  "plugin": {
    "name": "plugin-name",
    "version": "1.0.0",
    "path": "/path/to/plugin"
  },
  "components": {
    "commands": [
      { "name": "commit", "file": "commands/commit.md", "description": "...", "allowedTools": ["..."] }
    ],
    "skills": [
      { "name": "commit", "file": "skills/commit/SKILL.md", "description": "...", "allowedTools": ["..."] }
    ],
    "hooks": [
      { "event": "PreToolUse", "matcher": "Bash", "script": "block-manual-release.sh" }
    ],
    "agents": []
  },
  "dependencies": {
    "commandToSkill": {
      "commit": "commit"
    },
    "skillToTools": {
      "commit": ["Read", "Write", "Bash", "Glob"]
    },
    "skillToSkill": {
      "release": ["claude-code-guide"]
    },
    "hookToEvent": {
      "block-manual-release.sh": "PreToolUse:Bash"
    }
  },
  "stats": {
    "totalCommands": 27,
    "totalSkills": 20,
    "totalHooks": 13,
    "totalAgents": 1
  }
}
```
