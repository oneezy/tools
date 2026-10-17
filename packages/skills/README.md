# skills

This library now lives in the tools monorepo as `@oneezy/skills`. Start with [local development](DEVELOPMENT.md). The standalone release instructions below are retained as historical reference.

Justin's agent skills and the third-party skills he uses, in one library. Vocabulary in `GLOSSARY.md`, decisions in `docs/adr/`, how skills name each other in `docs/agents/references.md`.

## Install

```
npx skills add oneezy/skills                 # Justin's own skills, for anyone
npx --yes @oneezy/skills-sync@latest         # the whole library on one of Justin's machines, from the latest release, no clone
/plugin marketplace add oneezy/skills        # Claude Code: plugins oneezy, trident, play, matt-pocock, pstack, diagram-design, frontend-design
codex plugin marketplace add oneezy/skills   # Codex: the same
```

Each harness gets the library one way (ADR-0007): Claude Code the plugins switched on at claude.ai, Codex and Hermes plugins from GitHub. A plugin skill is called the way its harness resolves it (`/oneezy:oneezy-status` on Claude Code, `$oneezy-status` on Codex; the table is in `docs/agents/library.md`). The sync reads the latest release of `oneezy/skills` on GitHub, writes one skills block into each harness's global instructions file and one session-start hook entry, and asks nothing and remembers nothing; it ends by listing the manual steps only a person can do, which `npx --yes @oneezy/skills-sync@latest status` shows at any time. In a cloud session the setup script line is `npx --yes @oneezy/skills-sync@latest --quiet`. The tool is the `@oneezy/skills-sync` package in `oneezy/tools`.

`npx skills add oneezy/skills` installs the nine own skills, each once: the copies under `plugins/<id>/skills/` are marked `metadata.internal: true` and skipped, and `npx skills update` keeps them current. The same listing from a local path (`npx skills add <clone> --list`) shows those nine; with `--full-depth` on a clone that has been refreshed it shows the snapshots under `upstream/` too, 82 more (the third-party skills under their upstream names), because the ignored `upstream/` folder exists on disk there and never in a GitHub source.

## Layout

| Path | What |
|---|---|
| `skills/<plugin>/<skill>/` | own skills, grouped by the plugin that packages them: `oneezy/` holds Justin's seven, `trident/` the two for the Trident monorepo, `play/` the playground (every skill in it named `play-<name>`; empty until Justin tries one) |
| `skills/<plugin>/<skill>/SKILL.md` | the skill, in bare Agent Skills form (plus optional `scripts/`, `references/`, `agents/openai.yaml`) |
| `skills/<plugin>/<skill>/flow.yaml` | what the skill does today: steps with stable ids, references, outcomes |
| `skills-sync.json` | the config: the library, the two switches (`generate.skills`, `generate.plugins`), third-party sources with their selections, renames, pins, held `version` and attribution files, and the plugins |
| `skills-sync.lock.json` | what is installed, per source: repo, ref, upstream version (plain semver, or null), commit and date, and each skill's upstream path and content hash (plus a commit where a pin holds it elsewhere) |
| `upstream/<source>/` | snapshots of each source's selected folders at the lock's commit, never edited; gitignored |
| `plugins/<id>/` | one built plugin per group and per source: `plugin.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `skills/`, `LICENSE`, `NOTICE.md`; committed |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | the catalogs: every plugin with a `./plugins/<id>` source, so the library is its own marketplace; committed |
| `artifacts/` | ChatGPT upload archives, one per plugin, with `releases.json`; gitignored |
| `.legacy/` | prompt-era files, no skills |

A folder directly under `skills/` with no `SKILL.md` is a group, and its name is the plugin id. Skill folder names never change, so `/oneezy-brain` is the same skill whether linked or installed as `/oneezy:oneezy-brain`.

Third-party skills come from four sources: `matt-pocock` follows `main` of `mattpocock/skills` (38 skills, `writing-for-agents` pinned to one commit), `pstack` follows `main` of `cursor/plugins` under `pstack/` (47 skills, `tdd` and `teach` renamed `pstack-tdd` and `pstack-teach` beside Matt's), `anthropic` takes `frontend-design` from `anthropics/skills`, and `diagram-design` takes `diagram-design` from `cathrynlavery/diagram-design`. The lock records each source's upstream version: the nearest release tag (Matt's `1.3.1`), else the source's plugin manifest version (PStack's `0.15.15`), else none. `sync` never moves a source: a release carries exactly what the committed lock says. `update` moves one, to the tip of its `ref`, or to the `version` the config holds it at (`update <source> --to <version>|previous|latest` prints the hold to write); a `pin` holds one skill at one commit. The library runs `update` over every unheld source once a day and any library command on demand from any session (`.github/workflows/run.yml`; ADR-0009, ADR-0014), landing each change through `land/*` with the report in the commit. `versions <source>` lists what a source has released. Ask `/oneezy-skills` ("update the Matt Pocock skills", "downgrade PStack to the previous release") and it lands the change through `land/*`, releases and syncs, then runs `/oneezy-migrate` for any upstream migration note. Add a source with `npx @oneezy/skills-sync add <owner/repo>`.

## Generated versus committed

| File | Written by | In git |
|---|---|---|
| `skills/`, `skills-sync.json`, `docs/` | hand (`add` writes a source entry) | committed |
| `skills-sync.lock.json` | `update` (alias `refresh`) and `add`: per source its version, commit and date, per skill its upstream path and hash | committed |
| `plugins/<id>/` | `build --plugins`: one package per group and per source | committed |
| `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` | `build --catalogs`: the plugins, each at `./plugins/<id>` | committed |
| `upstream/` | `refresh` | ignored |
| `artifacts/` | `build --artifacts` | ignored |
| `.agents/skills/` | `refresh`: the working set `build` packages (a copy of each third-party skill) | ignored |

Generated files are regenerated, never hand-edited. Before committing, run `npx @oneezy/skills-sync check`: it validates every own skill's frontmatter and `flow.yaml` and fails when a committed generated file drifts from what the config, the lock and the skills would produce. CI runs the same command on every pull request and on pushes to `dev` and `main`. It is a command you run, not a git hook; nothing is installed in the clone.

## CI

`.github/workflows/library.yml` checks and releases; it never pushes to `dev` or `main`. Its `check` job installs the latest published `@oneezy/skills-sync` from npm (every caller runs `@latest`, ADR-0008; no `oneezy/tools` commit is pinned) and runs `refresh --frozen`, `build --check` and `check` against the checkout, then `claude plugin validate` on every committed package and the catalog. Its `release` job cuts `release-<n>` for a `main` commit that changes a package (`docs/agents/release.md`). `.github/workflows/run.yml` runs the library commands (`update`, `add`, `versions`) on demand from any session and `update` over every unheld source every day, landing any change through `land/*` (ADR-0009, ADR-0014); `.github/workflows/land.yml` takes a `land/*` branch to `dev`, `main` and a release. Uploading a plugin to ChatGPT is a hand-run checklist: `docs/agents/chatgpt-upload.md`.
