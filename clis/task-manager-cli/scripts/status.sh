#!/usr/bin/env bash
# Move issues' Status on the repo's GitHub Project from one git event.
# Driven by .github/workflows/task-manager.yml (this repo hosts it; other repos call it). Every input is an environment variable, so it runs
# by hand too:   REPO=oneezy/tools EVENT=issues ACTION=assigned ISSUE=17 DRY_RUN=1 clis/task-manager-cli/scripts/status.sh
#
# Inputs (env):
#   REPO                owner/name (default: the current clone)
#   EVENT               issues | create | pull_request | pull_request_review | push | workflow_dispatch
#   ACTION              the event's action: assigned unassigned reopened labeled opened ready_for_review
#                       converted_to_draft closed submitted
#   ISSUE               issue number                      (issues)
#   LABEL               the label just added              (issues labeled)
#   REF_TYPE, REF       "branch" and the branch name      (create)
#   PR                  pull request number               (pull_request, pull_request_review)
#   PR_BASE             the pull request's base branch    (pull_request)
#   PR_DRAFT            true | false                      (pull_request)
#   PR_MERGED           true | false                      (pull_request closed)
#   REVIEW_STATE        approved | changes_requested | commented   (pull_request_review)
#   PUSH_REF            refs/heads/<branch>               (push)
#   BACKFILL            true recomputes every board item from git facts   (workflow_dispatch)
#   INTEGRATION_BRANCH  merging into it closes the linked issues; default dev
#   RELEASE_BRANCH      pushing to it moves Done to Complete; default main
#   DRY_RUN             1 prints every move and writes nothing
#
# The rules, decided on oneezy/tools#7 (section 3):
#   issue assigned                       -> Next Up      from Todo or no Status
#   issue unassigned, nobody left        -> Todo         from Next Up, In Progress, Review
#   branch <type>/<n>-<slug> created     -> In Progress  from Todo, Next Up or no Status
#   PR opened (not draft) or ready       -> Review       for its linked issues, skipping wayfinder:research
#   PR to draft, or changes requested    -> In Progress  from Review
#   PR merged into INTEGRATION_BRANCH    -> the linked issues are closed (needs-changes removed), then Done
#   push to RELEASE_BRANCH               -> Complete     for every Done item
#   issue reopened or labeled needs-changes  -> In Progress
#   backfill                             -> closed: Done; open and assigned: Next Up from Todo or none;
#                                           open and unassigned with no Status: Todo; everything else kept
# A PR's linked issues are its closing references plus the issue its branch is named after.
# Closed issues are never moved except to Done or Complete.
# Needs: gh with a token that can write the project (PROJECT_PAT in CI). No jq: gh's --jq does the parsing.
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { echo "status.sh: $*" >&2; exit 1; }

REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
OWNER="${REPO%%/*}"
NAME="${REPO##*/}"
INTEGRATION_BRANCH="${INTEGRATION_BRANCH:-dev}"
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
DRY_RUN="${DRY_RUN:-}"
export NAME

# ---------------------------------------------------------------- the project

# The open project linked to the repo: the one titled after the repo when there is one, else the first.
load_project() {
  IFS=$'\t' read -r PROJECT_ID PROJECT_NUMBER STATUS_FIELD OPTIONS < <(
    gh api graphql -f owner="$OWNER" -f name="$NAME" -f query='
      query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
        projectsV2(first:10){ nodes{ id number title closed
          field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } } }' \
      --jq '([.data.repository.projectsV2.nodes[] | select(.closed|not)] | (map(select(.title==$ENV.NAME)) + .)[0]) as $p
            | if $p == null then ["-","-","-","-"]
              else [$p.id, $p.number, $p.field.id, ($p.field.options | map(.name+"="+.id) | join(","))] end
            | @tsv')
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
  local item status state node labels assignees
  IFS=$'\t' read -r item status state node labels assignees < <(issue_info "$n")
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
  labels=$(issue_info "$1" | cut -f5)
  case ",$labels," in *,"$2",*) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------- pull requests and branches

