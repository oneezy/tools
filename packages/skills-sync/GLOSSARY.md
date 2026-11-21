# Skills sync

One skills library, linked into every Harness on every Host, with third-party skills held at the versions the lock records. Shared words (Harness, Host, Surface) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md).

## Language

### The library

**Library**:
The Own skills and selected third-party skills maintained together and distributed to Harnesses. A Library can belong to a larger workspace; it does not require a separate Git repository.
_Avoid_: repo, collection, registry

**Development project**:
A project explicitly opted in to using the Library's development Plugins instead of their released counterparts. Other projects retain their normal plugin selection.

**Development build**:
Generated Plugins made from the current working Library for local testing. The last successful Development build remains available when a later build fails.

**Development watcher**:
The one process per Library that rebuilds the Development builds its Development projects select as the source changes (`develop watch`). The terminal that starts it owns it and stops it by closing. A later launch names the owner and starts nothing (ADR-0005).
_Avoid_: daemon, service, the loose-skill watcher (`develop --watch`, which only keeps links in step)

**Source alias**:
The link `.agents/skills-library` in a Development project, to the Library root, through which the project edits the one source. Never a copy.
_Avoid_: mirror, checkout

**Project record**:
`.agents/skills-sync-project.json` in a Development project: its Library, its selected Plugins, and what setup made and replaced, so that remove takes back exactly that.
_Avoid_: receipt (the loose-skill `develop` keeps one), settings

**Project plugin**:
A Plugin installed for one project. In a local Development project, it takes precedence over its matching marketplace copy; unrelated external Plugins remain available.

**Development marketplace**:
The marketplace of the Library's Development builds, read from `dist/development`: on Codex `<release marketplace>-dev` (`oneezy-skills-dev`), switched off for every project and on in each Development project's `.codex/config.toml` (`docs/adr/0007`); on Claude Code `<release marketplace>-development`, declared and installed per project (`docs/adr/0006`). Sync and the release build never touch it (`docs/adr/0008`).
_Avoid_: dev catalog (the Catalog is its file)

**Own skill**:
A skill written in the Library itself, flat or inside a Group.
_Avoid_: local skill, custom skill

**Group**:
A folder of own skills under `skills/` whose name is the Plugin they are packaged as (`oneezy`, `trident`).
_Avoid_: category, namespace

**Playground**:
The Group named `play`, where a skill is tried before it is promoted into another Group. Every skill in it is named `play-<name>`; Justin also says "play".
_Avoid_: sandbox, scratch

### Third-party skills

**Source**:
A third-party repo the Library takes skills from, declared in the config with its Selection, renames and pins (`matt-pocock`, `pstack`, `anthropic`, `diagram-design`).
_Avoid_: upstream, vendor, dependency

**Selection**:
Which of a Source's skill folders the Library takes: a list, a map that also renames, or `"*"`, every folder under the Source's root now and later (renames then go in `rename`). An update names every folder a list or a map leaves out as "not selected upstream".
_Avoid_: whitelist, filter

**Lock**:
The committed record of what each Source is installed at: upstream version, commit, date, and each skill's content hash. A plain sync installs exactly the Lock.
_Avoid_: lockfile, manifest

**Hold**:
A Source kept at one upstream version by the config; without one, a Source follows its latest release on every update.
_Avoid_: freeze, lock (the Lock records, a Hold decides)

**Pin**:
One skill kept at its own commit while the rest of its Source moves.

**Snapshot**:
A Source's selected skill folders at the commit the Lock records, copied under `upstream/`. Never edited.
_Avoid_: vendor copy, cache

**Adapt rule**:
One plain find/replace (a regular expression and its replacement) in a Source's `adapt` block, so skills written for one Harness read right in every other. Build applies the rules in order to the Markdown and text files it copies into a Plugin; scripts, the Snapshot and the Working set stay as upstream wrote them. No model takes part.
_Avoid_: rewrite, port, patch

**Forbidden term**:
A pattern in a Source's `adapt.forbid` that no adapted file may still match once the Adapt rules ran, unless an `adapt.allow` pattern matches that line. One left fails `check`; one in new upstream text is a warning from `update`.
_Avoid_: banned word, blocklist

### Runs

**Sync**:
The default run: pull the Library, restore every Source from the Lock, rebuild the Layers and link the User folders. Never moves a Source.
_Avoid_: install, refresh

**Update**:
The run that moves a Source to its latest release, a Hold, or a version asked for (`--to`), and rewrites the Lock. Justin also says upgrade or downgrade.
_Avoid_: refresh (the internal step), bump

**Session hook**:
The one `SessionStart` entry `sync` keeps in a Harness's user hooks file (`~/.claude/settings.json`, `~/.codex/hooks.json`) that runs `npx --yes @oneezy/skills-sync@latest hook` when a session starts or resumes (ADR-0010 in oneezy/skills). Known by its command, never by its position; every other entry is left alone. Codex runs it only once Justin has trusted it in the TUI, and again after it changed from the form he trusted (Codex checks the recorded hash); the report names it trusted, new or changed, and the trust is a manual step the tool never writes.
_Avoid_: startup hook, the old `sync-dev.sh`

