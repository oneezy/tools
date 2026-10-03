#!/usr/bin/env bash
# DRY_RUN scenarios for status.sh. A fake `gh` on PATH answers the reads status.sh makes (the
# project, one issue, one pull request, the board's items) from fixture files and refuses every
# write, so nothing reaches GitHub and a scenario that tries to write fails loudly.
#   bash packages/task-manager/scripts/status.test.sh          (pnpm test runs it)
# Each check names the rule, the expected line of output, then the event as environment variables.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/fx"
export FX="$work/fx"

cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Fake gh for status.test.sh. Reads come from $FX; a mutation or any other command is refused.
set -eu
number=""; query=""
args=("$@")
for ((i = 0; i < ${#args[@]} - 1; i++)); do
  case "${args[$i]}" in -F|-f)
    case "${args[$((i + 1))]}" in number=*) number=${args[$((i + 1))]#number=} ;; query=*) query=${args[$((i + 1))]#query=} ;; esac ;;
  esac
done
case "${1:-} ${2:-}" in
  "api graphql")
    case "$query" in
      *mutation*) echo "fake gh: write refused: $query" >&2; exit 1 ;;
      *"projectsV2(first:10)"*) printf 'PVT_1\t7\tPVTSSF_1\tTodo=o1,Next Up=o2,In Progress=o3,Review=o4,Done=o5,Complete=o6\n' ;;
      *"issue(number:"*) cat "$FX/issue-$number" 2>/dev/null || printf -- '-\t-\tOPEN\tI_%s\t-\t0\n' "$number" ;;
      *"pullRequest(number:"*) cat "$FX/pr-$number" ;;
      *"items(first:100"*) cat "$FX/items" 2>/dev/null || true ;;
      *) echo "fake gh: no fixture answers: $query" >&2; exit 1 ;;
    esac ;;
  "issue list") cat "$FX/open-issues" 2>/dev/null || true ;;
  "repo view") printf 'acme/widgets\n' ;;
  *) echo "fake gh: write refused: gh $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/gh"

