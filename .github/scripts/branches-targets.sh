#!/usr/bin/env bash
# The token check before .github/workflows/branches.yml runs `branches`: which repositories the run will touch, and
# whether the token can write each one, settled before the command makes a single request. Nothing here prints the
# token: it stays in GITHUB_TOKEN, read by gh, and the only thing about it ever printed is its user's login.
#
# Environment: GITHUB_TOKEN (the PROJECT_PAT secret; missing, or refused by GitHub, fails the run), REPOS (the dispatch
# input: owner/repo names separated by spaces, or empty for the command's own default, every repository the token's
# user owns: GET /user/repos?affiliation=owner with archived ones left out, sorted, as the command lists them). With
# GITHUB_OUTPUT set it writes the step outputs repos (the names that passed, space-separated, in the order the command
# takes them) and login; with GITHUB_STEP_SUMMARY, one table.
#
# Per repository, in order:
#   - a name that is not owner/repo fails the run (::error) before anything runs: the command would exit 2 with nothing
#     done, and this way the step summary says which name
#   - owner layerdbiz (any case) is refused by name and listed: those repositories wait for a token that covers them
#     (ADR-0013 in oneezy/skills); a refusal is not a failure
#   - GET /repos/{owner}/{repo} with permissions.push true passes; false, or 401, 403 or 404 (the token's reach), is
#     listed as "skipped: cannot write <repo>" with a ::warning, and the command never names that repository. It is
#     what GitHub says of the token's user; a classic token with scopes narrower than its user passes here and shows on
#     the command's first write as `! skipped: cannot write: 403 ...` (exit 1), nothing else of that repository done
# No repository left to run on fails the run: the token reaches nothing, which is a secret or a scope to fix.
#
# Runs anywhere with bash and gh:
#   REPOS='oneezy/tools layerdbiz/x' GITHUB_TOKEN=<token> bash .github/scripts/branches-targets.sh
set -euo pipefail

REPOS=${REPOS:-}

fail() { echo "::error title=branches::$*" >&2; exit 1; }
output() { if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }
summary() { if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }

# 1. The token, and whose it is. gh reads GITHUB_TOKEN; the login is the only thing about the token that is printed.
if [[ -z ${GITHUB_TOKEN:-} ]]; then
  fail "the PROJECT_PAT secret is missing; the run needs a token that can delete branches and create tags"
fi
if ! login=$(gh api user --jq .login 2>/dev/null) || [[ -z $login ]]; then
  fail "GitHub does not accept the token (GET /user failed); check the PROJECT_PAT secret"
fi
echo "token user: $login"
output login "$login"

# 2. The repositories asked for, or the command's default list, resolved here so the check and the run agree.
requested=()
if [[ -n ${REPOS//[[:space:]]/} ]]; then
  read -r -a requested <<< "$(tr '\n\t' '  ' <<< "$REPOS")"
  source="named in the dispatch"
else
  if ! listed=$(gh api 'user/repos?affiliation=owner&per_page=100' --paginate \
    --jq '.[] | select(.archived | not) | .full_name' 2>/dev/null); then
    fail "cannot list the repositories $login owns (GET /user/repos failed); check the PROJECT_PAT secret's scopes"
  fi
  mapfile -t requested < <(sort <<< "$listed" | sed '/^$/d')
  source="every repository $login owns"
fi

# 3. Each one: the name, the owner, the token's reach.
run=()
rows=()
bad=0
declare -A seen=()
for repo in ${requested[@]+"${requested[@]}"}; do
  if [[ -n ${seen[$repo]:-} ]]; then continue; fi
  seen[$repo]=1
  # the command's own test of a name (isRepoName): owner/repo, each of word characters, dots and dashes
  if [[ ! $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "::error title=branches::not an owner/repo name: $repo" >&2
    rows+=("| \`$repo\` | refused: not owner/repo |")
    bad=1
    continue
  fi
  owner=${repo%%/*}
  if [[ ${owner,,} == layerdbiz ]]; then
    echo "::notice title=branches::$repo refused: layerdbiz repositories wait for a token that covers them (ADR-0013)"
    rows+=("| \`$repo\` | refused: layerdbiz, outside the token's reach |")
    continue
  fi
  # gh's answer on a failure is GitHub's message and "(HTTP nnn)"; only the status is repeated, never the answer
  if answer=$(gh api "repos/$repo" --jq '.permissions.push // false' 2>&1) && [[ $answer == true ]]; then
    echo "will run: $repo"
    rows+=("| \`$repo\` | will run |")
    run+=("$repo")
  else
    if [[ $answer =~ \(HTTP\ ([0-9]+)\) ]]; then
      why="HTTP ${BASH_REMATCH[1]}"
    elif [[ $answer == false ]]; then
      why="no push permission"
    else
      why="no answer from GitHub"
    fi
    echo "::warning title=branches::skipped: cannot write $repo ($why)"
    rows+=("| \`$repo\` | skipped: cannot write ($why) |")
  fi
done

# 4. The summary, then the outputs; a bad name or an empty list fails after the table is written, so it says why.
summary "## Token check" "" "Token user \`$login\`; repositories: $source." "" "| Repository | Check |" "|---|---|" \
  ${rows[@]+"${rows[@]}"} ""
if (( bad )); then
  fail "a repository name is not owner/repo (see the step summary); nothing run"
fi
if (( ${#run[@]} == 0 )); then
  fail "no repository to run on: the token writes none of the ${#requested[@]} ($source)"
fi
output repos "${run[*]}"
echo "branches will run on ${#run[@]} of ${#requested[@]} repositories: ${run[*]}"
