---
title: Adversarial review of oneezy/skills#28 on feature/skills-sync-migration (eight flow.yaml, the token pass, skills-sources.json)
date: 2026-10-01
sources:
  - https://github.com/oneezy/skills tree at cc7be4d (feature/skills-sync-migration), clone at C:/Users/Justin/.claude/jobs/432033f7/tmp/flow-review/skills; diff 28663fa..7d91501 (#28) via `git diff <old>:<path> <new>:<path>`
  - docs/agents/references.md, CONTEXT.md, docs/adr/0001, 0002, 0004, docs/research/local-skills-inventory.md, docs/research/pstack.md, docs/research/writing-for-agents-pin.md (same clone)
  - https://github.com/oneezy/skills/issues/27 and /28 (read with `gh issue view`, nothing posted)
  - https://api.github.com/repos/mattpocock/skills/git/trees/HEAD?recursive=1 and .../trees/321658273cb1d20b76026717d027d505790106d4; .../commits/3216582...; .../commits?path=skills/productivity/writing-for-agents
  - https://api.github.com/repos/cursor/plugins/git/trees/HEAD?recursive=1; https://api.github.com/repos/backnotprop/pstack/git/trees/HEAD?recursive=1
  - https://api.github.com/repos/layerdbiz/tridentcubed/contents/.claude/skills/<skill>/SKILL.md?ref=dev (both Trident originals)
  - https://github.com/oneezy/tools at d74da7e (feature/skills-sync-plugins), clone at .../flow-review/tools: clis/skills-sync/src/*.ts, README.md
  - Skill tool: writing-for-agents (C:/Users/Justin/.claude/skills/writing-for-agents/SKILL.md)
  - Mechanical sweep: a Python/PyYAML parse of all eight flow.yaml (ids, after edges, outcome keys, loop.until, ref kinds and needs) and a regex over each SKILL.md body (frontmatter and code fences stripped) for backticked spans starting with / or @
---

# Flow review of #28

## Summary

