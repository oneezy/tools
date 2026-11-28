#!/usr/bin/env bash
# Move issues' Status on the repo's GitHub Project from one git event.
# Driven by .github/workflows/task-manager.yml (this repo hosts it; other repos call it). Every input is an environment variable, so it runs
# by hand too:   REPO=oneezy/tools EVENT=issues ACTION=assigned ISSUE=17 DRY_RUN=1 packages/task-manager/scripts/status.sh
#
# Inputs (env):
#   REPO                owner/name (default: the current clone)
#   EVENT               issues | create | pull_request | pull_request_review | push | start | workflow_dispatch
#   ACTION              the event's action: assigned unassigned reopened labeled opened ready_for_review
#                       converted_to_draft closed submitted
#   ISSUE               issue number                      (issues, start)
#   LABEL               the label just added              (issues labeled)
#   REF_TYPE, REF       "branch" and the branch name      (create)
#   PR                  pull request number               (pull_request, pull_request_review)
#   PR_BASE             the pull request's base branch    (pull_request)
#   PR_DRAFT            true | false                      (pull_request)
#   PR_MERGED           true | false                      (pull_request closed)
#   REVIEW_STATE        approved | changes_requested | commented   (pull_request_review)
#   PUSH_REF            refs/heads/<branch>               (push)
#   PUSH_BEFORE, PUSH_AFTER  the branch's commit before and after the push   (push)
#   START               issue number to move to In Progress               (workflow_dispatch)
#   BACKFILL            true recomputes every board item from git facts   (workflow_dispatch)
#   INTEGRATION_BRANCH  merging into it closes the linked issues; default dev
#   RELEASE_BRANCH      pushing to it moves Done to Complete; default main
#   STAGING_BRANCH      pull requests merge into it first and reach INTEGRATION_BRANCH by a push; empty by default
#   DRY_RUN             1 prints every move and writes nothing
#
# The rules, decided on oneezy/tools#7 (section 3):
#   issue assigned                       -> Next Up      from Todo or no Status
#   issue unassigned, nobody left        -> Todo         from Next Up, In Progress, Review
#   branch <type>/<n>-<slug> created     -> In Progress  from Todo, Next Up or no Status
#   start (EVENT=start, or a dispatch with start=<n>)  -> In Progress  from Todo, Next Up or no Status;
#                                           the line an agent runs when it begins a ticket with no numbered branch
#   PR opened as a draft                 -> In Progress  for its linked issues, from Todo, Next Up or no Status
#   PR opened (not draft) or ready       -> Review       for its linked issues, skipping wayfinder:research
#   PR to draft, or changes requested    -> In Progress  from Review
#   PR merged into INTEGRATION_BRANCH    -> the linked issues are closed (needs-changes removed), then Done
#   push to INTEGRATION_BRANCH, with STAGING_BRANCH set
#                                        -> the same close and Done for every PR merged into STAGING_BRANCH whose
#                                           merge commit the push brings (in PUSH_BEFORE...PUSH_AFTER); a push with no
#                                           earlier commit (new branch) or one GitHub cannot compare (rewritten) closes nothing
#   push to RELEASE_BRANCH               -> Complete     for every Done item
#   issue reopened or labeled needs-changes  -> In Progress
#   backfill                             -> closed: Done; open and assigned: Next Up from Todo or none;
#                                           open and unassigned with no Status: Todo; everything else kept
# A PR's linked issues are its closing references plus the issue its branch is named after, when that number is an
# issue of this repository: a branch named after another repo's issue or after a pull request is skipped, not failed on.
# GitHub fills closing references only for PRs into the default branch, so when a PR has none, "Closes #n" (also
# close/closed, fix/fixes/fixed, resolve/resolves/resolved, any case, optional colon) in its body counts, checked the
# same way as the branch's number.
# Closed issues are never moved except to Done or Complete; wayfinder maps and phases are never moved.
# Milestones are never touched: a task joins a phase by taking the phase's Milestone (oneezy/tools#77).
# Needs: gh with a token that can write the project (PROJECT_PAT in CI). No jq: gh's --jq does the parsing.
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { echo "status.sh: $*" >&2; exit 1; }

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
INTEGRATION_BRANCH="${INTEGRATION_BRANCH:-dev}"
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
STAGING_BRANCH="${STAGING_BRANCH:-}"
DRY_RUN="${DRY_RUN:-}"
export NAME

# ---------------------------------------------------------------- the project

