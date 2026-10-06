# Glossary Map

`oneezy/tools` holds several tools with their own words. The workspace glossary holds the words they share; each package that is its own context has a `GLOSSARY.md` beside its code, and its decisions in its own `docs/adr/`. Workspace-wide decisions go in `docs/adr/` at the root.

## Contexts

- [Tools workspace](./GLOSSARY.md): the shared words: Tool, CLI, Picker, Harness, Surface, Host
- [Skills sync](./packages/skills-sync/GLOSSARY.md): one skills library linked into every Harness on every Host
- [Skills viewer](./packages/skills-viewer/GLOSSARY.md): maps a skills library; covers the engine and `apps/skills-viewer-web`
- [Task manager](./packages/task-manager/GLOSSARY.md): one GitHub project per repo, its board moved by git events, and the roadmap as phases
- [Remote sessions](./packages/remote-sessions/GLOSSARY.md): background Claude Threads and the Worktrees Claude and Codex share
- [Apps sync](./packages/apps-sync/GLOSSARY.md): keeps Windows and WSL software current, only when asked

## Relationships

- **Skills sync → Skills viewer**: the viewer reads the layout a Library has (own skills, Groups, Plugins, Catalogs) and maps it; it never writes one.
- **Skills viewer → its website**: `apps/skills-viewer-web` draws the engine's Skill map; Card, Family and Layout are the website's words for it.
- **Task manager ↔ Remote sessions**: both key on a Ticket number. A Worktree is named after its Ticket (`<repo>-issue-<n>-<slug>`); the Ticket's Status moves when its branch reaches GitHub.
- **Apps sync → everything**: keeps the CLIs the other tools call (`claude`, `codex`, `gh`, Node, pnpm) current on each Host; it shares no data with them.
- **Tool vs App**: a Tool is one of Justin's programs in this workspace; an App is software Apps sync keeps current. Apps sync is itself a Tool.
