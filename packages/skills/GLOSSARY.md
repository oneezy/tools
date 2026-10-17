# Glossary

The words this library uses, one meaning each. Implementation lives in the tool's README and the ADRs, not here.

- **Library**: this repository. One place holding every skill Justin uses: the ones he writes and the ones he pins from others.
- **Own skill**: a skill authored here, under `skills/`. Edited here and nowhere else.
- **Group**: a folder directly under `skills/` that holds own skills rather than a `SKILL.md`. A group's name is a plugin id (`oneezy`, `trident`, `play`). A folder under `skills/` that holds `SKILL.md` itself is a **flat** own skill, still accepted.
- **Playground**: the `play` group, where Justin tries a skill (his own idea, or one copied from another repo) before **promoting** it into `oneezy` or `trident`. Every skill in it is named `play-<name>`.
- **Source**: a third-party repository the library takes skills from (`matt-pocock`, `pstack`, `anthropic`, `diagram-design`), declared in the **config** with the `ref` it follows.
- **Version**: a source's upstream release as plain semver (`1.3.1`, never `v1.3.1`): its nearest release tag, else its plugin or package manifest's version, else none. Shown as `1.3.1 (+4 commits)` when the commit is past the release.
- **Hold**: a `version` on a source in the config; the source stays at that release until the config changes. No `version` means latest.
- **Pin**: a commit in the config that holds one skill while its source follows its `ref`, moved by editing the commit. A `ref` that is itself a commit holds the whole source.
- **Config**: `skills-sync.json`, the one committed, hand-edited declaration: library metadata, the two **switches** (`generate.skills`, `generate.plugins`), sources with selections, renames and pins, and plugin ids.
- **Machine facts**: what a run finds out about the machine it runs on: which harnesses are installed and where, WSL distros. Detected every time, never written down. _Avoid_: local file (`skills-sync.local.json`, retired by ADR-0012).
- **Lock**: `skills-sync.lock.json`, the one tool-written record of what is installed, grouped per source: repo, ref, version, commit and date, then each skill's upstream path and content hash. Replaced `skills-lock.json` (the `npx skills` format) with skills-sync 0.5.0.
- **Snapshot**: the selected folders of one source at its resolved commit, kept under `upstream/<source>/` at their upstream paths. Generated; never edited.
- **Update**: resolving the named sources (every one when none is named) at latest, at their **hold**, or at the version asked for (`--to <version>|previous|latest`), snapshotting, writing the lock, rebuilding the working set, and reporting each moved source's old and new version with the upstream changelog between them. Run by the daily **upstream check**, or when asked. **Refresh** is its old name. **Frozen** refresh uses the lock's commits and moves nothing; every **sync** runs it.
- **Migration note**: a changelog entry that asks something of a consumer (a renamed file convention, a removed skill). `/oneezy-migrate` applies them across Justin's repos.
- **Working set**: `.agents/skills/` in a library checkout, one copy per third-party skill from its snapshot (with its **transform** applied, such as a rename), which `build` packages. Written by `refresh`; never on a machine.
- **User folder**: a harness's home-level skills folder (`~/.claude/skills`, `~/.agents/skills`, Codex's old `~/.codex/skills`). Older versions linked every skill into it; now the tool only removes its own leftover links there and names what else it finds, to adopt into the library or delete by hand.
- **Sync**: making every harness on a machine match the latest release, in its one **form**, with its **hook** and **global block** in place. Changes only what differs; silent when nothing changed.
- **Wrapper**: the `oneezy-skills` skill and its scripts, the way an agent runs the tool. It ends every run with the open **manual steps**.
- **Manual step**: something only a person can do (switch an account plugin on, trust the Codex hook once, uninstall a doubled Codex plugin, bring the ChatGPT **account copies** up to the release, adopt or delete what sync leaves, replace a cloud setup line). `status --json` lists them as `manualSteps`; a machine is **done** when `ok` is true and none is open.
- **Invocation table**: how each harness calls a skill (`/<plugin>:<skill>` on Claude Code, `$<skill>` on Codex, `/<skill>` for a loose Hermes skill, `/agent-plugin-<id>-<hash>:<skill>` for a plugin's). Shown when a typed skill does not resolve; an agent never fetches a `SKILL.md` to run instead.
- **Rendering opt-in**: a key in the config (`renderings.hermes`) that switches on generator output a tool change added, so the tool releases first and the library takes the new output after.
- **Plugin**: a package of skills a harness installs as one unit, namespaced by its id (`/oneezy:oneezy-brain`). The library builds one per group and one per source into `plugins/<id>/`, committed beside the source.
- **Hermes rendering**: the copy of a plugin that Hermes loads, generated by `build` at `dist/hermes/<id>/` beside `plugins/<id>/` because the config opts in (`renderings.hermes`): the package without the Claude Code and Codex manifests, each skill's `SKILL.md` with `name` set to its folder and `metadata` cut to string entries (Hermes rejects the `metadata.internal` flag the package carries), every other file byte for byte the package's. Installed with `hermes plugins install oneezy/skills/dist/hermes/<id>`; Hermes lists its skills as `agent-plugin-<id>-<hash>:<skill>`.
- **Form**: how a harness gets the skills: the **plugin form** (an installed plugin: the account plugins on Claude Code, plugins from GitHub on Codex and Hermes) or, only where a harness has no plugin route, the **loose-skill form** (links). Each harness gets exactly one, never both.
- **Account plugin**: a plugin switched on in Justin's claude.ai account. Claude Code receives it as `<id>@synced`, on his machines and in the cloud.
- **Catalog**: a marketplace file at the root that lists the plugins and points at `./plugins/<id>` (`.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`).
- **Build**: generating plugins, catalogs and artifacts from the own skills and the snapshots. **Check** validates frontmatter, flows and generated-file drift, writes nothing, and is a command, never a hook.
- **Artifact**: an archive of one plugin, under `artifacts/` and attached to each GitHub release; the ChatGPT update reads it.
- **Account copy**: a library plugin on Justin's ChatGPT account (personal or workspace). Changed only inside ChatGPT, when he types the update line (ADR-0015); a Codex signed in with ChatGPT lists it as `<id>@created-by-me-remote` or `<id>@workspace-*`, which is how `status` verifies it. _Avoid_: release (that word means `release-<n>`).
- **Reference token**: how prose names a skill (`/oneezy-brain`), a plugin or app (`@GitHub`), a file (`docs/agents/references.md`): the identity, never the invocation.
- **Registry**: `skills-registry.json`, the generated index of every skill's identity, host invocation forms, plugin, source and relationships. Deferred until the Skills app exists.
- **Flow**: `flow.yaml` beside an own skill's `SKILL.md`: its steps, references and outcomes in machine-readable form, describing what the skill does today.
- **Harness**: a coding agent product that reads skills (Claude Code, Codex, Hermes; Goose is dropped until a harness needs it). ChatGPT is not one: it has no machine to sync, only **account copies**. **Host** is the same thing seen from a reference token.
- **Harness default**: a skill, plugin or hook a harness ships with or that came from outside the library. Never touched.
- **Hook**: the one session-start entry the tool writes into a harness's settings; it runs a quiet sync and reports checkout drift.
- **Global block**: the tool's marked section in a harness's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`). Never in a repository. Its text is the tool's own pointer: load `/oneezy-agents` at session start, plus the invocation table (oneezy/tools#205).
- **Justin's rules** (`AGENTS-GLOBAL.md`): `skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md`, Justin's one set of rules for every harness, machine and cloud session: a short router to his Oneezy skills plus the few rules no skill should own (approvals, safety, communication, git basics). `/oneezy-agents` reads it from the installed oneezy plugin, never a remote copy (ADR-0018). It is edited in place and nowhere else, with no copy step (ADR-0019), and a change reaches sessions with the next plugin release. Distinct from the repo's own root `AGENTS.md`, which only guides work on this repo. It replaced `SHARED.md`, which skills-sync 0.12.0 to 0.15.0 copied verbatim into the **global block**.
- **Upstream check**: the daily comparison of every unheld source with its upstream; any difference lands as an **update**.
- **Machine command**: a command that acts on the machine or repositories it runs on (`sync`, `status`, `hook`, `branches`, `unlink`). A **library command** changes the library (`update`, `add`, `versions`) and runs as a workflow in it.
- **Keep suffix**: `-keep` at the end of a branch name. Such a branch is never deleted; neither are `main`, `dev` and any branch starting with `research/` or `prototype/`.
- **Archive tag**: `archive/<name>`, the tag a branch closed without merging gets before it is deleted.

- **Capability contract**: the portable obligations for resolving, authorizing and verifying a dependency.
- **Host adapter**: the supported discovery and action route for one product surface.
- **Capability catalog**: the maintained inventory of dependency identities and dated evidence, including unknowns.
- **Delivery**: one installed or saved instance of a source artifact; standalone and bundled skills are separate deliveries.