# The open project linked to the repo: the one titled after the repo when there is one, else the first.
# The read is captured before it is split, so a refused token stops the run here instead of leaving an empty project.
load_project() {
  local row
  row=$(gh api graphql -f owner="$OWNER" -f name="$NAME" -f query='
      query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
        projectsV2(first:10){ nodes{ id number title closed
          field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } } }' \
      --jq '([.data.repository.projectsV2.nodes[] | select(.closed|not)] | (map(select(.title==$ENV.NAME)) + .)[0]) as $p
            | if $p == null then ["-","-","-","-"]
              else [$p.id, $p.number, $p.field.id, ($p.field.options | map(.name+"="+.id) | join(","))] end
            | @tsv') ||
    die "gh could not read the GitHub project linked to $REPO (see the gh error above); GH_TOKEN, PROJECT_PAT in CI, must be a valid classic token with the repo and project scopes"
  IFS=$'\t' read -r PROJECT_ID PROJECT_NUMBER STATUS_FIELD OPTIONS <<<"$row"
  [ "$PROJECT_ID" != "-" ] || die "no open GitHub project is linked to $REPO"
  export PROJECT_ID
}

option_id() {
  local id
  id=$(printf '%s\n' "$OPTIONS" | tr ',' '\n' | grep -E "^$1=" | cut -d= -f2 || true)
  [ -n "$id" ] || die "the project has no Status option \"$1\""
  printf '%s' "$id"
}

# issue_info <n>: item_id, status, state, node_id, labels (csv), assignee count. "-" where empty.
issue_info() {
  gh api graphql -f owner="$OWNER" -f name="$NAME" -F number="$1" -f query='
    query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){
      issue(number:$number){ id state
        labels(first:30){ nodes{ name } }
        assignees(first:10){ totalCount }
        projectItems(first:10){ nodes{ id project{ id }
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } }' \
    --jq '.data.repository.issue as $i
          | ([$i.projectItems.nodes[] | select(.project.id==$ENV.PROJECT_ID)][0]) as $it
          | [ ($it.id // "-"), ($it.fieldValueByName.name // "-"), $i.state, $i.id,
              ([$i.labels.nodes[].name] | join(",") | if . == "" then "-" else . end),
              $i.assignees.totalCount ]
          | @tsv'
}

add_item() {
  gh api graphql -f project="$PROJECT_ID" -f content="$1" -f query='
    mutation($project:ID!,$content:ID!){
      addProjectV2ItemById(input:{projectId:$project,contentId:$content}){ item{ id } } }' \
    --jq .data.addProjectV2ItemById.item.id
}

set_status() {
  gh api graphql -f project="$PROJECT_ID" -f item="$1" -f field="$STATUS_FIELD" -f option="$2" -f query='
    mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
      updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,
        value:{singleSelectOptionId:$option}}){ projectV2Item{ id } } }' --jq .data.updateProjectV2ItemFieldValue.projectV2Item.id >/dev/null
}

# move <n> <to> [<from>...]: set Status to <to> when the current Status is one of <from>; "-" means
# no Status yet; no <from> means from anywhere. Adds the issue to the board when it is missing.
move() {
  local n=$1 to=$2; shift 2
  local item status state node labels assignees info
  info=$(issue_info "$n") || die "could not read #$n"
  IFS=$'\t' read -r item status state node labels assignees <<<"$info"
  case ",$labels," in *,wayfinder:map,*|*,phase,*)
    say "kept  #$n: maps and phases are never moved"; return 0 ;; esac
  if [ "$state" = "CLOSED" ] && [ "$to" != "Done" ] && [ "$to" != "Complete" ]; then
    say "kept  #$n: closed, only Done or Complete may move a closed issue"; return 0
  fi
  if [ $# -gt 0 ]; then
    local ok="" f
    for f in "$@"; do [ "$status" = "$f" ] && ok=1; done
    if [ -z "$ok" ]; then say "kept  #$n at $status ($to is only reached from: $*)"; return 0; fi
  fi
  if [ "$status" = "$to" ]; then say "kept  #$n at $to"; return 0; fi
  if [ -n "$DRY_RUN" ]; then say "would move #$n: $status -> $to"; return 0; fi
  if [ "$item" = "-" ]; then item=$(add_item "$node"); say "added #$n to the board"; fi
  set_status "$item" "$(option_id "$to")"
  say "moved #$n: $status -> $to"
}

has_label() { # has_label <n> <label>
  local labels
  labels=$(issue_info "$1") || die "could not read #$1"
  labels=$(printf '%s\n' "$labels" | cut -f5)
  case ",$labels," in *,"$2",*) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------- pull requests and branches

branch_issue() { # branch_issue <ref>: the n in <type>/<n>-<slug>, or nothing
  printf '%s\n' "$1" | sed -nE 's#^[A-Za-z][A-Za-z0-9_-]*/([0-9]+)(-.*)?$#\1#p'
}

