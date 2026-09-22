#!/usr/bin/env bash
# Print the repo's GitHub project and every issue on its board, open or closed, one JSON object per line.
# Usage: backlog.sh [owner/repo]   (default: the current clone)
# Needs: gh, authenticated with a token that can read the project (PROJECT_PAT in CI).
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
owner="${repo%%/*}"
name="${repo##*/}"

# Line 1: the open project linked to the repo, with the ids set.sh needs.
project_line=$(gh api graphql -f owner="$owner" -f name="$name" -f query='
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    projectsV2(first:10){ nodes{ id number title closed
      fields(first:40){ nodes{
        ... on ProjectV2FieldCommon{ id name dataType }
        ... on ProjectV2SingleSelectField{ options{ id name } } } } } } } }' \
  --jq '[.data.repository.projectsV2.nodes[] | select(.closed|not)][0]
        | if . == null then "none" else
          {kind:"project", repo:"'"$repo"'", id, number, title,
           fields: ([.fields.nodes[]
                     | select(.name=="Status" or .name=="Priority" or .name=="Estimate")
                     | {key:.name, value:{id, options:((.options // []) | map({key:.name, value:.id}) | from_entries)}}]
                    | from_entries)} end')

if [ "$project_line" = '"none"' ]; then
  echo "backlog.sh: no open GitHub project is linked to $repo" >&2
  exit 1
fi
printf '%s\n' "$project_line"

project_id=$(printf '%s' "$project_line" | grep -oE '"id":"PVT_[^"]+"' | head -1 | cut -d'"' -f4)

# Then one line per issue on the board, open or closed (closed ones get sized too, once). Bodies are cut at 2000 characters.
gh api graphql --paginate -f id="$project_id" -f query='
query($id:ID!,$endCursor:String){ node(id:$id){ ... on ProjectV2{
  items(first:50, after:$endCursor){ pageInfo{ hasNextPage endCursor }
    nodes{ id
      fieldValues(first:20){ nodes{
        ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } }
        ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2FieldCommon{ name } } } } }
      content{ ... on Issue{ number title body state createdAt
        labels(first:20){ nodes{ name } }
        assignees(first:5){ nodes{ login } }
        deps:issueDependenciesSummary{ blockedBy blocking } } } } } } } }' \
  --jq '.data.node.items.nodes[]
        | select(.content.number != null)
        | {kind:"issue",
           number:.content.number,
           title:.content.title,
           state:.content.state,
           status:([.fieldValues.nodes[] | select(.field.name=="Status")   | .name][0]),
           estimate:([.fieldValues.nodes[] | select(.field.name=="Estimate") | .number][0]),
           priority:([.fieldValues.nodes[] | select(.field.name=="Priority") | .name][0]),
           labels:[.content.labels.nodes[].name],
           assignees:[.content.assignees.nodes[].login],
           blocked_by:.content.deps.blockedBy,
           blocks:.content.deps.blocking,
           created:.content.createdAt,
           item:.id,
           body:((.content.body // "") | if length > 2000 then .[0:2000] + " […]" else . end)}'
