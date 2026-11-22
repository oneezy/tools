#!/usr/bin/env bash
# Sync Justin's skills from the library: one call to the latest published tool (ADR-0008), the skill's words mapped to its commands.
set -euo pipefail
case "${1:-}" in
  "") set -- --quiet ;;
  add) set -- "$@" --quiet ;;
esac
if [[ -n "${SKILLS_SYNC_CLI:-}" ]]; then
  [[ -f "$SKILLS_SYNC_CLI" ]] || { printf 'SKILLS_SYNC_CLI is not a built CLI file\n' >&2; exit 1; }
  exec node "$SKILLS_SYNC_CLI" "$@"
fi
exec npx --yes '@oneezy/skills-sync@latest' "$@"
