# ADR-0001: The launcher is the skills-sync bin, and it acts on the project it runs in

Date: 2026-10-17. Status: accepted. Recorded by oneezy/tools#211 (spec #209). The Library's ADRs are in `packages/skills/docs/adr`; ADR-0020 there is the Development project exception this builds on.

## Context

Justin wants to start development mode from any local project, not only from the tools checkout. A global install must not turn development Plugins on anywhere by itself (ADR-0020, decision 1).

## Decision

- The launcher is the existing `skills-sync` bin. A global install reaches it from any folder. `pnpm skills:dev:launcher` builds the checkout and runs `npm install --global ./packages/skills-sync`, which links the global bin to that checkout, so the launcher always matches the Library it serves. The published `npx @oneezy/skills-sync` works the same way once a release has these commands.
- The project is the folder the command runs in. That is `--root` when given, else the nearest folder above with a project record, else the nearest folder with `.git`, else the current folder.
- The Library comes from `--repo` on the first `develop setup`. After that it comes from the project record. `$SKILLS_REPO` is the fallback.
- Installing the launcher writes nothing. Only `develop setup`, run in a project, connects that project. `develop status` in any other project reports "not a Development project" and writes nothing.

## Considered options

- **A machine-wide list of projects or a default Library under the user's home.** It is a settings file kept on the machine, the thing ADR-0012 in the Library removed. A Library path named once per project, then recorded in that project, covers the same need.
- **A separate launcher command or package.** That is a second CLI to keep current. The `develop` command family already owns development mode.