The eight `flow.yaml` files are structurally clean: every `skill` equals its folder, every step id is unique, every `after` edge exists, every `outcome` uses only `done`/`fail`/`input`, the one `loop` has `until`, and every backticked `/name` or `@Name` in the prose is covered by `refs` or `unresolved` (verified mechanically). The steps describe the SKILL.md prose faithfully with one real omission (merge's "release from `dev` is only the promotion" branch) and a handful of small gaps. The token pass touched four SKILL.md files; three changes are pure token form, one (oneezy-merge, twice) rewords "calling the Skill tool with `oneezy-status`" to "running `/oneezy-status`", which ADR-0004 asks for but exceeds "wording otherwise unchanged". The two Trident SKILL.md files are byte-identical to `layerdbiz/tridentcubed@dev`. The sources file is correct against upstream: the 37 Matt Pocock names equal `mattpocock/skills@main`'s 37 `SKILL.md` basenames, the 47 PStack names equal `cursor/plugins@main` `pstack/skills/*`, the renames are exactly `tdd`/`teach`, the pin `3216582` is the commit the lock hash names and the folder is unchanged at HEAD, and all four attribution paths exist upstream. The serious problem is beside the file: #28's README, AGENTS.md and `.gitignore` encode the pre-amendment names (`skills-sources-lock.json`; `skills-sync.json` as an ignored per-machine file), so the rename now in flight to `skills-sync.json` would be gitignored the moment it lands.

## Findings

One per line: path, severity, what, fix.

- `.gitignore:8` | blocker | `skills-sync.json` is still ignored; per ADR-0001 amendment and #27 it is the committed config, and the running rename of `skills-sources.json` lands on exactly that name, so git would drop it silently. | Remove the line; add `skills-sync.local.json`.
- `README.md` (Generated versus committed table, Layout table) and `AGENTS.md:7` | major | Both name `skills-sources-lock.json` as generated and committed and describe `skills-sync.json` as "this machine's ... remembered answers"; ADR-0001 amendment: no sources lock, `skills-lock.json` is the one record, per-machine answers live in `skills-sync.local.json`. | Drop the sources-lock rows/mentions; rename the answers file; say the config is committed.
- `skills/oneezy/oneezy-merge/flow.yaml:18-48` | major | SKILL.md: "When the current branch is `dev` itself, or the branch is already landed, release is only the promotion" has no encoding: `commit-push`, `open-pr`, `wait-builds`, `land` run unconditionally in release mode. | Add `if: not (mode is release and the branch is dev or already landed)` to those four steps, or a `promotion-only` note on `mode` and `after: [mode, land]` on `promote`.
- `skills/oneezy/oneezy-skills/SKILL.md:33` | major (deferred by #28 to the wrapper ticket) | "Own skills are edited in the library's `skills/<name>/`" is stale after the move to `skills/<plugin>/<name>/`. | Wrapper ticket must change it; note it there so it is not lost.
- `skills-sources.json:66-114` | major (decision) | Renames handle folder names only; PStack's `poteto-mode` and `make-bot-ui` carry `name: Poteto Mode` / `name: Make Bot UI` upstream (pstack.md fact 18), invalid skill names for Claude Code and Codex. #27 excludes editing third-party content, and the spec's transform is "rename plus frontmatter `name` rewrite" for renamed skills only. | Justin decides: a `name` transform for those two, a rename to their folder names, or accept broken names in the pstack plugin.
- `skills-sources.json:2-7` | minor | The two switches `skills: true` and `plugins: true` from #27's config shape are absent (defaults true). #28 asks for "the spec's shape field for field". | Add both keys.
- `skills-sources.json:14,66` | minor | `sources.matt-pocock.skills` is an array, `sources.pstack.skills` an object; #27 allows "a list or an old→new rename map". | None; the schema must accept both shapes.
- `skills/oneezy/oneezy-merge/SKILL.md:8,33` | minor | Token pass drift beyond token form, twice: "ends by calling the Skill tool with `oneezy-status`" → "ends by running `/oneezy-status`"; "**Report**: call the Skill tool with `oneezy-status`" → "**Report**: run `/oneezy-status`". ADR-0004 ("invocation never spelled into prose") justifies it; #28's "wording otherwise unchanged" does not. | Accept; record in the PR as intended.
- `skills/oneezy/oneezy-estimate/SKILL.md:7`, `skills/oneezy/oneezy-status/SKILL.md:6` | minor | Markdown links `[`scripts/set.sh`](scripts/set.sh)` and `[STATUS.md](STATUS.md)` became bare backticked paths; the hyperlink is lost but the convention asks for exactly this. | None.
- `skills/oneezy/oneezy-estimate/flow.yaml:24` | minor | `fail: no open project linked to the repo → stop` is not in SKILL.md prose; it is `scripts/backlog.sh:27-29`. Script-backed, so not invented, but the flow is meant to mirror the skill's prose. | Add one clause to SKILL.md step 1 ("stops when no open project is linked"), or leave.
- `skills/oneezy/oneezy-skills/flow.yaml:27` | minor | `run-script.does` describes `scripts/sync.sh` (npx skills add `--all`, `update -p -y`, `--quiet`) that SKILL.md never states; the prose says only "calls `npx --yes @oneezy/skills-sync` with the arguments given". The wrapper ticket rewrites both (add goes through a staged clone). | Rewrite together in the wrapper ticket.
- `skills/oneezy/oneezy-skills/flow.yaml:25-30` | minor | SKILL.md:25 "On Windows it also syncs the WSL distros it remembers" has no step or outcome. | Add to `run-script.does`.
- `skills/oneezy/oneezy-skills/flow.yaml:16` | minor | `unresolved: @oneezy/skills-sync`: the prose span is `npx --yes @oneezy/skills-sync` (starts with `npx`), so no `@Name` token exists there; the declaration is harmless. | Keep or drop.
- `skills/oneezy/oneezy-brain/flow.yaml:23-29` | minor | Omits `tree` ("run `tree` once per session if unsure of the names") and the `gh issue comment` write path ("add a historical comment instead of creating a duplicate"). | Add to `remember.does`/`needs`.
- `skills/oneezy/oneezy-brain/flow.yaml:70-76` | minor | `move` runs `move <number>` straight after `map-request`; the number has to come from `find`. SKILL.md's table row is equally terse. | `after: [map-request, find]`, or leave as a mirror.
- `skills/oneezy/oneezy-merge/flow.yaml:44-48` | minor | `land` omits "title = PR title plus `(#<pr>)`" and the "verify `origin/<base>` contains the squash commit (stop if not)" fail. | Add a second `fail` clause.
- `skills/oneezy/oneezy-remote/flow.yaml:3,16` | minor | `runtime` entry is a sentence (convention: free text kept short); `preview.if` counts `workspace` as a mutation, which SKILL.md implies but never says. | Shorten; leave `if`.
- `skills/oneezy/oneezy-brain/flow.yaml:8`, `skills/oneezy/oneezy-status/flow.yaml:13` | minor (decision) | `need: example` is used for pure mentions (`/wayfinder` as a boundary; `/oneezy-merge` "never called"); the taxonomy has no mention value. | Justin decides: add `mention`, or bless `example` for it in references.md.
- `skills/oneezy/oneezy-status/SKILL.md:36-44` | minor (decision) | Tokens sit inside longer backticked spans (`/wayfinder Work through map #<map> …`, `Commit only when I say so, then run /oneezy-merge`); references.md does not say whether `check` reads the leading `/name` out of a multi-word span. | Define it in references.md (leading-token rule or exact-span rule).
- `skills/trident/*/SKILL.md` | minor (decision) | Code fences hold `@render`, `@sveltejs/kit`, `@layerd/ui`; prose holds Trident-repo paths (`packages/ui/AGENTS.md`, `apps/app/AGENTS.md`, ADR paths) that are file tokens by the convention but resolve neither here nor beside the skill, and are not declared unresolved. | references.md: exempt code fences, and say how a path in another repo is written (bare, or `unresolved`).
- `skills/trident/oneezy-ui-component/flow.yaml:13-30` | minor | Nine JSDoc tags and `@reference` declared `unresolved`; honest and complete (all eight tags in the prose are listed), but noise that the code-fence/prose rule above would remove. | Follows from the decision above.
- `skills/trident/*/SKILL.md` | minor (writing-for-agents) | Both open with "the rules stay in their homes and are not repeated here", then steps 2-6 restate Trident's AGENTS.md/CONTEXT.md rules (a cache that will go stale); hard-wrapped at ~75 columns unlike the six oneezy skills. Completion criteria are strong (0/0 check, zero-diff second barrel run) and prohibitions are paired with the positive target. | Leave for now; prune when Trident's AGENTS.md is the source of truth.
- `skills-lock.json` | minor (fact) | Unchanged by #28: 38 entries, still `resolving-merge-conflicts` and three `skills/in-progress/` paths that upstream moved to `skills/engineering/`. README now says `refresh` writes it. | None until `refresh` exists; do not hand-edit.

## Open questions

- Does `check`'s token extractor read code fences, multi-word backticked spans and paths in other repos? references.md is silent; the three Trident/status findings hinge on it.
- Is `need: example` the intended value for a skill that is only mentioned (boundary or "never called")?
- Should PStack's two display-case `name` fields be transformed, given #27 excludes editing third-party content?

## Blockers

- For the rename agent only: `.gitignore` ignores `skills-sync.json`, and README/AGENTS.md describe `skills-sources-lock.json`; both must change in the same PR as the rename or the committed config disappears from git.
- No `flow.schema.json` or manifest parser exists on `oneezy/tools@d74da7e` (`src/config.ts` still models only the per-machine answers), so nothing validates these flows or the sources file today; the mechanical sweep in this note is the only check that has run.

## Raw notes

- Token-pass diff (28663fa → 7d91501), SKILL.md only: brain 1 line (`wayfinder` → `` `/wayfinder` ``), estimate 1 line (link → path), merge 2 lines (quoted above), status 1 line (link → path), remote 0, skills 0; `STATUS.md`, `agents/openai.yaml` and scripts unchanged (rename-only). HEAD cc7be4d changed none of the eight SKILL.md or flow.yaml files after #28.
- Trident originals: `layerdbiz/tridentcubed@dev` `.claude/skills/{oneezy-app-route,oneezy-ui-component}/SKILL.md` diff against the library copies: identical after CR normalization.
- Matt Pocock: manifest 37, upstream HEAD 37 `skills/**/SKILL.md`; set difference empty both ways; no duplicates. Upstream paths are nested (`engineering/`, `in-progress/`, `misc/`, `productivity/`), the manifest uses `root: skills` plus flat names, so the moved paths in the inventory need no manifest change.
- Pin: `321658273cb1d20b76026717d027d505790106d4` = 2026-08-19 "Remove all em-dashes from the repo"; `skills/productivity/writing-for-agents/SKILL.md` blob `a37608d` at the pin and at HEAD; no commit touches the folder after the pin (`commits?path=`). Matches writing-for-agents-pin.md facts 7-10 and the lock hash `95da47fc…`.
- Attribution: `LICENSE`, `README.md` present at `mattpocock/skills` root; `pstack/LICENSE`, `pstack/README.md` present in `cursor/plugins`.
- PStack: manifest 47 keys, upstream `cursor/plugins@main` 47, `backnotprop/pstack@main` the same 47; set difference empty; 23 `principle-*`; renames `{tdd: pstack-tdd, teach: pstack-teach}`; no target collides with a Matt name. Policy `follow` means the snapshot will carry upstream's current frontmatter (Cursor keys, display-case names, Opus 5.5 defaults per pstack.md fact 7), not the normalized copies in `~/.codex/skills`.
- Plugins block: `oneezy` description lists six skills (matches the six folders); `trident` two; `matt-pocock` and `pstack` reference their sources by id.
- Mechanical sweep output: every file passed ids/edges/outcome/loop/ref-enum checks; prose `/`,`@` spans per skill: brain `/wayfinder`; estimate none; merge `/oneezy-status`; remote none; skills none; status `/ask-matt`, `/diagnosing-bugs`, `/grill-with-docs`, `/implement`, `/oneezy-merge`, `/wayfinder`, `/wizard`; app-route `/oneezy-ui-component`, `@layerd/ui`; ui-component `/tdd`, `@layerd/ui`, `@dev`, `@enable`, `@ignore`, `@layout`, `@props`, `@reference`, `@story`, `@tags`, `@type`. Missing from flows: none. Every declared skill ref resolves to an own skill or one of the 37 Matt names.
- The `agents.max: 0` claim holds for all eight: no SKILL.md spawns subagents.
