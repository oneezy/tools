# ADR-0003: The Source alias is one link, `.agents/skills-library`, to the Library root

Date: 2026-10-17. Status: accepted. Recorded by oneezy/tools#211.

## Context

A Development project needs the Library open in its own editor workspace, so that an edit made there reaches the one source (spec #209, stories 2 and 3). The link must not be loaded by any Harness as a skill, a plugin or a marketplace.

## Decision

- **One link per project, `<project>/.agents/skills-library`, to the Library root** (`packages/skills`), not to a Group or a Plugin. Own skills, `skills-sync.json` and the scripts can then all be edited from the project, and a change of selection never moves the link.
- **`.agents/` is skills-sync's project folder**, beside the record. No Harness scans `.agents/skills-library`. Codex reads only `.agents/skills` and `.agents/plugins`. Claude Code reads `.claude/`, which setup never touches.
- **It is a directory symlink, or a junction where Windows refuses one**, the same rule as every other skills-sync link. Setup never adopts a folder or a link to somewhere else; either is a conflict that changes nothing.
- **A project inside the Library is refused**, because its alias would contain itself.

## Considered options

- **A link under `.claude/skills/` or `.agents/skills/`**: both are Harness discovery folders. The Library root would be scanned as skills or as a plugin.
- **A visible top-level `skills-library/` folder**: it is easier to spot, but it clutters every project root and is easier to commit by accident.
