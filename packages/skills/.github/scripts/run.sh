#!/usr/bin/env bash
# One library command for .github/workflows/run.yml: run it with the installed @oneezy/skills-sync against the checkout
# and, when it changed anything, commit the result (message: run-report.mjs) and push it as
# land/<command>-<args>-<run id>, which land.yml squashes into dev, promotes and releases. Nothing else: an unchanged
# tree pushes no branch, `versions` only prints, and bad input (an unknown command, a command this tool version does
# not have, a missing argument, a tool error) fails with one ::error line and pushes nothing.
#
# Environment: CLI (the tool's CLI entry, run with node), COMMAND (update | add | remove | versions | rename), ARGS (the command's
# arguments as one string, split on spaces; may be empty), LIBRARY (the checkout, default library), RUN_ID (the branch
# suffix, default local), RUN_URL (named in the commit body; optional), TOOL_VERSION (named in messages; optional),
# HAS_PUSH_TOKEN (true when the checkout pushes with a token whose push starts workflows; a push made with GITHUB_TOKEN
# starts no land run, so a command that may push refuses to start without one), REMOTE (default origin). With
# GITHUB_OUTPUT set it writes the step outputs changed (true | false) and branch; with GITHUB_STEP_SUMMARY, a summary.
#
# Runs anywhere with bash, git and node: against a clone whose origin is a bare repository on disk, it is its own test.
set -euo pipefail

: "${CLI:?CLI (the tool CLI entry, a node script) is required}"
: "${COMMAND:?COMMAND: update, add, remove, versions or rename is required}"
ARGS=${ARGS:-}
LIBRARY=${LIBRARY:-library}
RUN_ID=${RUN_ID:-local}
RUN_URL=${RUN_URL:-}
TOOL_VERSION=${TOOL_VERSION:-}
HAS_PUSH_TOKEN=${HAS_PUSH_TOKEN:-false}
REMOTE=${REMOTE:-origin}
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tool="@oneezy/skills-sync${TOOL_VERSION:+ $TOOL_VERSION}"
shown="$COMMAND${ARGS:+ $ARGS}"

fail() { echo "::error title=run $COMMAND::$*" >&2; exit 1; }
note() { echo "::notice title=run $COMMAND::$*"; }
output() { if [[ -n ${GITHUB_OUTPUT:-} ]]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }
summary() { if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then printf '%s\n' "$@" >> "$GITHUB_STEP_SUMMARY"; fi; }

# 1. The command: one of the library commands, and one this tool version has. Its --help lists every command it knows;
#    a word it does not know falls through to the default `sync`, a machine command that must never run here.
case $COMMAND in
  update | add | remove | versions | rename) ;;
  *) fail "unknown command '$COMMAND'; the library commands are update, add, remove, versions and rename" ;;
esac
if ! help=$(node "$CLI" --help 2>&1); then
  fail "the tool's --help failed: $(head -n 1 <<< "$help")"
fi
if ! grep -Eq "^  $COMMAND( |\$)" <<< "$help"; then
  known=$(grep -oE '^  (update|add|remove|versions|rename)\b' <<< "$help" | tr -d ' ' | paste -sd ',' | sed 's/,/, /g' || true)
  fail "$tool has no '$COMMAND' command (it has ${known:-none of update, add, remove, versions, rename}); nothing run, nothing pushed"
fi

# 2. The arguments, split on spaces. The checkout and the output form are the workflow's to choose.
read -r -a argv <<< "$ARGS"
positional=()
for a in ${argv[@]+"${argv[@]}"}; do
  case $a in
    --repo | --repo=*) fail "args may not name --repo; the command runs against this workflow's checkout of dev" ;;
    --json) fail "args may not name --json; the workflow reads the report itself" ;;
    -*) ;;
    *) positional+=("$a") ;;
  esac
