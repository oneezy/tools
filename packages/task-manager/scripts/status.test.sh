#!/usr/bin/env bash
# DRY_RUN scenarios for status.sh. A fake `gh` on PATH answers the reads status.sh makes (the
# project, one issue, one pull request, the board's items, the pull requests into a branch, a
# compare of two commits) from fixture files and refuses every write, so nothing reaches GitHub
# and a scenario that tries to write fails loudly.
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
# Fake gh for status.test.sh. Reads come from $FX; an issue with no fixture does not exist, as on GitHub (the
# same answer a pull request number gets); a mutation or any other command is refused.
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
      *"projectsV2(first:10)"*)
        [ ! -f "$FX/project-401" ] || { echo "gh: Bad credentials (HTTP 401)" >&2; exit 1; }
        printf 'PVT_1\t7\tPVTSSF_1\tTodo=o1,Next Up=o2,In Progress=o3,Review=o4,Done=o5,Complete=o6\n' ;;
      *"issue(number:"*)
        [ -f "$FX/issue-$number" ] || { echo "gh: Could not resolve to an Issue with the number of $number." >&2; exit 1; }
        cat "$FX/issue-$number" ;;
      *"pullRequest(number:"*) cat "$FX/pr-$number" ;;
      *"items(first:100"*) cat "$FX/items" 2>/dev/null || true ;;
      *) echo "fake gh: no fixture answers: $query" >&2; exit 1 ;;
    esac ;;
  "api repos/acme/widgets/compare/dev..."*)
    # Backfill's question: is this merge commit in dev? "behind" when a fixture says so.
    sha=${2##*...}
    if [ -f "$FX/in-dev-$sha" ]; then echo behind; else echo diverged; fi ;;
  "api repos/acme/widgets/compare/"*)
    [ ! -f "$FX/compare-missing" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    [ ! -f "$FX/compare-broken" ] || { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }
    page=$(printf '%s' "$2" | sed -nE 's/.*[?&]page=([0-9]+).*/\1/p')
    cat "$FX/compare-$page" 2>/dev/null || true ;;
  "api repos/acme/widgets/pulls?"*)
    base=$(printf '%s' "$2" | sed -nE 's/.*[?&]base=([^&]+).*/\1/p')
    page=$(printf '%s' "$2" | sed -nE 's/.*[?&]page=([0-9]+).*/\1/p')
    case "$2" in
      *state=all*) cat "$FX/pulls-all-$page" 2>/dev/null || true ;;
      *state=closed*) cat "$FX/pulls-$base-$page" 2>/dev/null || true ;;
      *) echo "fake gh: pulls without state=all or state=closed: $2" >&2; exit 1 ;;
    esac ;;
  "api repos/acme/widgets/branches?"*)
    page=$(printf '%s' "$2" | sed -nE 's/.*[?&]page=([0-9]+).*/\1/p')
    cat "$FX/branches-$page" 2>/dev/null || true ;;
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
# body <n> <text>: the pull request's body, the line linked_issues reads after the head branch.
body() { printf 'body:%s\n' "$2" >> "$FX/pr-$1"; }
# staged <base> <page> <n> <merge commit> [merged_at]: one closed pull request into <base>; no merged_at means unmerged.
staged() { printf '%s\t%s\t%s\n' "$3" "$4" "${5:--}" >> "$FX/pulls-$1-$2"; }
# commits <page> <total> <sha>...: one page of the compare PUSH_BEFORE...PUSH_AFTER (total_commits, then the SHAs).
commits() { local page=$1; shift; printf '%s\n' "$@" > "$FX/compare-$page"; }
# pull <n> <head> <base> <open|closed> <draft> <merged_at or -> <merge sha or -> [body]: one pull request of the
# repository, as backfill lists them; in_dev <sha> marks a merge commit dev holds; branch <name> is a pushed branch.
pull() { printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\tbody:%s\n' "$1" "$2" "$3" "$4" "$5" "$6" "$7" "${8:-}" >> "$FX/pulls-all-1"; }
in_dev() { touch "$FX/in-dev-$1"; }
branch() { printf '%s\n' "$1" >> "$FX/branches-1"; }
# item <item id> <status> <n> <state> <assignees>: one line of the whole-board listing.
item() { printf '%s\t%s\t%s\t%s\t%s\n' "$@" >> "$FX/items"; }
reset() { rm -f "$FX"/*; }

pass=0; fail=0
# check <rule> <expected line> VAR=value...: runs status.sh in DRY_RUN with the event and looks for the line in
# its output, which ends with "(exit <code>)" so a rule can expect the exit code too.
check() {
  local rule=$1 want=$2; shift 2
  local out rc=0
  out=$(env -i PATH="$work/bin:$PATH" HOME="${HOME:-}" FX="$FX" DRY_RUN=1 REPO=acme/widgets "$@" "$BASH" "$here/status.sh" 2>&1) || rc=$?
  out="$out"$'\n'"(exit $rc)"
  if printf '%s\n' "$out" | grep -qF -- "$want"; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$rule"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  wanted: %s\n  got:\n%s\n' "$rule" "$want" "$(printf '%s\n' "$out" | sed 's/^/    /')"
  fi
}
# refute <rule> <unwanted text> VAR=value...: the same run, passing when the text is nowhere in the output and the
# run exits 0.
refute() {
  local rule=$1 unwanted=$2; shift 2
  local out rc=0
  out=$(env -i PATH="$work/bin:$PATH" HOME="${HOME:-}" FX="$FX" DRY_RUN=1 REPO=acme/widgets "$@" "$BASH" "$here/status.sh" 2>&1) || rc=$?
  if [ "$rc" -eq 0 ] && ! printf '%s\n' "$out" | grep -qF -- "$unwanted"; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$rule"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  unwanted: %s\n  got (exit %s):\n%s\n' "$rule" "$unwanted" "$rc" "$(printf '%s\n' "$out" | sed 's/^/    /')"
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

# ---------------------------------------------------------------- a branch named after a number that is not an issue here (#170)
# The fake gh fails any read of an issue with no fixture, as GitHub does, so "(exit 0)" proves nothing was tried for it.

reset; pr 9 feat/153-hermes-rendering
check "a PR whose branch names a number that is not an issue here skips it" \
  "skipped #153: not an issue of acme/widgets (branch feat/153-hermes-rendering)" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true
check "and moves nothing for it, exiting 0" "(exit 0)" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true
check "ready for review skips it the same way" \
  "skipped #153: not an issue of acme/widgets (branch feat/153-hermes-rendering)" EVENT=pull_request ACTION=ready_for_review PR=9 PR_DRAFT=false

reset; pr 9 feat/153-hermes-rendering 3; issue 3 Todo
check "a closing reference beside such a branch is still moved" "would move #3: Todo -> In Progress" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true
check "merging such a PR still closes the closing reference" "would close #3 (merged into dev by #9)" EVENT=pull_request ACTION=closed PR=9 PR_MERGED=true PR_BASE=dev
check "and the run with both exits 0" "(exit 0)" EVENT=pull_request ACTION=closed PR=9 PR_MERGED=true PR_BASE=dev

reset; pr 9 fix/9-self
check "a branch named after a pull request number is skipped too" "skipped #9: not an issue of acme/widgets (branch fix/9-self)" EVENT=pull_request ACTION=opened PR=9 PR_DRAFT=true

reset
check "creating such a branch skips it" "skipped #153: not an issue of acme/widgets (branch feat/153-hermes-rendering)" EVENT=create REF_TYPE=branch REF=feat/153-hermes-rendering
check "and exits 0" "(exit 0)" EVENT=create REF_TYPE=branch REF=feat/153-hermes-rendering

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

# ---------------------------------------------------------------- a staging branch that reaches dev by a push (#251)
# Pull requests merge into next; next reaches dev as a fast-forward push. B is dev before the push, A after it.

land=(EVENT=push PUSH_REF=refs/heads/dev STAGING_BRANCH=next PUSH_BEFORE=bbbb PUSH_AFTER=aaaa)
merged=2026-11-27T12:00:00Z

reset; issue 21 Review; pr 31 feat/21-widget; staged next 1 31 c31 "$merged"; commits 1 1 c31
check "a push to dev that brings a PR merged into next closes its issue" "would close #21 (merged into dev by #31)" "${land[@]}"
check "and names the PR it landed" "landed #31: merged into next, now in dev" "${land[@]}"
check "and reports the count" "landed 1 pull request(s) from next on push to dev" "${land[@]}"
issue 21 Review CLOSED
check "and moves the closed issue to Done" "would move #21: Review -> Done" "${land[@]}"

reset; issue 22 Review; pr 32 feat/22-widget; staged next 1 32 c32 "$merged"; commits 1 1 c40
refute "a PR whose merge commit was already in dev before the push closes nothing" "#22" "${land[@]}"
check "and lands nothing" "landed 0 pull request(s) from next on push to dev" "${land[@]}"

reset; issue 23 Review; pr 33 feat/23-widget; staged next 1 33 c33; commits 1 1 c33
refute "an unmerged PR into next closes nothing, even when GitHub names a merge commit" "#23" "${land[@]}"

reset; issue 24 Review; pr 34 feat/24-widget; staged next 2 34 c34 "$merged"; commits 1 3 c1 c2; commits 2 3 c34
for i in $(seq 100 199); do staged next 1 "$i" "x$i"; done
check "every page of PRs into next and of the compare is read" "would close #24 (merged into dev by #34)" "${land[@]}"

reset; issue 25 Review; pr 35 feat/25-widget; staged next 1 35 c35 "$merged"; commits 1 1 c35
check "a push to dev without a staging branch moves nothing" "kept: push to refs/heads/dev is not main" EVENT=push PUSH_REF=refs/heads/dev PUSH_BEFORE=bbbb PUSH_AFTER=aaaa
check "a push to another branch with a staging branch moves nothing" "kept: push to refs/heads/next is not main or dev" EVENT=push PUSH_REF=refs/heads/next STAGING_BRANCH=next PUSH_BEFORE=bbbb PUSH_AFTER=aaaa
check "a new dev branch closes nothing" "kept: dev is a new branch, nothing to compare" EVENT=push PUSH_REF=refs/heads/dev STAGING_BRANCH=next PUSH_BEFORE=0000000000000000000000000000000000000000 PUSH_AFTER=aaaa
touch "$FX/compare-missing"
check "a rewritten dev that GitHub cannot compare closes nothing" "kept: GitHub cannot compare bbbb...aaaa" "${land[@]}"
rm "$FX/compare-missing"; touch "$FX/compare-broken"
check "any other compare failure stops the run" "status.sh: could not compare bbbb...aaaa" "${land[@]}"
check "with exit 1" "(exit 1)" "${land[@]}"

reset; pr 36 feat/26-widget; issue 26 Review
check "merging a PR into next says where its issues close" "kept: #36 merged into next; its issues close when next reaches dev" EVENT=pull_request ACTION=closed PR=36 PR_MERGED=true PR_BASE=next STAGING_BRANCH=next

# ---------------------------------------------------------------- closing keywords in a PR body (#251)
# GitHub fills closing references only for PRs into the default branch, so "Closes #n" on a PR into next links nothing.

reset; pr 37 chore/tidy; body 37 "Tidy the widget. Fixes: #27 and closes #99"; issue 27 "In Progress"
check "a body-only Closes #n on a PR into next links the issue" "would move #27: In Progress -> Review" EVENT=pull_request ACTION=opened PR=37 PR_DRAFT=false
check "a body number that is not an issue here is skipped" "skipped #99: not an issue of acme/widgets (body of #37)" EVENT=pull_request ACTION=opened PR=37 PR_DRAFT=false
issue 27 Review; staged next 1 37 c37 "$merged"; commits 1 1 c37
check "and the push that lands it closes the issue" "would close #27 (merged into dev by #37)" "${land[@]}"

reset; pr 38 chore/tidy; body 38 "RESOLVES #28, prefix#29, fixed  #30"; issue 28 Todo; issue 29 Todo; issue 30 Todo
check "closing keywords match in any case" "would move #28: Todo -> Review" EVENT=pull_request ACTION=opened PR=38 PR_DRAFT=false
check "and with more than one space" "would move #30: Todo -> Review" EVENT=pull_request ACTION=opened PR=38 PR_DRAFT=false
refute "a # joined to a word is not a closing keyword" "#29" EVENT=pull_request ACTION=opened PR=38 PR_DRAFT=false

reset; pr 39 chore/tidy 31; body 39 "Closes #32"; issue 31 Todo; issue 32 Todo
refute "the body is not read when GitHub gave closing references" "#32" EVENT=pull_request ACTION=opened PR=39 PR_DRAFT=false

# ---------------------------------------------------------------- a token gh refuses (#251)

reset; touch "$FX/project-401"
check "a refused token stops the run" "status.sh: gh could not read the GitHub project linked to acme/widgets" EVENT=issues ACTION=assigned ISSUE=3
check "with exit 1" "(exit 1)" EVENT=issues ACTION=assigned ISSUE=3
check "after printing gh's error" "gh: Bad credentials (HTTP 401)" EVENT=issues ACTION=assigned ISSUE=3

# ---------------------------------------------------------------- backfill from pull requests and branches (#253)

bf=(EVENT=workflow_dispatch BACKFILL=true)
m=2026-11-27T12:00:00Z

reset; item PVTI_41 Todo 41 OPEN 0; issue 41 Todo; pull 51 feat/41-widget dev closed false "$m" s51; in_dev s51
check "backfill closes an open ticket whose merged PR is in dev" "would close #41 (merged into dev by #51)" "${bf[@]}"
check "and moves it to Done" "would move #41: Todo -> Done" "${bf[@]}"

reset; item PVTI_42 Todo 42 OPEN 0; issue 42 Todo; pull 52 chore/tidy next closed false "$m" s52 "Tidy. Fixes: #42"; in_dev s52
check "a body Closes line links a PR whose branch names no ticket" "would close #42 (merged into dev by #52)" "${bf[@]}"

reset; item PVTI_43 Todo 43 OPEN 0; issue 43 Todo; pull 53 chore/tidy dev closed false "$m" s53 "Refs #43"; in_dev s53
refute "a Refs-only PR closes nothing" "would close #43" "${bf[@]}"
refute "and moves nothing" "would move #43" "${bf[@]}"

reset; item PVTI_44 Todo 44 OPEN 0; issue 44 Todo; pull 54 feat/44-widget next closed false "$m" s54
check "a PR merged into next, not in dev yet, is Review" "would move #44: Todo -> Review" STAGING_BRANCH=next "${bf[@]}"
refute "and is not closed" "would close #44" STAGING_BRANCH=next "${bf[@]}"

reset; item PVTI_45 Todo 45 OPEN 0; item PVTI_46 Review 46 OPEN 0; issue 45 Todo; issue 46 Review
pull 55 feat/45-widget next open false - -; pull 56 feat/46-widget next open true - -
check "an open ready PR is Review" "would move #45: Todo -> Review" "${bf[@]}"
check "an open draft PR is In Progress" "would move #46: Review -> In Progress" "${bf[@]}"

reset; item PVTI_47 Todo 47 OPEN 0; issue 47 Todo; pull 57 feat/47-widget dev closed false - s57; in_dev s57
refute "a closed, unmerged PR counts for nothing" "#47:" "${bf[@]}"

reset; item PVTI_48 Todo 48 OPEN 0; item PVTI_49 Review 49 OPEN 0; issue 48 Todo; issue 49 Review; branch feat/48-widget; branch feat/49-widget
check "a pushed numbered branch is In Progress" "would move #48: Todo -> In Progress" "${bf[@]}"
check "and never pulls Review back" "kept  #49 at Review (git work found)" "${bf[@]}"

reset; item PVTI_50 Done 50 OPEN 0; issue 50 Done OPEN needs-changes; printf '50\t0\tneeds-changes\n' > "$FX/open-issues"; pull 60 feat/50-widget dev closed false "$m" s60; in_dev s60
refute "a reopened needs-changes ticket is not closed by its old PR" "would close #50" "${bf[@]}"

reset; item PVTI_61 Review 61 CLOSED 0; issue 61 Review CLOSED; pull 62 feat/61-widget dev closed false "$m" s62; in_dev s62
check "a closed ticket keeps today's rule" "would move #61: Review -> Done" "${bf[@]}"
refute "and is not closed again" "would close #61" "${bf[@]}"

reset; printf '63\t0\t-\n' > "$FX/open-issues"; issue 63 -; pull 64 feat/63-widget next open false - -
check "an open issue missing from the board takes its git Status" "would move #63: - -> Review" "${bf[@]}"

reset; item PVTI_65 Todo 65 OPEN 0; issue 65 Todo OPEN phase; printf '65\t0\tphase\n' > "$FX/open-issues"; pull 66 feat/65-widget dev closed false "$m" s66; in_dev s66
refute "a phase is never closed" "#65" "${bf[@]}"

reset; item PVTI_67 Todo 67 OPEN 0; issue 67 Todo; pull 68 feat/67-widget dev closed false "$m" s68; in_dev s68
for i in $(seq 200 299); do printf '%s\tchore/x\tdev\tclosed\tfalse\t-\t-\tbody:\n' "$i" >> "$FX/pulls-all-1"; done
mv "$FX/pulls-all-1" "$FX/pulls-all-tmp"; tail -n 100 "$FX/pulls-all-tmp" > "$FX/pulls-all-1"; head -n 1 "$FX/pulls-all-tmp" > "$FX/pulls-all-2"; rm "$FX/pulls-all-tmp"
check "every page of pull requests is read" "would close #67 (merged into dev by #68)" "${bf[@]}"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
