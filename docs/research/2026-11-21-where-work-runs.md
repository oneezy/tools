# Where work runs: speed test

Date: 2026-11-21. Run in layerdbiz/tridentcubed; copied here because Justin's global rule "Where work runs" (`AGENTS-GLOBAL.md`) points at it.

## Question

Which way gets a small change in front of Justin fastest: one branch on his PC, worktrees on his PC, or cloud threads?

## Method

The same three tiny changes, done three ways, each merged into `dev` and live. Time spent waiting for Justin's PC or his yes is not counted.

## Results

| Step | One branch (PC) | Worktrees (PC) | Cloud (3 threads) |
| --- | --- | --- | --- |
| Setup before work starts | 0:01 | 0:03 | 0:25 |
| Change 1 visible to him | 0:02 | 0:33 | 3:23 |
| Change 2 visible to him | 0:09 | 0:37 | 3:12 |
| Change 3 visible to him | 0:10 | 0:33 | 4:59 |
| All three merged | 2:17 | 5:23 | 4:31 |
| Checks and live | 0:45 | 0:34 | 0:28 |
| Total, ask to live | 3:02 | 5:57 | 4:59 |
| Times it needed him | 1 | 0 | 0 |

- **One branch**: the desktop app's push guard refused the push until Justin typed his yes.
- **Worktrees**: 2:47 went to a local check and build that repeats GitHub's checks and trips Windows-only failures.
- **Cloud**: one GitHub check started 2 minutes late; without it, about 3:15. In the cloud, "visible" means live on the dev site. Checks now start on the push, so that delay should be gone.

## Conclusion

One branch on the PC is fastest for look-and-feel work Justin watches change by change. The cloud runs several pieces of work at once with no need for him. PC worktrees are slowest and are dropped.
