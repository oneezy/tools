## Land

For a normal requested update/add/playground change, use the landing path below. A development, review-only or no-publication request instead uses an isolated review branch and stops at the verified artifact; never open a ready pull request or promote `main` in that scope. Preserve existing rollout branches and dirty work.

1. **Clone.** `git clone https://github.com/oneezy/tools` at `dev` into a temporary folder, create a branch named by `/oneezy-naming`, and work in `packages/skills`: run the script with `refresh --frozen --repo .` before any build. Third-party snapshots under `upstream/` are uncommitted; the frozen restore materializes them without moving pins. Never edit in a checkout Justin works in, in a harness's folders, or in oneezy/skills (a generated mirror): what a machine installs comes from the release, not from any checkout.
2. **Build and check.** For authored skill or packaging changes, set the shared `library.version` to the release version chosen from the emoji-first conventional title: fix → patch, feat → minor, ! or BREAKING CHANGE → major, otherwise none. Pure upstream snapshot updates retain the source lock version and do not invent a wrapper version. See `docs/agents/release.md`. After the change, in `packages/skills`: the script with `build --repo .`, then `check --repo .`. Done when `check` exits 0. Nothing changed (`git status` clean): there is nothing to land; report that and stop.
3. **Open the pull request.** Commit (conventional subject, the harness's attribution trailers), push, and open a ready pull request into `dev`. tools' automerge lands it once checks are green; no session merges it.
4. **Wait.** Over REST (`gh api`): the pull request merged into `dev`. The release follows Justin's next `/oneezy-merge release` in oneezy/tools, which promotes `main` and publishes `release-<n>` through the mirror. Done when the pull request is merged; report that the change waits for that line, and give it in a code block.
5. **Take it here.** Once `repos/oneezy/skills/releases/latest` is the new `release-<n>`: the script with no arguments (a quiet sync: it reads the release from GitHub, not from the clone), then delete the temporary folder. The report ends with the open manual steps (`SKILL.md`, step 6).
6. **Migrate.** Run `/oneezy-migrate` with the update report (the `--json` output from the change), or with "no update report" after a playground change. It changes nothing when no note applies.

The library's daily upstream check (ADR-0009) ran in oneezy/skills' `run.yml`; it is paused while the library lives in tools, so `update` runs only when Justin asks.

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
