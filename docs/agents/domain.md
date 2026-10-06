# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repo is **multi-context**.

- **`GLOSSARY-MAP.md`** at the repo root: it lists every context and how they relate. Read the `GLOSSARY.md` of each context the topic touches.
- **`GLOSSARY.md`** at the repo root: the Tools workspace context, the words every package shares (Tool, CLI, Picker, Harness, Surface, Host). Always relevant.
- **`packages/<name>/GLOSSARY.md`**: one per package that is its own context. `apps/skills-viewer-web` shares `packages/skills-viewer`'s.
- **ADRs**: `packages/<name>/docs/adr/` for decisions inside one package; `docs/adr/` at the root for decisions that span packages (none yet).

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

```
/
├── GLOSSARY-MAP.md                    ← lists the contexts below
├── GLOSSARY.md                        ← Tools workspace: shared words
├── docs/adr/                          ← workspace-wide decisions (created when the first one is needed)
├── apps/
│   └── skills-viewer-web/             ← uses packages/skills-viewer's glossary
└── packages/
    ├── skills-sync/GLOSSARY.md
    ├── skills-viewer/GLOSSARY.md
    ├── task-manager/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← task-manager decisions
    ├── remote-sessions/GLOSSARY.md
    └── apps-sync/GLOSSARY.md
```

A new package that brings its own words gets its own `GLOSSARY.md` and a line in `GLOSSARY-MAP.md`; one that only uses the shared words gets neither.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the context's `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
