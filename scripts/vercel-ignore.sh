#!/usr/bin/env bash
# Vercel's ignore step for apps/skills-viewer-web (run from that folder): exit 0 skips the
# deploy, exit 1 builds. Builds whenever the app, its engine or the workspace files changed
# since the last deployment, and whenever that cannot be told (no previous commit in the
# clone, for one after a force-push).
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
git cat-file -e "$base^{commit}" 2>/dev/null || exit 1
git diff --quiet "$base" HEAD -- . ../../packages/skills-viewer ../../package.json \
  ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ../../vite.config.ts && exit 0
exit 1