done
case $COMMAND in
  add) (( ${#positional[@]} )) || fail "add needs a source: owner/repo[#ref] or a git URL, then its flags (--id, --root, --skills, --as, --plugin); nothing pushed" ;;
  remove) (( ${#positional[@]} )) || fail "remove needs a source: its id from skills-sync.json, or the owner/repo of exactly one source; nothing pushed" ;;
  versions) (( ${#positional[@]} )) || fail "versions needs a source id from skills-sync.json; nothing pushed" ;;
  rename) (( ${#positional[@]} >= 2 )) || fail "rename needs the old and the new name; nothing pushed" ;;
esac

# 3. A command that may push needs a token whose push starts land.yml.
if [[ $COMMAND != versions && $HAS_PUSH_TOKEN != true ]]; then
  fail "no PROJECT_PAT secret: a push made with GITHUB_TOKEN starts no land run, so a change could never land; add the secret task-manager.yml uses and run again. Nothing run, nothing pushed"
fi

# 4. A clean checkout, so that whatever differs afterwards is the command's doing.
[[ -d $LIBRARY/.git ]] || fail "$LIBRARY is not a git checkout"
[[ -z $(git -C "$LIBRARY" status --porcelain) ]] || fail "$LIBRARY has local changes; the command needs a clean checkout"
base=$(git -C "$LIBRARY" rev-parse --short HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 5. Run it. update and add report with --json (the tool's report, which run-report.mjs reads); versions prints and
#    writes nothing, so it ends here; any other command prints as it is and its diff is the report.
case $COMMAND in
  update | add)
    echo "::group::$shown --json (the tool's progress; its report is the commit message below)"
    status=0
    node "$CLI" "$COMMAND" ${argv[@]+"${argv[@]}"} --json --repo "$LIBRARY" > "$tmp/report.json" || status=$?
    echo "::endgroup::"
    if (( status != 0 )); then
      refused=$(node -e 'try { const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (r.refused) console.log(r.refused); } catch {}' "$tmp/report.json")
      fail "$shown failed (exit $status)${refused:+: $refused}; nothing pushed"
    fi
    ;;
  versions)
    node "$CLI" "$COMMAND" ${argv[@]+"${argv[@]}"} --yes --repo "$LIBRARY" || fail "$shown failed (exit $?); nothing pushed"
    [[ -z $(git -C "$LIBRARY" status --porcelain) ]] || fail "$shown changed files in the checkout, which it never should; nothing pushed"
    note "$shown printed its report above; it writes nothing, so no branch is pushed"
    output changed false
    exit 0
    ;;
  *)
    # The checkout has no upstream/ snapshots (gitignored); remove rebuilds every package, so the other sources need theirs.
    if [[ $COMMAND == remove ]]; then
      node "$CLI" refresh --frozen --repo "$LIBRARY" || fail "refresh --frozen failed (exit $?); nothing pushed"
    fi
    node "$CLI" "$COMMAND" ${argv[@]+"${argv[@]}"} --yes --repo "$LIBRARY" || fail "$shown failed (exit $?); nothing pushed"
    echo '{}' > "$tmp/report.json"
    ;;
esac

# 6. The hold the report asks for, the rebuilt packages, then what changed.
node "$scripts/run-report.mjs" apply-config "$LIBRARY" "$tmp/report.json"
node "$CLI" build --plugins --catalogs --quiet --repo "$LIBRARY"
git -C "$LIBRARY" add -A
if git -C "$LIBRARY" diff --cached --quiet; then
  note "$shown changed nothing: every source is where the config says and the packages are current; no branch pushed"
  output changed false
  exit 0
fi
touched=$(git -C "$LIBRARY" diff --cached --name-only -- .github)
[[ -z $touched ]] || fail "$shown changed .github/ ($touched), which land.yml refuses; nothing pushed"
# What land.yml would check, checked here first: a tree the checks refuse fails this run and leaves no land/* branch behind.
node "$CLI" build --check --repo "$LIBRARY" && node "$CLI" check --repo "$LIBRARY" || fail "$shown left a tree check refuses; nothing pushed"
stat=$(git -C "$LIBRARY" diff --cached --stat --no-color | tail -n 1 | sed 's/^ *//')

# 7. The commit, named by the report (the message goes to the step summary, never to stdout, where a changelog line
#    starting with :: would read as a workflow command), on land/<command>-<args>-<run id>; land.yml takes it from there.
node "$scripts/run-report.mjs" message "$LIBRARY" "$tmp/report.json" --command "$COMMAND" --args "$ARGS" --tool-version "$TOOL_VERSION" --run "$RUN_URL" --out "$tmp/message" > /dev/null
slug=$(printf '%s' "${positional[*]:-all}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9.]+/-/g; s/\.{2,}/./g; s/^[-.]+//; s/[-.]+$//' | cut -c1-40 | sed -E 's/[-.]+$//; s/\.lock$/-lock/')
branch="land/$COMMAND-${slug:-all}-$RUN_ID"
git -C "$LIBRARY" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit --quiet -F "$tmp/message"
git -C "$LIBRARY" push --quiet "$REMOTE" "HEAD:refs/heads/$branch"
head=$(git -C "$LIBRARY" rev-parse --short HEAD)
note "pushed $branch ($head on $base; $stat); land.yml now squashes it into dev, promotes main and starts the release"
output changed true
output branch "$branch"
summary "## $shown" "" "Pushed \`$branch\` ($stat). land.yml lands it: dev, then main, then the release." "" '```' "$(cat "$tmp/message")" '```'
