# Skills Sync Instructions audit

This is source development for a held rollout, not a release, cloud upload or desktop execution. The source checkout starts at Skills PR 56, `76a8ec9b62368a3624f27a29c101c2434042bd61`; the tool starts at tools/dev, `992bf6315b67405b0c970f4ce912f9be0eb4017b`. PR 56, tools PR 114 and the separate dirty Brain checkout were inspected and preserved. No scheduled brief, workbook cell, installed cloud skill, upstream Matt/PStack source or historical Space was edited.

## Method and placement

The actual installed `matt-pocock:writing-for-agents` skill and its full `SKILL-MECHANICS.md` examples were loaded from `matt-pocock@created-by-me-remote`, version `0.25.0+05c4d1dd0761`, `skills/writing-for-agents/`. The locked source is `mattpocock/skills@321658273cb1d20b76026717d027d505790106d4`, `skills/productivity/writing-for-agents/`. Both were read, not reconstructed from a summary.

The available source router `ask-matt`, setup skill, `grilling` and `grill-with-docs` were read; Wayfinder was inspected. The router's focused domain-document path fits this scoped repository problem. The actual `domain-modeling` skill was loaded alongside writing-for-agents. No new router skill was invented and no upstream setup was rerun. Skill Creator, Plugin Management and Plugin Creator update instructions were also loaded for the relevant source and delivery branches.

Matt's explicit context-pointer branches move detailed business rules into named references while keeping common actions inline. All eight authored Oneezy entrypoints were inventoried first. The preservation inventory and rule hashes accompany behavior-focused tests; Estimate, Merge and Remote remain user-only. Unslop did not restructure these artifacts.

Repository guidance already places operational references under `docs/agents/`, while GLOSSARY.md defines domain terms. Therefore `docs/agents/capabilities.md` is the short capability pointer; `capabilities/contract.md`, three host adapters and `catalog.json` carry the maintained workflow. GLOSSARY adds four definitions. AGENTS retains its existing issue, triage and domain instructions and points to the moved library instructions. There was no root CLAUDE.md to replace. Packaged reference copies are generated from the repository source, with drift checks; they are not separate authored authorities.

## History and inventory

Bounded file history was inspected instead of assuming previous slimming. Oneezy Skills grew from 363 words on September 30 through 479, 765 and 804 to 1,645/1,667 on October 6/dev. No matching slimming/writing commit was found in the inspected history. Existing PR 56 had already shortened Brain from 929 to 484 words; that draft change was retained. These findings do not claim that no skill was ever shortened elsewhere. The before/after counts in `2026-10-07-oneezy-instruction-inventory.json` use PR 56 as their exact baseline.

The paginated installed catalog contained 223 skills, including distinct standalone `oneezy-meeting` (`skill-6abd4e4f25b08191acd8a13b62f68df6`) and bundled `oneezy:oneezy-meeting` (`oneezy@created-by-me-remote`, `0.37.0+ae30f295de4f`). The standalone source-routing/capability references still define GitHub Brain and permit fallback. Its advertised flow resource was unavailable. The bundled flow and PR 56 source both contained the read-only GitHub fallback contradiction; the owned source flow is corrected. Refreshing the bundle alone cannot fix the standalone delivery. A later authorized delivery must resolve that exact skill's source/backend identity, then refresh it from the canonical Meeting source or separately approve retirement. No deletion, recreation or unrelated publication was performed.

## Capability evidence

The canonical rollout Page, installed Brain skill, current private Drive registry, workflow Doc and bounded workbook schema/List ranges were read through their actual connector instructions. Inbox and Backlog remain canonical writable data; Personal and Work are read-only views. No cells were changed. The runtime catalog records exact dependencies, conditional historical Pages, current discovery routes and unknown coverage. Private Oneezy public dependency lookup returned `plugin_not_found`; this is not proof that the installed private plugin is absent or access denied.

Actual CLI help was captured for Codex 0.161.0 and Claude Code 2.1.293 under `2026-10-07-host-help/`. Interactive `/plugins` and `/plugin` differ from shell `codex plugin` and `claude plugin`. Local links and CLI installation are distinct from account upload. No host plugin was installed or updated during this source-only review. A ChatGPT cloud terminal upload route remains unsupported/unproven.

The live Plugin Creator `update_plugin` schema was inspected on October 7. It accepts exact existing plugin-root-relative `delete_paths`, not directories/globs, and requires `expected_release_id`. Uploaded and deleted paths cannot overlap; omitted files otherwise persist. Obsolete cannot-delete/reinstall advice is corrected in both library documentation and Skills Sync artifact notes. Deletion still requires explicit approval of the exact paths; release mismatch requires a fresh inventory/review, not an unguarded retry.

## Verification and remaining environments

The tool's focused I/O test creates a file where the first destination's parent directory should be. The write fails, its dependent copy stays blocked, and an independent instruction destination completes. Another test makes one project unavailable during instruction discovery and verifies that the healthy project's instructions still complete. Failed actions remain reported and produce failure status; the failure is not silently treated as success.

Tool tests passed: 97 passed, two existing skips. Source capability tests passed: five. Existing release script tests passed: six. Canonical frozen refresh, build and check succeeded with no unlocked/gone sources, no check problems and no upstream plugin changes. Exact final commands, commits and build results belong in the handoff document. `scripts/verify-oneezy-sync.mjs` makes the wrapper fixture verification reproducible with the reviewed `SKILLS_SYNC_CLI` override; its Windows branch has not been executed here.

The canonical `sync.sh`, with the reviewed local tool override, executed plan/apply/repeat/status against a Linux fixture. Its actual changed paths were `/workspace/scratch/edcbf3aedf22/entrypoint-verification/fixture/AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` and `src/CLAUDE.local.md`. Readback was current, the repeat made zero instruction writes, and pinned history, imports, CRLF and unrelated dirty content were preserved. These are test fixtures, not desktop files.

The current execution surface has no native app/connected-computer filesystem route. Justin's Windows desktop, its selected repositories and WSL distributions could not be inspected or executed; exact desktop paths and distribution inventory remain pending the existing authorized desktop task. PowerShell execution, fresh desktop agent loading and desktop Drive access remain unverified. The handoff must use the source-controlled script, not manual entrypoint patches.

Automatic approval review rejected `claude plugin validate` because the CLI could transmit local plugin source to Anthropic. That route was stopped and not retried. Local schema/source/build checks continued. No approval or access denial was bypassed.
