# ADR-0002: The project record lives in the project; the Library keeps a list of its projects

Date: 2026-10-17. Status: accepted. Recorded by oneezy/tools#211. Chooses the record format that ADR-0020 (decision 3, in `packages/skills/docs/adr`) left open.

## Context

Switching development mode off must restore the project exactly, without losing anything a person changed since setup. One watcher per Library (#212) must know which projects use the Library and which Plugins they select.

## Decision

- **The record is `<project>/.agents/skills-sync-project.json`.** It holds the Library's real path, the selected Plugins, the alias path, the folders setup created, the git exclude file it wrote into (and whether setup created that file), and one entry per Harness adapter under `harnesses`, holding what that adapter owns and the prior values it replaced. It is the single source of truth for reversal. It lives with the project, so deleting or moving the project takes the record with it.
- **Git ignores the record and the alias through a marked block in the repository's `info/exclude`**, never through the project's committed `.gitignore`. Nothing machine-specific can reach a commit or a cloud session. Worktrees of one repository share that file, so the block stays until the last connected worktree is removed.
- **The Library keeps `dist/development/projects.json`**: each connected project's real path and its selection. It is derived data, never settings. Each entry is checked against that project's own record on every read, and an entry whose record is gone or names another Library reports `gone`. It sits beside the Development builds, which git already ignores.
- **Setup is all or none.** Every change is planned first. Any conflict applies nothing. The record is written last, so it only ever names what exists.
- **Remove verifies before it undoes.** It takes back the alias only while it is still a link to the recorded Library, and the exclude block only while it is still the exact block setup wrote. A piece a person changed since setup is kept, named, and becomes theirs. A record this tool cannot read, or Harness state with no verified adapter to take it back, refuses the whole removal.

## Considered options

- **Extend the loose-skill receipt `.agents/skills-sync-development.json`.** That receipt belongs to `develop` in the tools workspace, and a project can be both. Two files keep the two reversals independent.
- **Keep the record in the Library only.** Reversal would then depend on the Library still existing, and a deleted `dist/` would orphan every project.