**Checkout**:
A local git repository the `hook` command tends, whoever owns it and wherever its `origin` points: on a clean `dev`, fetched and fast-forwarded only; named and left alone when dirty or on another branch; not mentioned at all when it has no `dev` branch or no `origin`. Found on every run: the repository the session started in (its main worktree, when the session started in a linked one such as `<repo>/.claude/worktrees/<name>`) and the git repositories directly beside it, or, outside any repository, the ones directly inside the session's folder; a linked worktree is never a Checkout. `status` judges only the Checkouts of `oneezy/skills` and `oneezy/tools`, known by their `origin` URL: green on `dev` and clean, red otherwise, and red when git cannot read it.
_Avoid_: worktree (a Remote sessions word), working copy

**Red line**:
A `status` line marked `!`: something the machine has wrong that `sync` or a cleanup fixes (a plugin behind the Release, a skill listed twice, a missing Session hook entry, a stale or hand-edited Global block, a block in a repository file, a dirty or off-`dev` Checkout, or one git cannot read). A plugin ahead of the Release is a note, not a red line. Any red line makes `status` exit 1; `/oneezy-status` is done when there is none.
_Avoid_: error, failure (a failed action is a conflict)

**Manual step**:
Something only Justin can do, which `status` lists after the red lines as a numbered block of steps and counts in its summary: switch an Account plugin on at claude.ai, trust the Session hook in Codex, uninstall a plugin from another marketplace that doubles a Library one, bring the ChatGPT Account copies up to the Release by typing one line in ChatGPT, adopt or delete what is left in Codex's skills folders, make the cloud run the new setup line when the old one ran in the session. Never a red line and never the exit code, and never hiding one.
_Avoid_: todo, action item, warning

**Working set**:
One entry per skill the Library offers: a copy per third-party skill, a link per Own skill, under `.agents/skills/`.

**Layer**:
A Harness's project-level skills folder in the Library (`.claude/skills`, `.goose/skills`), one link per Working set entry.

**User folder**:
A Harness's per-user skills folder on a Host (`~/.claude/skills`, `~/.agents/skills`); one link per skill makes every project on that Host see the set.
_Avoid_: global folder, home folder

### Packaging

**Plugin**:
A Group or a Source's skills packaged for a Harness's plugin system, with its own version and notice, committed under `plugins/<id>/`.
_Avoid_: package, bundle

