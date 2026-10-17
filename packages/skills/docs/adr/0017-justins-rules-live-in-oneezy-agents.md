# ADR-0017: Justin's rules live in the oneezy plugin, loaded by /oneezy-agents and edited straight on dev

Date: 2026-10-12. Status: accepted; decisions 3 (a stale copy is a note), 4 (live from `dev`) and 5 (edited straight on `dev`) superseded by ADR-0018. Amends ADR-0011 (global blocks only): the global block no longer carries the rules, only a pointer to the skill that loads them. Tickets: oneezy/skills#87, oneezy/tools#205.

## Context

Justin's rules lived in `SHARED.md` at the repo root, and reached a harness only through the global block skills-sync copied it into (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), at the latest release's commit. Claude.ai, ChatGPT and Claude Cowork have no global instructions file, only custom instructions Justin types, so they never got the rules. A text change also took a pull request into `dev`, a promotion to `main` and a release before any harness saw it. Justin asked for one source of truth, one line in each harness's custom instructions, an edit he can make himself without that cycle, and the file named `agents.md` instead of `SHARED.md`.

## Decision

1. **A skill loads the rules.** `/oneezy-agents`, in the oneezy plugin, loads `agents.md` and follows it for the session. Justin's custom instructions in Claude, ChatGPT and Cowork say to use it at the start of every chat.
2. **The global block points at the skill.** skills-sync stops copying `SHARED.md`; its block is the tool's own short text: load `/oneezy-agents` at session start, plus the invocation table. Claude Code and Codex reach the rules the same way as every other harness. `SHARED.md` is removed.
3. **One source, outside every package.** The rules are `skills/oneezy/agents.md`. A loose file in a group folder is not packaged, so editing it never drifts `build --check`. `node scripts/oneezy-capabilities.mjs --write` copies it into the skill as `references/agents.md`; a stale copy is a note, never a failed check.
4. **Live from `dev`, then the packaged copy.** The skill fetches https://raw.githubusercontent.com/oneezy/skills/dev/skills/oneezy/agents.md first, falls back to its packaged copy, and names the copy it used.
5. **Edited straight on `dev`.** Justin edits `skills/oneezy/agents.md` in the GitHub app or site and commits to `dev`: no pull request, no promotion. Agents propose wording and commit it only on his yes.

## Considered options

- **Google Drive:** one link Justin edits like a document, but Hermes, Codex CLI and cloud containers cannot read Drive, and ChatGPT needs its Drive connector switched on in every chat. Tried separately as a playground experiment, not here.
- **The rules inside the skill folder:** one file, but every direct edit would change a package, turn `build --check` red on `dev` and need a version bump before a release.
- **`agents.md` at the repo root:** Codex reads a root `AGENTS.md` as this repo's own instructions, and Windows treats the two names as one file.
- **Edit on `main`:** `dev` would keep the old text, every branch cut from `dev` would read and edit it, and the next promotion could conflict.
- **Keep copying the rules into the global block:** two routes to the same text, one of them only as fresh as the last release and sync.

## Consequences

- `dev` can hold rules `main` does not yet carry; the live copy wins, and the skill says so when it falls back to the packaged one.
- GitHub's raw file service may serve the previous text for a few minutes after a commit.
- A session with no network and an old plugin runs on old rules, and says so.
- Until a machine runs the new skills-sync, its block keeps the old text; the next sync replaces it.
