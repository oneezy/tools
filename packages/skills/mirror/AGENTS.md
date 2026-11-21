# AGENTS.md

This repository is the release mirror of oneezy/tools `packages/skills` (ADR-0021). Make every change there, through a pull request into tools `dev`; `packages/skills/scripts/publish-mirror.mjs` publishes each release here through a `land/mirror-<sha>` branch, which `.github/workflows/land.yml` squashes into `dev`, promotes to `main` and releases. A commit made here by hand is overwritten by the next mirror run.

Changes to `.github/` are the exception: the mirror leaves them alone, so they go through a pull request here that Justin merges.

### Issue tracker

Issues are tracked on oneezy/tools (its `docs/agents/issue-tracker.md`). Issue links into oneezy/skills are history.
