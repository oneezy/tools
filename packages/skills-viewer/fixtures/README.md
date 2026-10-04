# Fixtures

## mattpocock-skills

The 38 skills from `mattpocock/skills` that this repo installs, copied flat from
`.claude/skills/` (the `oneezy-*` skills are excluded). Pinned by the hashes in
`skills-lock.json` at repo commit `ea0c5bc7`. Do not edit these files; refresh
by re-copying after `setup-matt-pocock-skills` bumps the lock.

Every Phase 1 tool trial and every skills-viewer test runs against this copy.

## plugin-library

A hand-written marketplace (`.claude-plugin/marketplace.json`) with one plugin, `plugins/toolkit`, that has one of every part: a command, an agent, two hooks, a stdio MCP server in `.mcp.json` and an HTTP one inline in `plugin.json`, plugin scripts, and a skill with a script and a reference. `skills/review` is also shipped as `plugins/toolkit/skills/review` with different content, to test dedupe. Edit freely; the v2 tests assert against it.
