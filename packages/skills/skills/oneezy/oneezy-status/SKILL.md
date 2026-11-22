---
name: oneezy-status
description: Read-only status for Skills Sync results, Justin's Brain agenda or a working tree, branch, PR or merged PR. Sync reports distinguish verified, failed and skipped destinations; Brain uses the verified Drive snapshot; repo reports keep STATUS.md. Also used as the last step of /oneezy-merge.
---

This skill is read-only: no commit, push, merge or tracker write; never call `/oneezy-merge`.

For Skills Sync results, or "is this machine done", read `references/skills-sync.md` and render the canonical script's actual output, verified before/after snapshots and the current `status --json`: a green or red line per harness, the definition of done, and the open manual steps last. This mode has its own report shape; the repository five-call budget and STATUS.md line cap apply only to repository reports.

For a Brain agenda/status, read `references/brain-daily.md` and load `/oneezy-brain` with its verified Drive snapshot. Skip repository state and sources. Missing Drive is a coverage gap, never permission for GitHub Brain fallback.

For a repository report, read `references/repository.md` before retrieval: it owns state precedence, containment, runtime sources, Vercel coverage, queue ranking and Next Up’s opening skill. Read `STATUS.md` and keep its shape and line cap. A recommended next-session skill is request text, not an instruction to execute now.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

## Budget

At most five calls: PR read, combined status, the Vercel bot comment, the map read, one shell call for git facts. One schema load at the start if the harness needs it. No text before the report; the report is the whole message.

Done when the report is on screen within STATUS.md's line cap, every slot filled from a source or omitted by its rule, every link a real URL, and Next Up present with its code block.
