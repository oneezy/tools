## Land

For a normal requested update/add/playground change, use the landing path below. A development, review-only or no-publication request instead uses an isolated review branch and stops at the verified artifact; never push land/* or promote main in that scope. Preserve existing rollout branches and dirty work.

1. **Clone.** `git clone https://github.com/oneezy/skills` at `dev` into a temporary folder and create branch `land/<topic>` there, then run the script with `refresh --frozen --repo .` before any build. Third-party snapshots under `upstream/` are uncommitted; the frozen restore materializes them without moving pins. Never edit in a checkout Justin works in, and never in a harness's folders: what a machine installs comes from the release, not from any checkout.
2. **Build and check.** For authored skill or packaging changes, set the shared `library.version` to the release version chosen from the emoji-first conventional title: fix → patch, feat → minor, ! or BREAKING CHANGE → major, otherwise none. Pure upstream snapshot updates retain the source lock version and do not invent a wrapper version. See `docs/agents/release.md`. After the change, in the clone: the script with `build --repo .`, then `check --repo .`. Done when `check` exits 0. Nothing changed in the clone (`git status` clean): there is nothing to land; report that and stop.
3. **Push.** Commit (conventional subject, the harness's attribution trailers) and `git push -u origin land/<topic>`. The `land` workflow (`.github/workflows/land.yml`) checks it, squashes it into `dev`, promotes `main` and releases; no session merges anything.
4. **Wait.** Over REST (`gh api`): the `land` run for the branch (`repos/oneezy/skills/actions/runs?branch=land/<topic>`), then the `library` release run it starts on `main`. Done when `repos/oneezy/skills/releases/latest` is a new `release-<n>`. A red `land` run lands nothing: report its failing step and stop.
5. **Take it here.** The script with no arguments (a quiet sync: it reads the new release from GitHub, not from the clone), then delete the temporary folder. The report ends with the open manual steps (`SKILL.md`, step 6).
6. **Migrate.** Run `/oneezy-migrate` with the update report (the `--json` output from the change), or with "no update report" after a playground change. It changes nothing when no note applies.

A session that cannot clone or push oneezy/skills (a cloud thread; a push refused for lack of access) takes **Dispatch** instead of steps 1 to 3: the library runs the command itself and pushes the branch.

## Dispatch

The library runs `update`, `add`, `remove` and `versions` itself in `.github/workflows/run.yml` (ADR-0014): the latest published tool against `dev`, and a push of `land/<command>-<args>-<run id>` when anything changed, so from the push on nothing differs from **Land**. The same workflow runs `update` with no arguments every day, the upstream check (ADR-0009).

1. **Start it.** `command` is one of `update`, `add`, `remove`, `versions` (`rename` is in the workflow's list, ADR-0014, but not in the tool yet; a dispatch of it fails. Take a skill under another name with `add <source> --as old=new` (a new source) or a transform in `skills-sync.json`); `args` is the command's arguments as one string, split on spaces, empty for `update` of every unheld source: `gh api repos/oneezy/skills/actions/workflows/run.yml/dispatches -f ref=dev -f 'inputs[command]=update' -f 'inputs[args]=matt-pocock --to 1.3.0'`. Success prints nothing (HTTP 204). Any client that can make that REST call does the same.
2. **Find the run.** `gh api 'repos/oneezy/skills/actions/runs?event=workflow_dispatch&per_page=5' --jq '.workflow_runs[] | select(.path == ".github/workflows/run.yml") | "\(.id) \(.status) \(.conclusion) \(.html_url)"'`, newest first; poll `repos/oneezy/skills/actions/runs/<id>` until `status` is `completed`.
3. **Read it.** `gh api repos/oneezy/skills/actions/runs/<id>/jobs --jq '.jobs[].steps[] | "\(.name): \(.conclusion)"'` names a failed step; the log is the run's page (`html_url`). `versions` only prints there. A changed `update`, `add` or `remove` pushed `land/<command>-<args>-<run id>` and the run's notice names it: continue at **Land** step 4 with that branch. An unchanged run pushed nothing and says so.
4. **Migrate.** As **Land** step 6, with the landed commit's body as the update report (`gh api repos/oneezy/skills/commits/dev --jq .commit.message` once the land run is green): each moved source's versions, the upstream changelog between them, and the lines flagged for `/oneezy-migrate`.

## Change

Moves third-party sources between upstream versions. Topic: `update-<sources>` (`update-all` when none is named).

1. In the clone, the script with `update [<source>] [--to <version>|previous|latest] --json --repo .`. `update` with no source moves every source to latest except one the config holds at a `version`. Keep the JSON: `updated` lists each source that moved with `from`, `to` (each `{ version, commit, ahead }`), `direction` and `changelog`; `config` lists the config change a hold needs. `{ "refused": ... }` (a version the source never released) ends the change: report the versions it names.
2. Apply `config` to `skills-sync.json` in the clone: `{ source, version: "1.3.0" }` sets `sources.<source>.version` to that string; `version: null` removes the key. This is what makes a downgrade or an exact version stick on every machine, and what clears it again on "update X" (`--to latest` prints the removal when a hold exists). The tool never writes the config itself.
3. **Land**, then the report: per moved source `<source>: <from version> → <to version>` (with `(+N commits)` when `ahead` is set, and the short commits), then the changelog's headings and its breaking or migration lines, not the whole text; `changelog: none (<reason>)` when the tool gave none. A downgrade lists what it undoes. Nothing moved: "every source is already at latest" (or at its held version) and no land.

## Add

Brings a new third-party source in. Topic: `add-<id>`.

1. **Name the source.** `owner/repo` takes every skill under the repo's `skills/` (or its root). A link to one skill, `https://github.com/<owner>/<repo>/tree/<ref>/<path>/<name>`, is `<owner>/<repo>#<ref>` with `--root <path> --skills <name>`. Several named skills of one repo go in one `--skills a,b`. A source already declared in `skills-sync.json` is not added again: edit its `skills` list in the clone instead, then run `update <source> --repo .` there.
2. In the clone, the script with `add <source> [flags] --repo .`. Done when the new plugin is under `plugins/` after **Land**'s build.
3. **Land**. The report ends with the release tag and the skills it installed.

## Playground

The `play` group (`skills/play/`) is where Justin tries a skill before it joins `oneezy` or `trident`. It is packaged and released like any group (`/play:<name>` as a plugin). Every skill in it is named `play-<name>`, always; `check` fails on one that is not. Topic: `play-<verb>-<name>`.

- **Copy** ("add PStack's unslop to my playground"): find the skill in its repo (a declared source's repo and `root` from `skills-sync.json`, or the repo Justin names), `git clone --depth 1` that repo into another temporary folder, and copy the skill's folder to `skills/play/play-<name>/`. In its `SKILL.md` frontmatter set `name: play-<name>` and add, inside `metadata:` (create the map when missing), `origin-repo: <owner/repo>`, `origin-path: <path of the folder upstream>`, `origin-commit: <full commit>`. Copy the nearest `LICENSE` at or above the skill's folder upstream into the skill's folder, so its notice travels with the copy. Change nothing else; the source keeps its own copy (`/unslop` stays).
- **Create** ("make a skill that does X in my playground"): write `skills/play/play-<name>/SKILL.md` (frontmatter `name` and a `description` that says what it does and when to use it, then the instructions) and a `flow.yaml` beside it in the shape `docs/agents/references.md` gives.
- **Remove**: delete `skills/play/play-<name>/`. The build drops its copy and, with the last one, the `play` package.
- **Promote** ("move X from my playground into oneezy"): `git mv skills/play/play-<name> skills/<group>/<prefix>-<name>` with `group` `oneezy` and prefix `oneezy-` (for Trident, `trident` and `trident-`) unless Justin names the group or the new name; set the frontmatter `name` and `flow.yaml`'s `skill` to the new name, change every `/play-<name>` in the library's prose to the new token, and add the skill to that plugin's `description` in `skills-sync.json`.

Then follow the authorized landing or review scope; the report names the skill as Justin will call it (Claude Code `/play:play-unslop`, Codex `$play-unslop`).