**Form**:
How a Harness on a Host gets the Library's skills, one per Harness (ADR-0007): `account plugins` (Claude Code: the Plugins enabled on the claude.ai account, delivered as `<id>@synced`) or `plugins from GitHub` (Codex: the Library's marketplace added from GitHub; Hermes: each Plugin's Hermes rendering installed from the Release's commit through `hermes plugins install`). `loose skills` (one link per skill in the User folder) is no Harness's form any more. Never two on one Harness, so no skill name is listed twice. Claude Code, Codex and Hermes are on their forms; the older `plugin` and `links` pair is gone with the library-based run.
_Avoid_: mode (that is a project's link or copy), install mode

**Hermes rendering**:
The copy of a Plugin that Hermes loads, written by `build` at `dist/hermes/<id>/` beside `plugins/<id>/` once the Library opts in (`renderings.hermes` in its config, naming the folder): the package without the Claude and Codex manifests, each skill's `SKILL.md` with `name` set to its folder and `metadata` cut to string entries (Hermes's portable loader rejects the boolean `metadata.internal` the package carries), every other file byte for byte the package's. Installed with `hermes plugins install <owner>/<name>/dist/hermes/<id> --ref <commit>`; not recorded in the Release's `release.json`, whose `files` digests (the shared `NOTICE.md` among them) verify an installed copy.
_Avoid_: Hermes package, Hermes plugin (that is the installed copy under Hermes's home)

**User-only skill**:
A skill only the user starts, marked `disable-model-invocation: true` in its `SKILL.md`; the Library gives it an `agents/openai.yaml` with `policy.allow_implicit_invocation: false` for Codex. Codex loads it and runs it when the user names it (`$name`), but keeps it out of the model's skill list, so `codex debug prompt-input` never shows it: the Codex form reads it from the copy Codex runs under `~/.codex/plugins/cache/` instead, and counts it as loaded.
_Avoid_: hidden skill, manual skill

**Account copy**:
A Library Plugin on Justin's ChatGPT account, personal or workspace (ADR-0015 in oneezy/skills). Only Plugin Creator inside a ChatGPT chat changes it, when he types `@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release`; a Codex signed in with ChatGPT lists it as `<id>@created-by-me-remote` or `<id>@workspace-*`, which is how `status` checks it against the Release. Never a duplicate to uninstall.
_Avoid_: ChatGPT release, upload record

**Account plugin**:
A Plugin claude.ai syncs into Claude Code for the account, listed by `claude plugin list` as `<id>@synced` and kept under `~/.claude/plugins/synced/`. The tool never installs or removes one; `status` compares it with the Release, and `sync` removes what hides or duplicates one once `claude` lists it present and switched on.
_Avoid_: synced plugin (the harness's word), cloud plugin

**Library copy**:
A checkout or clone of the Library on a Host (a `skills-sync.json` naming the Library's owner and name at its root), or `~/.skills-sync`. A loose link into one, or whose target is gone (a dangling link counts as the tool's leftover, whatever it once pointed at; a link whose target cannot be read at all is nobody's and is left alone), is the tool's own leftover and goes once a Plugin on that Harness carries the skill (ADR-0007). A link to anywhere else is the user's and only ever named; so is a real skill folder, unless it holds exactly the Release's files for a skill (the copy an older sync or Codex's skill installer left), which goes the same way on Codex.
_Avoid_: leftover, stale link

**Machine command**:
A run that acts on this Host against the latest Release on GitHub and keeps nothing of its own on the Host (ADR-0012): no Library clone, no answers file, nothing remembered between runs; settings come from the Release's `skills-sync.json`, Host facts (the Harnesses, their plugins and links, the WSL distros) are detected on every run. `sync`, `status`, `hook`, `branches` and `unlink`. It takes `--plan`, `--json`, `--quiet` and `--library` (`hook` only `--library`); an older flag is accepted, does nothing and is named once on stderr. The opposite is a library command (`update`, `refresh`, `versions`, `add`, `remove`, `build`, `check`, the alias migrations), which runs inside a checkout named by `--repo` or found above the current folder and keeps every flag it had.
_Avoid_: remote command, online command

**Global block**:
The one managed block `sync` writes into a Harness's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`), between `skills-sync` markers (ADR-0011 in oneezy/skills): the tool's own pointer to the `/oneezy-agents` skill, which loads Justin's rules, plus the invocation table, its start marker carrying a Stamp (oneezy/tools#205). Written with or without the Release. Never written into a repository; a block an older version left there is reported, not edited. In a cloud session it is the whole sync. `status` calls it current, stale (another text than this tool's, or an older block) or hand-edited (its text no longer matches its Stamp).
_Avoid_: entrypoint (the per-library manifest, retired in 0.15.0), instructions block, brain block (its old id)

**Shared text**:
Retired in 0.16.0: `SHARED.md` at the root of the Library, which 0.12.0 to 0.15.0 wrote as the Global block. Justin's rules are now `skills/oneezy/agents.md`, loaded by `/oneezy-agents`; the tool reads no text from the Library for the block.
_Avoid_: brain routing (its Brain section replaced the retired `brain-routing.md`), shared instructions file

**Stamp**:
What the Global block's start marker carries after its id: `built-in` and the sha256 of the text (`<!-- skills-sync:skills:start built-in sha256:<hex> -->`); 0.15.0 and older stamped the Release a Shared text was read at instead. The text decides: another text than this tool's is stale; a text that no longer hashes to its Stamp was edited by hand.
_Avoid_: version marker, checksum

**Backup**:
The copy of a global instructions file `sync` or `unlink` makes beside it before a write changes it: `CLAUDE-backup-<UTC yyyymmdd-HHMMSS>.md`, `AGENTS-backup-<UTC yyyymmdd-HHMMSS>.md`. Never overwritten, never deleted by the tool; the write's line names it.
_Avoid_: snapshot (a Source's upstream copy), before-image

**Catalog**:
A marketplace file listing the Library's Plugins, one per Harness format.
_Avoid_: marketplace (the Harness's word for where a Catalog is added)

**Release**:
A numbered cut of the Library (`release-<n>`) carrying one upload archive per Plugin.

### Branches

**Keep branch**:
A branch whose name ends in `-keep`: `branches` never deletes it, as it never deletes `main`, `dev`, the repository's default branch and any `research/` or `prototype/` branch. The suffix and the two prefixes are matched exactly (ADR-0013 in oneezy/skills).
_Avoid_: protected branch (GitHub's own setting, which `branches` reads and leaves alone too)

**Archive tag**:
The tag `archive/<branch>` that `branches` puts at the head of a branch whose pull request was closed without merging, before deleting the branch, so nothing is lost. A tag of that name at another commit stops the delete.
_Avoid_: backup tag

**Daily cleanup**:
The scheduled run of `branches` in oneezy/tools (`.github/workflows/branches.yml`, 10:17 UTC) with the `PROJECT_PAT` secret over every repository its user owns, after a token check that names each repository the run will touch, skips one the token cannot write and refuses `layerdbiz/*` by name. A run by hand is a plan unless told otherwise.
_Avoid_: branch sweep, nightly GC
