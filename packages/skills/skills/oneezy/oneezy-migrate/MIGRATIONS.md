# Migrations

Every upstream migration note `/oneezy-migrate` has worked out, newest first. One section per note: the source and the version that introduced it, what to find, what to change, what to leave alone, and where it has been applied.

## matt-pocock 1.3.0: `CONTEXT.md` becomes `GLOSSARY.md`

Upstream note (mattpocock/skills `CHANGELOG.md`, 1.3.0, #1120): the `CONTEXT.md` / `CONTEXT-MAP.md` domain-doc convention is renamed `GLOSSARY.md` / `GLOSSARY-MAP.md` everywhere the skills read and write it; "`git mv` it to the new name".

- **Find**: `CONTEXT.md` or `CONTEXT-MAP.md` at the repo root, or a per-context `CONTEXT.md` that a `CONTEXT-MAP.md` points at (`packages/ui/CONTEXT.md` in Trident).
- **Change**: `git mv` each to `GLOSSARY.md` / `GLOSSARY-MAP.md`; in `docs/agents/domain.md` (the file `/setup-matt-pocock-skills` wrote) every `CONTEXT` name becomes `GLOSSARY`; the AGENTS.md "Domain docs" line names `GLOSSARY.md`; every other live reference (README, `docs/agents/*.md`, package READMEs, the map's links) follows. A downgrade below 1.3.0 is the same in reverse.
- **Leave**: dated research and history (`docs/research/`, `.research/`, ADRs), and fixtures copied from upstream skills (`packages/skills-viewer/examples/` in `oneezy/tools`).
- **Applied** (2026-10-06, oneezy/tools#107): `oneezy/skills` through `land/*`. `oneezy/brain` and `oneezy/tools`: by pull request, see oneezy/tools#107. `oneezy/ai-workflow` has no glossary of its own (no change). `layerdbiz/tridentcubed` not reached from the AI Workflow project: it needs root `CONTEXT-MAP.md` → `GLOSSARY-MAP.md` and each context's `CONTEXT.md` → `GLOSSARY.md`, then `skills/trident/oneezy-ui-component` in `oneezy/skills` names `packages/ui/GLOSSARY.md`.