# is_issue <n>: true when #n is an issue of REPO, open or closed, that is, when issue_info can read it. A branch may
# be named after an issue of another repository or after a pull request; GraphQL's issue(number:) answers "Could not
# resolve to an Issue" for both, which would otherwise fail the run. Any other failure (token, network) still stops it.
is_issue() {
  local err
  err=$(issue_info "$1" 2>&1 >/dev/null) && return 0
  case "$err" in *"Could not resolve to an Issue"*) return 1 ;; esac
  die "$err"
}

skip_branch() { # skip_branch <n> <ref>: the line for a branch number that is not an issue here
  say "skipped #$1: not an issue of $REPO (branch $2)"
}

body_issues() { # body_issues <text>: the n of every closing keyword followed by #n, as GitHub reads them
  printf '%s\n' "$1" \
    | grep -oiE '(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+#[0-9]+' \
    | grep -oE '[0-9]+$' || true
}

linked_issues() { # linked_issues <pr>: closing references plus the branch's issue when it is one of REPO's, unique, ascending
  # gh prints the closing references (digits), the head branch, then "body:" and the body on one line (a branch name
  # can hold neither ":" nor spaces). GitHub validated the closing references; the branch's number and, when there are
  # no closing references, the body's numbers go through is_issue, and a skipped one is reported on stderr because
  # stdout is the list. Call it as `linked=$(linked_issues "$PR") || exit 1`: a failed read then stops the run.
  local line n closing=""
  {
    gh api graphql -f owner="$OWNER" -f name="$NAME" -F number="$1" -f query='
      query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){
        pullRequest(number:$number){ headRefName body closingIssuesReferences(first:20){ nodes{ number } } } } }' \
      --jq '.data.repository.pullRequest
            | (.closingIssuesReferences.nodes[].number), .headRefName, ("body:" + ((.body // "") | gsub("\\s+"; " ")))' \
    | while IFS= read -r line; do
        case "$line" in
          body:*)
            [ -z "$closing" ] || continue
            for n in $(body_issues "${line#body:}"); do
              if is_issue "$n"; then printf '%s\n' "$n"; else say "skipped #$n: not an issue of $REPO (body of #$1)" >&2; fi
            done ;;
          ''|*[!0-9]*) n=$(branch_issue "$line"); [ -n "$n" ] || continue
                       if is_issue "$n"; then printf '%s\n' "$n"; else skip_branch "$n" "$line" >&2; fi ;;
          *) closing=1; printf '%s\n' "$line" ;;
        esac
      done
  } | sort -un
}

to_review() { # to_review <n>: Review, unless the ticket is research
  if has_label "$1" wayfinder:research; then say "kept  #$1: wayfinder:research never goes to Review"; return 0; fi
  move "$1" Review "-" Todo "Next Up" "In Progress"
}

start_work() { # start_work <n>: In Progress, the same step a numbered branch takes
  move "$1" "In Progress" "-" Todo "Next Up"
}

close_merged() { # close_merged <n> <pr>
  local state
  state=$(issue_info "$1" | cut -f3)
  if [ "$state" != "OPEN" ]; then say "kept  #$1: already closed"; move "$1" Done; return 0; fi
  if [ -n "$DRY_RUN" ]; then say "would close #$1 (merged into $INTEGRATION_BRANCH by #$2)"; return 0; fi
  if has_label "$1" needs-changes; then gh issue edit "$1" -R "$REPO" --remove-label needs-changes >/dev/null; say "removed needs-changes from #$1"; fi
  gh issue close "$1" -R "$REPO" --comment "Merged into \`$INTEGRATION_BRANCH\` by #$2." >/dev/null
  say "closed #$1: merged into $INTEGRATION_BRANCH by #$2"
  move "$1" Done
}

# ---------------------------------------------------------------- a push that lands the staging branch

# new_commits: every commit PUSH_AFTER brings over PUSH_BEFORE, one SHA per line, from GitHub's compare (paged, so a
# large push is read whole). Answers 3 when GitHub cannot compare the two (a rewritten branch); any other failure
# stops the run.
new_commits() {
  local page=1 total="" got=0 out err
  while :; do
    err=$(mktemp)
    if ! out=$(gh api "repos/$REPO/compare/$PUSH_BEFORE...$PUSH_AFTER?per_page=100&page=$page" \
                 --jq '.total_commits, .commits[].sha' 2>"$err"); then
      case "$(cat "$err")" in *"HTTP 404"*|*"Not Found"*|*"No common ancestor"*) rm -f "$err"; return 3 ;; esac
      cat "$err" >&2; rm -f "$err"; die "could not compare $PUSH_BEFORE...$PUSH_AFTER"
    fi
    rm -f "$err"
    [ -n "$total" ] || total=$(printf '%s\n' "$out" | head -n1)
    out=$(printf '%s\n' "$out" | tail -n +2)
    [ -n "$out" ] || break
    printf '%s\n' "$out"
    got=$((got + $(printf '%s\n' "$out" | wc -l)))
    [ "$got" -lt "$total" ] || break
    page=$((page + 1))
  done
}

