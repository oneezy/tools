# ADR-0011: The tool writes instructions only into each harness's global file

Date: 2026-10-11. Status: accepted. Decided in the Skills Sync repair grilling of 2026-10-10 (Q8, Q15, and Justin's rule of 22:55).

## Decision

- The tool's block (between `skills-sync` markers) goes only into the harness's global instructions file: `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Never into a repository's `AGENTS.md`, `CLAUDE.md` or settings.
- The block carries a per-harness table of how to invoke a skill (Claude Code `/plugin:skill`; Codex `$skill`, the `/skills` picker, `@` on ChatGPT web). When a typed skill does not resolve, the agent shows that table instead of improvising.
- An agent never fetches a `SKILL.md` from GitHub (or any copy outside its harness) to run it. Running a skill the harness did not load bypasses `disable-model-invocation` and the harness's own resolution, and breaks the system that relies on them.