branch_issue() { # branch_issue <ref>: the n in <type>/<n>-<slug>, or nothing
  printf '%s\n' "$1" | sed -nE 's#^[A-Za-z][A-Za-z0-9_-]*/([0-9]+)(-.*)?$#\1#p'
}

linked_issues() { # linked_issues <pr>: closing references plus the branch's issue, unique, ascending
  {
    gh api graphql -f owner="$OWNER" -f name="$NAME" -F number="$1" -f query='
      query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){
        pullRequest(number:$number){ headRefName closingIssuesReferences(first:20){ nodes{ number } } } } }' \
      --jq '.data.repository.pullRequest | (.closingIssuesReferences.nodes[].number), .headRefName' \
    | while IFS= read -r line; do
        case "$line" in ''|*[!0-9]*) branch_issue "$line" ;; *) printf '%s\n' "$line" ;; esac
      done
  } | sort -un
}

to_review() { # to_review <n>: Review, unless the ticket is research
  if has_label "$1" wayfinder:research; then say "kept  #$1: wayfinder:research never goes to Review"; return 0; fi
  move "$1" Review "-" Todo "Next Up" "In Progress"
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
  local item status n state a moved=0
  while IFS=$'\t' read -r item status n state a; do
    [ "$status" = "Done" ] || continue
    if [ -n "$DRY_RUN" ]; then say "would move #$n: Done -> Complete"; else set_status "$item" "$(option_id Complete)"; say "moved #$n: Done -> Complete"; fi
    moved=$((moved + 1))
  done < <(items)
  say "promoted $moved item(s) to Complete on push to $RELEASE_BRANCH"
}

backfill() {
  local item status n state a to seen=","
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
  done < <(items)
  # Open issues not on the board yet (Auto-add off, or older than the project).
  while IFS=$'\t' read -r n a; do
    case "$seen" in *,"$n",*) continue ;; esac
    if [ "$a" -gt 0 ]; then move "$n" "Next Up"; else move "$n" Todo; fi
  done < <(gh issue list -R "$REPO" --state open --limit 1000 --json number,assignees --jq '.[] | [.number, (.assignees|length)] | @tsv')
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
    if [ -n "$n" ]; then move "$n" "In Progress" "-" Todo "Next Up"; else say "kept: branch ${REF:-} names no issue"; fi ;;
  pull_request/opened|pull_request/ready_for_review)
    [ "${PR_DRAFT:-false}" != "true" ] || { say "kept: #$PR is a draft"; exit 0; }
    for n in $(linked_issues "$PR"); do to_review "$n"; done ;;
  pull_request/converted_to_draft)
    for n in $(linked_issues "$PR"); do move "$n" "In Progress" Review; done ;;
  pull_request_review/submitted)
    [ "${REVIEW_STATE:-}" = "changes_requested" ] || { say "kept: review ${REVIEW_STATE:-} on #$PR moves nothing"; exit 0; }
    for n in $(linked_issues "$PR"); do move "$n" "In Progress" Review; done ;;
  pull_request/closed)
    [ "${PR_MERGED:-false}" = "true" ] || { say "kept: #$PR closed without merging"; exit 0; }
    [ "${PR_BASE:-}" = "$INTEGRATION_BRANCH" ] || { say "kept: #$PR merged into ${PR_BASE:-}, not $INTEGRATION_BRANCH"; exit 0; }
    for n in $(linked_issues "$PR"); do close_merged "$n" "$PR"; done ;;
  push/*)
    [ "${PUSH_REF:-}" = "refs/heads/$RELEASE_BRANCH" ] || { say "kept: push to ${PUSH_REF:-} is not $RELEASE_BRANCH"; exit 0; }
    promote ;;
  workflow_dispatch/*)
    [ "${BACKFILL:-false}" = "true" ] || { say "kept: dispatch without backfill"; exit 0; }
    backfill ;;
  *)
    say "kept: no rule for ${EVENT:-}/${ACTION:-}" ;;
esac