# issue <n> <status> [state] [labels] [assignees]: one board item; status "-" means not on the board.
issue() {
  local item="PVTI_$1"; [ "$2" != "-" ] || item="-"
  printf '%s\t%s\t%s\tI_%s\t%s\t%s\n' "$item" "$2" "${3:-OPEN}" "$1" "${4:--}" "${5:-0}" > "$FX/issue-$1"
}
# pr <n> <head branch> [closing issue numbers...]: what linked_issues reads.
pr() {
  local n=$1 head=$2; shift 2
  { for c in "$@"; do printf '%s\n' "$c"; done; printf '%s\n' "$head"; } > "$FX/pr-$n"
}
# item <item id> <status> <n> <state> <assignees>: one line of the whole-board listing.
item() { printf '%s\t%s\t%s\t%s\t%s\n' "$@" >> "$FX/items"; }
reset() { rm -f "$FX"/*; }

pass=0; fail=0
# check <rule> <expected line> VAR=value...: runs status.sh in DRY_RUN with the event and looks for the line.
check() {
  local rule=$1 want=$2; shift 2
  local out
  if ! out=$(env -i PATH="$work/bin:$PATH" HOME="${HOME:-}" FX="$FX" DRY_RUN=1 REPO=acme/widgets "$@" "$BASH" "$here/status.sh" 2>&1); then
    out="$out"$'\n'"(exit $?)"
  fi
  if printf '%s\n' "$out" | grep -qF -- "$want"; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$rule"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  wanted: %s\n  got:\n%s\n' "$rule" "$want" "$(printf '%s\n' "$out" | sed 's/^/    /')"
  fi
}

# ---------------------------------------------------------------- draft pull requests (#77 rule 4)

reset; pr 9 feature/4-widget 3; issue 3 Todo; issue 4 "Next Up"
check "draft PR opened moves a closing reference from Todo to In Progress" \
  "would move #3: Todo -> In Progress" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true
check "draft PR opened moves the branch's issue from Next Up to In Progress" \
  "would move #4: Next Up -> In Progress" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true

reset; pr 9 feature/5-widget; issue 5 -
check "draft PR opened moves an issue with no Status to In Progress" \
  "would move #5: - -> In Progress" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true

reset; pr 9 feature/6-widget; issue 6 Review
check "draft PR opened never pulls an issue back from Review" \
  "kept  #6 at Review (In Progress is only reached from: - Todo Next Up)" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true

reset; pr 9 feature/3-widget; issue 3 "In Progress"
check "ready for review still moves the linked issue to Review" \
  "would move #3: In Progress -> Review" EVENT=pull_request ACTION=ready_for_review PR=9 PR_DRAFT=false
check "a PR opened ready (not draft) moves the linked issue to Review" \
  "would move #3: In Progress -> Review" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=false

# ---------------------------------------------------------------- the start event (#77 rule 4)

reset; issue 3 Todo; issue 4 "Next Up"; issue 5 -; issue 6 Review; issue 7 Done; issue 8 Done CLOSED
check "start moves an issue from Todo to In Progress" "would move #3: Todo -> In Progress" EVENT=start ISSUE=3
check "start moves an issue from Next Up to In Progress" "would move #4: Next Up -> In Progress" EVENT=start ISSUE=4
check "start moves an issue with no Status to In Progress" "would move #5: - -> In Progress" EVENT=start ISSUE=5
check "start keeps an issue in Review" "kept  #6 at Review (In Progress is only reached from: - Todo Next Up)" EVENT=start ISSUE=6
check "start keeps an open issue in Done" "kept  #7 at Done (In Progress is only reached from: - Todo Next Up)" EVENT=start ISSUE=7
check "start keeps a closed issue" "kept  #8: closed, only Done or Complete may move a closed issue" EVENT=start ISSUE=8
check "workflow_dispatch start=<n> is the start event" "would move #3: Todo -> In Progress" EVENT=workflow_dispatch START=3
check "workflow_dispatch with neither backfill nor start moves nothing" "kept: dispatch without backfill or start" EVENT=workflow_dispatch BACKFILL=false

reset; issue 10 Todo OPEN phase
check "start never moves a phase" "kept  #10: maps and phases are never moved" EVENT=start ISSUE=10

# ---------------------------------------------------------------- the rules that must not change (#7 section 3)

reset; issue 3 Todo; issue 4 "Next Up"
check "assigned moves Todo to Next Up" "would move #3: Todo -> Next Up" EVENT=issues ACTION=assigned ISSUE=3
check "assigned keeps Next Up" "kept  #4 at Next Up" EVENT=issues ACTION=assigned ISSUE=4

reset; issue 3 "Next Up"
check "unassigning the last assignee returns the ticket to Todo" "would move #3: Next Up -> Todo" EVENT=issues ACTION=unassigned ISSUE=3

reset; issue 3 Todo
check "a numbered branch moves its issue to In Progress" "would move #3: Todo -> In Progress" EVENT=create REF_TYPE=branch REF=feature/3-widget
check "a tag moves nothing" "kept: tag v1.0 is not a branch" EVENT=create REF_TYPE=tag REF=v1.0
check "a branch without a number moves nothing" "kept: branch chore/tidy names no issue" EVENT=create REF_TYPE=branch REF=chore/tidy

reset; pr 9 research/8-topic; issue 8 "In Progress" OPEN wayfinder:research
check "research never goes to Review" "kept  #8: wayfinder:research never goes to Review" EVENT=pull_request ACTION=ready_for_review PR=9 PR_DRAFT=false

reset; pr 9 feature/3-widget; issue 3 Review
check "converted to draft returns Review to In Progress" "would move #3: Review -> In Progress" EVENT=pull_request ACTION=converted_to_draft PR=9
check "changes requested returns Review to In Progress" "would move #3: Review -> In Progress" EVENT=pull_request_review ACTION=submitted PR=9 REVIEW_STATE=changes_requested
check "an approving review moves nothing" "kept: review approved on #9 moves nothing" EVENT=pull_request_review ACTION=submitted PR=9 REVIEW_STATE=approved

reset; pr 9 feature/3-widget; issue 3 Review
check "merging into dev closes the linked issue" "would close #3 (merged into dev by #9)" EVENT=pull_request ACTION=closed PR=9 PR_MERGED=true PR_BASE=dev
check "merging into main is not Done" "kept: #9 merged into main, not dev" EVENT=pull_request ACTION=closed PR=9 PR_MERGED=true PR_BASE=main
check "closing a PR without merging moves nothing" "kept: #9 closed without merging" EVENT=pull_request ACTION=closed PR=9 PR_MERGED=false PR_BASE=dev

reset; issue 3 Done OPEN needs-changes
check "reopened with needs-changes returns to In Progress" "would move #3: Done -> In Progress" EVENT=issues ACTION=reopened ISSUE=3
check "labelling needs-changes returns to In Progress" "would move #3: Done -> In Progress" EVENT=issues ACTION=labeled ISSUE=3 LABEL=needs-changes
check "another label moves nothing" "kept  #3: label bug moves nothing" EVENT=issues ACTION=labeled ISSUE=3 LABEL=bug

reset; item PVTI_3 Done 3 CLOSED 0; item PVTI_4 Todo 4 OPEN 0
check "a push to main promotes every Done item" "would move #3: Done -> Complete" EVENT=push PUSH_REF=refs/heads/main
check "a push to main reports the count" "promoted 1 item(s) to Complete on push to main" EVENT=push PUSH_REF=refs/heads/main
check "a push to another branch promotes nothing" "kept: push to refs/heads/dev is not main" EVENT=push PUSH_REF=refs/heads/dev

reset; item PVTI_3 Todo 3 OPEN 1; item PVTI_4 Review 4 CLOSED 0; item PVTI_5 - 5 OPEN 0
printf '6\t0\n' > "$FX/open-issues"; issue 6 -
check "backfill moves an assigned Todo to Next Up" "would move #3: Todo -> Next Up" EVENT=workflow_dispatch BACKFILL=true
check "backfill moves a closed item to Done" "would move #4: Review -> Done" EVENT=workflow_dispatch BACKFILL=true
check "backfill gives an unassigned item with no Status Todo" "would move #5: - -> Todo" EVENT=workflow_dispatch BACKFILL=true
check "backfill adds open issues missing from the board" "would move #6: - -> Todo" EVENT=workflow_dispatch BACKFILL=true

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
