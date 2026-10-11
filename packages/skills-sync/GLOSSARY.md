# Skills sync

One skills library, linked into every Harness on every Host, with third-party skills held at the versions the lock records. Shared words (Harness, Host, Surface) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md).

## Language

### The library

**Library**:
The git repo of skills that every Harness gets: own skills under `skills/`, the config and the lock beside them. Justin's is `oneezy/skills`.
_Avoid_: repo, collection, registry

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
A third-party repo the Library takes skills from, declared in the config with its selection, renames and pins (`matt-pocock`, `pstack`, `anthropic`, `diagram-design`).
_Avoid_: upstream, vendor, dependency

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

### Runs

**Sync**:
The default run: pull the Library, restore every Source from the Lock, rebuild the Layers and link the User folders. Never moves a Source.
_Avoid_: install, refresh

**Update**:
The run that moves a Source to its latest release, a Hold, or a version asked for (`--to`), and rewrites the Lock. Justin also says upgrade or downgrade.
_Avoid_: refresh (the internal step), bump

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
How a Harness on a Host gets the Library's skills, one per Harness (ADR-0007): `account plugins` (Claude Code: the Plugins enabled on the claude.ai account, delivered as `<id>@synced`), `plugins from GitHub` (Codex: the Library's marketplace added from GitHub) or `loose skills` (Hermes: one link per skill in its User folder). Never two on one Harness, so no skill name is listed twice. `sync` still moves between the older `plugin` and `links` pair until the account-plugin and Codex tickets land.
_Avoid_: mode (that is a project's link or copy), install mode

**Account plugin**:
A Plugin claude.ai syncs into Claude Code for the account, listed by `claude plugin list` as `<id>@synced` and kept under `~/.claude/plugins/synced/`. The tool never installs or removes one; `status` compares it with the Release.
_Avoid_: synced plugin (the harness's word), cloud plugin

**Machine command**:
A run that acts on this Host against the latest Release on GitHub and needs no Library on disk: `status` first, then `sync`, `hook`, `branches` and `unlink` as they move over. The opposite is a library command (`update`, `versions`, `add`, `build`, `check`), which runs inside a checkout.
_Avoid_: remote command, online command

**Catalog**:
A marketplace file listing the Library's Plugins, one per Harness format.
_Avoid_: marketplace (the Harness's word for where a Catalog is added)

**Release**:
A numbered cut of the Library (`release-<n>`) carrying one upload archive per Plugin.

### Branches

**Keep branch**:
A branch whose name ends in `-keep`: `branches` never deletes it, as it never deletes `main`, `dev` and the repository's default branch. The suffix is the only keep marker (ADR-0013 in oneezy/skills), matched exactly.
_Avoid_: protected branch (GitHub's own setting, which `branches` reads and leaves alone too)

**Archive tag**:
The tag `archive/<branch>` that `branches` puts at the head of a branch whose pull request was closed without merging, before deleting the branch, so nothing is lost. A tag of that name at another commit stops the delete.
_Avoid_: backup tag
