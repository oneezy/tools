#!/usr/bin/env bash
# Set Estimate, Priority and/or a Type label on one issue, then leave one comment.
# Usage: set.sh <issue-number> [--estimate N] [--priority P] [--type T] --comment "why" [--repo owner/repo] [--dry-run]
#   Estimate: 1 2 3 5 8 13         Priority: Low Medium High Critical
#   Type:     bug feature tech-debt question learning reference
# Refuses (exit 2, nothing written) any write outside the estimate rules; the message names the rule.
# Needs: gh, authenticated with a token that can write the project (PROJECT_PAT in CI).
set -euo pipefail

number="" estimate="" priority="" type="" comment="" repo="" dry=""
while [ $# -gt 0 ]; do
  case "$1" in
    --estimate) estimate="$2"; shift 2 ;;
    --priority) priority="$2"; shift 2 ;;
    --type)     type="$2"; shift 2 ;;
    --comment)  comment="$2"; shift 2 ;;
    --repo)     repo="$2"; shift 2 ;;
    --dry-run)  dry=1; shift ;;
    -*)         echo "set.sh: unknown flag $1" >&2; exit 1 ;;
    *)          number="$1"; shift ;;
  esac
done

refuse() { echo "set.sh: refused: $*" >&2; exit 2; }
usage()  { echo "set.sh: $*" >&2; sed -n '2,7p' "$0" >&2; exit 1; }

[ -n "$number" ] || usage "issue number missing"
[ -n "$estimate$priority$type" ] || usage "nothing to set"
[ -n "$comment" ] || usage "--comment is required: say what was set and why"
case "$estimate" in ""|1|2|3|5|8|13) ;; *) usage "estimate must be one of 1 2 3 5 8 13" ;; esac
case "$priority" in ""|Low|Medium|High|Critical) ;; *) usage "priority must be Low, Medium, High or Critical" ;; esac
case "$type" in ""|bug|feature|tech-debt|question|learning|reference) ;; *) usage "type must be bug, feature, tech-debt, question, learning or reference" ;; esac

repo="${repo:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
owner="${repo%%/*}"
name="${repo##*/}"

# One read: issue state and labels, its project item, and the project's field and option ids.
read -r state labels item project_id status cur_estimate cur_priority est_field pri_field pri_options < <(
gh api graphql -f owner="$owner" -f name="$name" -F number="$number" -f query='
query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ issue(number:$number){ state
    labels(first:30){ nodes{ name } }
    projectItems(first:10){ nodes{ id
      project{ id closed fields(first:40){ nodes{
        ... on ProjectV2FieldCommon{ id name }
        ... on ProjectV2SingleSelectField{ options{ id name } } } } }
      fieldValues(first:20){ nodes{
        ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } }
        ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2FieldCommon{ name } } } } } } } } } }' \
  --jq '.data.repository.issue as $i
    | ([$i.projectItems.nodes[] | select(.project.closed|not)][0]) as $it
    | [ $i.state,
        ([$i.labels.nodes[].name] | join(",") | if . == "" then "-" else . end),
        ($it.id // "-"),
        ($it.project.id // "-"),
        (([$it.fieldValues.nodes[]? | select(.field.name=="Status")   | .name][0])   // "-"),
        (([$it.fieldValues.nodes[]? | select(.field.name=="Estimate") | .number][0]) // "-"),
        (([$it.fieldValues.nodes[]? | select(.field.name=="Priority") | .name][0])   // "-"),
        (([$it.project.fields.nodes[]? | select(.name=="Estimate") | .id][0]) // "-"),
        (([$it.project.fields.nodes[]? | select(.name=="Priority") | .id][0]) // "-"),
        (([$it.project.fields.nodes[]? | select(.name=="Priority") | .options[] | "\(.name)=\(.id)"] | join(";") | if . == "" then "-" else . end))
      ] | @tsv')

# Priority option id for the requested name, from "Low=id;Medium=id;…".
pri_option="-"
case ";$pri_options;" in
  *";$priority="*) pri_option=";$pri_options;"; pri_option="${pri_option#*;$priority=}"; pri_option="${pri_option%%;*}" ;;
esac

[ "$state" = "OPEN" ] || refuse "issue #$number is $state; only open issues are sized"
[ "$item" != "-" ] || refuse "issue #$number is on no open project"
case ",$labels," in
  *,wayfinder:map,*) refuse "issue #$number is a wayfinder map; maps are never sized" ;;
  *,phase,*)         refuse "issue #$number is a phase; phases are never sized" ;;
esac
if [ -n "$estimate" ] && [ "$cur_estimate" != "-" ]; then
  refuse "issue #$number already has Estimate ${cur_estimate%.*}; Estimate is write-once"
fi
if [ -n "$priority" ] && [ "$cur_priority" != "-" ]; then
  case "$status" in
    Todo|"Next Up") ;;
    *) refuse "issue #$number is $status with Priority $cur_priority; Priority changes only in Todo or Next Up" ;;
  esac
  [ "$cur_priority" != "$priority" ] || refuse "issue #$number already has Priority $priority"
fi
if [ -n "$type" ]; then
  for t in bug feature tech-debt question learning reference; do
    case ",$labels," in *,"$t",*) refuse "issue #$number already has Type $t; one type per ticket" ;; esac
  done
fi
[ -z "$estimate" ] || [ "$est_field" != "-" ] || refuse "project has no Estimate field"
[ -z "$priority" ] || [ "$pri_option" != "-" ] || refuse "project has no Priority option $priority"

run() { if [ -n "$dry" ]; then echo "dry-run: $*"; else "$@" >/dev/null; fi; }

if [ -n "$estimate" ]; then
  run gh api graphql -f p="$project_id" -f i="$item" -f f="$est_field" -F n="$estimate" -f query='
    mutation($p:ID!,$i:ID!,$f:ID!,$n:Float!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{number:$n}}){ clientMutationId } }'
  echo "set #$number Estimate $estimate"
fi
if [ -n "$priority" ]; then
  run gh api graphql -f p="$project_id" -f i="$item" -f f="$pri_field" -f o="$pri_option" -f query='
    mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ clientMutationId } }'
  if [ "$cur_priority" = "-" ]; then echo "set #$number Priority $priority"; else echo "set #$number Priority $priority (was $cur_priority)"; fi
fi
if [ -n "$type" ]; then
  run gh issue edit "$number" --repo "$repo" --add-label "$type"
  echo "set #$number Type $type"
fi
run gh issue comment "$number" --repo "$repo" --body "$comment"
echo "commented on #$number"