# land_staged: a push to INTEGRATION_BRANCH closes what every pull request merged into STAGING_BRANCH links, once the
# push brings that pull request's merge commit; a merge commit already in PUSH_BEFORE was handled by an earlier push.
land_staged() {
  local commits page=1 rows pr sha merged landed=0 linked n rc=0
  case "${PUSH_BEFORE:-}" in ''|*[!0]*) ;; *)
    say "kept: $INTEGRATION_BRANCH is a new branch, nothing to compare"; return 0 ;; esac
  [ -n "${PUSH_BEFORE:-}" ] && [ -n "${PUSH_AFTER:-}" ] || die "a push to $INTEGRATION_BRANCH needs PUSH_BEFORE and PUSH_AFTER"
  commits=$(new_commits) || rc=$?
  if [ "$rc" -eq 3 ]; then
    say "kept: GitHub cannot compare $PUSH_BEFORE...$PUSH_AFTER (rewritten $INTEGRATION_BRANCH?), nothing closed"; return 0
  fi
  [ "$rc" -eq 0 ] || exit "$rc"
  while :; do
    rows=$(gh api "repos/$REPO/pulls?state=closed&base=$STAGING_BRANCH&per_page=100&page=$page" \
             --jq '.[] | [.number, (.merge_commit_sha // "-"), (.merged_at // "-")] | @tsv') ||
      die "could not list the pull requests into $STAGING_BRANCH"
    [ -n "$rows" ] || break
    while IFS=$'\t' read -r pr sha merged; do
      [ "$merged" != "-" ] || continue
      printf '%s\n' "$commits" | grep -qxF -- "$sha" || continue
      linked=$(linked_issues "$pr") || exit 1
      say "landed #$pr: merged into $STAGING_BRANCH, now in $INTEGRATION_BRANCH"
      for n in $linked; do close_merged "$n" "$pr"; done
      landed=$((landed + 1))
    done <<<"$rows"
    [ "$(printf '%s\n' "$rows" | wc -l)" -ge 100 ] || break
    page=$((page + 1))
  done
  say "landed $landed pull request(s) from $STAGING_BRANCH on push to $INTEGRATION_BRANCH"
}

# ---------------------------------------------------------------- whole-board passes

# items: item_id, status, issue number, state, assignee count; one line per issue on the board
items() {
  gh api graphql --paginate -f id="$PROJECT_ID" -f query='
    query($id:ID!,$endCursor:String){ node(id:$id){ ... on ProjectV2{
      items(first:100, after:$endCursor){ pageInfo{ hasNextPage endCursor }
        nodes{ id
          fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
          content{ ... on Issue{ number state assignees(first:1){ totalCount } } } } } } } }' \
    --jq '.data.node.items.nodes[] | select(.content.number != null)
          | [.id, (.fieldValueByName.name // "-"), .content.number, .content.state, .content.assignees.totalCount] | @tsv'
}

promote() { # every Done item -> Complete
  local item status n state a moved=0 board
  board=$(items) || die "could not read the board"
  while IFS=$'\t' read -r item status n state a; do
    [ "$status" = "Done" ] || continue
    if [ -n "$DRY_RUN" ]; then say "would move #$n: Done -> Complete"; else set_status "$item" "$(option_id Complete)"; say "moved #$n: Done -> Complete"; fi
    moved=$((moved + 1))
  done <<<"$board"
  say "promoted $moved item(s) to Complete on push to $RELEASE_BRANCH"
}

backfill() {
  local item status n state a to seen="," board open
  board=$(items) || die "could not read the board"
  while IFS=$'\t' read -r item status n state a; do
    seen="$seen$n,"
    to=""
    if [ "$state" = "CLOSED" ]; then
      case "$status" in Done|Complete) ;; *) to=Done ;; esac
    elif [ "$a" -gt 0 ]; then
      case "$status" in -|Todo) to="Next Up" ;; esac
    else
      [ "$status" = "-" ] && to=Todo
    fi
    [ -n "$to" ] || continue
    if [ -n "$DRY_RUN" ]; then say "would move #$n: $status -> $to"; else set_status "$item" "$(option_id "$to")"; say "moved #$n: $status -> $to"; fi
  done <<<"$board"
  # Open issues not on the board yet (Auto-add off, or older than the project).
  open=$(gh issue list -R "$REPO" --state open --limit 1000 --json number,assignees --jq '.[] | [.number, (.assignees|length)] | @tsv') ||
    die "could not list the open issues"
  while IFS=$'\t' read -r n a; do
    [ -n "$n" ] || continue
    case "$seen" in *,"$n",*) continue ;; esac
    if [ "$a" -gt 0 ]; then move "$n" "Next Up"; else move "$n" Todo; fi
  done <<<"$open"
  say "backfill done"
}

