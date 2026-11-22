# ADR-0009: Third-party sources follow their upstream by a daily check

Date: 2026-10-11. Status: accepted. Supersedes ADR-0005's "Nothing moves upstream on its own" and its asked-for-only updates; the lock, holds and reports of ADR-0005 stand. Decided in the Skills Sync repair grilling of 2026-10-10 (Q4 addendum, Q11).

## Context

Updates only ran when asked, and the `library.yml` refresh job was manual-only ("no schedule, ever"). By 2026-10-10 the library sat at Matt Pocock 1.3.1 with upstream main 41 commits ahead, and nobody had noticed. GitHub cannot fire a workflow here from a push to someone else's repository, so a listener is not available; a schedule is.

## Decision

- A scheduled workflow in oneezy/skills checks every source each day against the tip of the `ref` it follows (and its upstream version), and lands any change, a major version included, through `land/*` into dev, then main and a release, with no one by hand.
- A `version` in the config still holds a source on purpose; the daily check leaves a held source alone.
- Versions shown for third-party plugins are their upstream versions (ADR-0006), so the library's numbers match the upstream repository's.
- Each landed update still reports old and new version and the upstream changelog, and `/oneezy-migrate` runs on any migration note.
