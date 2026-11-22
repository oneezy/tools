# ADR-0013: Branches are cleaned up daily by rule; main, dev, `-keep`, `research/` and `prototype/` branches are never deleted

Date: 2026-10-11. Status: accepted. Decided in the Skills Sync repair grilling of 2026-10-10 (branch-cleanup card, Q12, Q12b, Q12c, Q16, Q16b).

## Context

The 2026-10-10 audit found 32 of 41 branches merged or duplicated. Cloud threads cannot delete branches or push tags (HTTP 403), so cleanup piled up waiting for a person.

## Decision

- `main` and `dev` are never deleted, by anyone or anything.
- A branch whose name ends in `-keep` is never deleted, nor any branch whose name starts with `research/` or `prototype/` (Justin, 2026-10-11: research and prototype work is kept, merged or not). The suffix and the two prefixes are the only keep markers, matched exactly.
- A branch merged into dev is deleted. A branch closed without merging is tagged `archive/<name>`, then deleted. Pull requests are never deleted.
- The logic is `npx @oneezy/skills-sync branches` (with `--plan`), so it runs anywhere without adding files to each repository. One scheduled workflow in oneezy/tools runs it daily across Justin's repositories, using a token stored as an encrypted repository secret, never committed.
- Repositories outside the token's reach (layerdbiz) wait until a token covers them.