# ---------------------------------------------------------------- dispatch

load_project
say "project #$PROJECT_NUMBER for $REPO; event $EVENT/${ACTION:-}"

case "${EVENT:-}/${ACTION:-}" in
  issues/assigned)
    move "$ISSUE" "Next Up" "-" Todo ;;
  issues/unassigned)
    if [ "$(issue_info "$ISSUE" | cut -f6)" = "0" ]; then move "$ISSUE" Todo "Next Up" "In Progress" Review
    else say "kept  #$ISSUE: still assigned"; fi ;;
  issues/reopened)
    if has_label "$ISSUE" needs-changes; then move "$ISSUE" "In Progress"; else say "kept  #$ISSUE: reopened without needs-changes"; fi ;;
  issues/labeled)
    if [ "${LABEL:-}" = "needs-changes" ]; then move "$ISSUE" "In Progress"; else say "kept  #$ISSUE: label ${LABEL:-} moves nothing"; fi ;;
  create/*)
    [ "${REF_TYPE:-}" = "branch" ] || { say "kept: $REF_TYPE ${REF:-} is not a branch"; exit 0; }
    n=$(branch_issue "${REF:-}")
    if [ -z "$n" ]; then say "kept: branch ${REF:-} names no issue"
    elif ! is_issue "$n"; then skip_branch "$n" "${REF:-}"
    else move "$n" "In Progress" "-" Todo "Next Up"; fi ;;
  pull_request/opened|pull_request/ready_for_review)
    linked=$(linked_issues "$PR") || exit 1
    if [ "${PR_DRAFT:-false}" = "true" ]; then for n in $linked; do start_work "$n"; done
    else for n in $linked; do to_review "$n"; done; fi ;;
  start/*)
    [ -n "${ISSUE:-}" ] || die "start needs ISSUE=<n>"
    start_work "$ISSUE" ;;
  pull_request/converted_to_draft)
    linked=$(linked_issues "$PR") || exit 1
    for n in $linked; do move "$n" "In Progress" Review; done ;;
  pull_request_review/submitted)
    [ "${REVIEW_STATE:-}" = "changes_requested" ] || { say "kept: review ${REVIEW_STATE:-} on #$PR moves nothing"; exit 0; }
    linked=$(linked_issues "$PR") || exit 1
    for n in $linked; do move "$n" "In Progress" Review; done ;;
  pull_request/closed)
    [ "${PR_MERGED:-false}" = "true" ] || { say "kept: #$PR closed without merging"; exit 0; }
    if [ "${PR_BASE:-}" != "$INTEGRATION_BRANCH" ]; then
      if [ -n "$STAGING_BRANCH" ] && [ "${PR_BASE:-}" = "$STAGING_BRANCH" ]; then
        say "kept: #$PR merged into $STAGING_BRANCH; its issues close when $STAGING_BRANCH reaches $INTEGRATION_BRANCH"
      else say "kept: #$PR merged into ${PR_BASE:-}, not $INTEGRATION_BRANCH"; fi
      exit 0
    fi
    linked=$(linked_issues "$PR") || exit 1
    for n in $linked; do close_merged "$n" "$PR"; done ;;
  push/*)
    if [ "${PUSH_REF:-}" = "refs/heads/$RELEASE_BRANCH" ]; then promote
    elif [ -n "$STAGING_BRANCH" ] && [ "${PUSH_REF:-}" = "refs/heads/$INTEGRATION_BRANCH" ]; then land_staged
    else say "kept: push to ${PUSH_REF:-} is not $RELEASE_BRANCH${STAGING_BRANCH:+ or $INTEGRATION_BRANCH}"; fi ;;
  workflow_dispatch/*)
    if [ -n "${START:-}" ]; then start_work "$START"
    elif [ "${BACKFILL:-false}" = "true" ]; then backfill
    else say "kept: dispatch without backfill or start"; fi ;;
  *)
    say "kept: no rule for ${EVENT:-}/${ACTION:-}" ;;
esac
