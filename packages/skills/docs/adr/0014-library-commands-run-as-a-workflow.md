# ADR-0014: Library commands run as a "run now" workflow, so any session can ask for them

Date: 2026-10-11. Status: accepted. Decided in the Skills Sync repair grilling of 2026-10-10 (Q18, Q18b).

## Decision

- The machine commands are `sync`, `status`, `hook`, `branches` and `unlink`, with `--plan`, `--json` and `--quiet`. Older flags are accepted and ignored with a warning.
- The library commands (`update`, `add`, `versions`, `rename`) run in a manually dispatched workflow in oneezy/skills that lands any change through `land/*` with no review. A cloud thread, which has no library checkout, asks for them by dispatching that workflow, so a change happens as soon as Justin says it.
