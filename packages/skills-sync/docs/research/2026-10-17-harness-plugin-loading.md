# Harness plugin loading for Development projects

Research for spec #209: #213 (Claude Code) and #214 (Codex). This is reference for whoever changes `src/develop-claude-code.ts` or writes the Codex adapter. Gathered 2026-10-17.

Each claim carries one label:

- **[doc]**: documented. The source URL is given; the pages carry no date, so the date is the day they were fetched (2026-10-17).
- **[obs]**: observed on Linux with a temporary `HOME`. The real `~/.claude` and `~/.codex` were never touched. This is evidence, not Windows proof.
- **[inf]**: inferred and not verified.

| Thing | Version |
| --- | --- |
| Claude Code CLI | 2.1.302 |
| Codex CLI | codex-cli 0.163.0 (npm `@openai/codex`) |
| Vercel Skills CLI | `skills` 1.7.2 (README on `main`) |

Sources:

- Claude Code docs:
  - https://code.claude.com/docs/en/plugins/loading
  - https://code.claude.com/docs/en/plugins/create
  - https://code.claude.com/docs/en/plugins/cli-reference
  - https://code.claude.com/docs/en/settings-reference
  - https://code.claude.com/docs/en/plugins/marketplace-reference
  - https://code.claude.com/docs/en/env-vars
- OpenAI docs:
  - https://developers.openai.com/plugins/build/plugins
  - https://developers.openai.com/codex/plugins
  - https://developers.openai.com/codex/config-file/config-basic
  - https://developers.openai.com/codex/config-reference
  - https://developers.openai.com/codex/cli/reference
- Vercel: https://github.com/vercel-labs/skills

## Skill installation is not plugin loading

The Vercel Skills CLI installs **loose skills** only [doc, vercel README].

- Project scope (the default) installs to `./<agent>/skills/`. `-g` installs to `~/<agent>/skills/`.
- The folders are `.claude/skills/` for Claude Code and `.agents/skills/` for Codex.
- It defaults to symlinks to one canonical copy, and falls back to `--copy` where links fail.
- It discovers skills listed in `.claude-plugin/marketplace.json` and `plugin.json`, but nothing installs a whole plugin, a marketplace or a Harness's plugin settings.

A loose skill working in a Harness says nothing about how that Harness loads a plugin. The Skills Sync conventions it shares are one source with per-agent links, project versus global scope, and a copy fallback.

## Claude Code

### Identity and precedence

- A plugin id is `<name>@<origin>` [doc, loading]. The origin is one of:
  - a marketplace name;
  - `inline`: `--plugin-dir`, `--plugin-url` or `CLAUDE_CODE_PLUGIN_DIRS`;
  - `skills-dir`: a folder with `.claude-plugin/plugin.json` under `~/.claude/skills/` or the project's `.claude/skills/`;
  - `synced`: turned on for the claude.ai account.
- **Same-name conflicts compare the manifest `name`, not the id** [doc, loading]. So a development copy keeps the normal name, and its skills stay `/play:*`, while its id differs (`play@oneezy-skills-development`).
- Precedence among same-name copies, highest first [doc, loading "Name conflicts"]:
  1. managed `enabledPlugins`
  2. inline
  3. an installed marketplace plugin
  4. skills-dir, the user copy before the project copy
  5. synced
- Two **enabled** marketplace copies with the same name both show as enabled, and only one registers its hooks [doc]. Which copy's skills win is undocumented.
  - With both enabled, `claude plugin details play` resolved to the release copy [obs]. **So the release copy is switched off in the project, never left beside the development copy.**
- A project `.claude/skills/<plugin>` link beats `@synced` in that project only [obs].
  - It needs workspace trust [obs].
  - It loses to an installed marketplace copy even when that copy is disabled in the project [obs].
  - It therefore covers only the Account plugin case. The adapter uses a local marketplace instead, which outranks both [doc].

### Settings scopes

- `enabledPlugins` merges key by key: user (`~/.claude/settings.json`), then project (`.claude/settings.json`), then local (`.claude/settings.local.json`), then `--settings`, then managed. The highest source naming an id wins [doc, loading and settings-reference].
- Setting an id to `false` in `.claude/settings.local.json` opts that machine's project out of it [doc]. `"<name>@synced": false` there keeps an account plugin out of that project [doc].
- `extraKnownMarketplaces` entries in a repo's settings count only after workspace trust [doc].
  - A cloud session never shows the trust dialog, so it never adds them [doc].
  - So nothing in a project's local settings changes a cloud session [inf].
- `CLAUDE_CODE_PLUGIN_DIRS` is honored only from the shell, user settings or managed settings [doc, env-vars]. A project cannot turn on `--plugin-dir` by itself.

### The local-scope directory marketplace (the adapter's mechanism)

- `claude plugin marketplace add <dir> --scope local` [obs]:
  - writes `extraKnownMarketplaces.<name> = { source: { source: "directory", path: <dir> } }` into `.claude/settings.local.json`;
  - registers `<name>` user-wide in `~/.claude/plugins/known_marketplaces.json`;
  - a second project gets "already on disk — declared in local settings".
- `--scope local` acts on the nearest folder at or above the working directory that has `.git` [obs]. Run from `proj/sub`, it wrote `proj/.claude/settings.local.json`.
- `claude plugin install <name>@<mp> --scope local` [obs]:
  - sets `enabledPlugins.<id> = true` in that file, keeping the other keys;
  - adds an `installed_plugins.json` entry with `scope: "local"` and `projectPath`;
  - installing again answers "already installed ... loads in place from <dir>".
- A relative-path plugin of a `directory` marketplace is read in place [doc, loading "In-place and copied plugins"].
  - The CLI still writes a cache copy, and `plugin list --json` shows `readFromFolder` at the source [obs].
  - Edits apply at the next session start or `/reload-plugins`, with no version bump [doc].
  - A Plugin added to the catalog later installs without updating the marketplace [obs].
- `claude plugin list --json`, run inside a project [obs]:
  - prints one row per local install, each with its `projectPath`;
  - each row's `enabled` is that id's enablement **in the project the command runs in**.
- `claude plugin details <name>` names a `Source:` [obs]. It also named a copy that was disabled there, so it is not proof of what loads. The adapter reads `list --json` instead.
- `claude plugin uninstall <id> --scope local` [obs]:
  - removes only that project's install;
  - deletes the `enabledPlugins` key when it is there, and leaves the file byte-identical when it is not;
  - with no settings file it succeeds and creates none;
  - another project's install stays;
  - for a project without an install it fails with `not_installed_at_scope`.
- **`claude plugin marketplace remove <name> --scope local` is destructive** [obs]. It removed the marketplace from `known_marketplaces.json` and uninstalled its plugins **in every project**. Remove deletes only the local declaration key, never through that command.
- `claude plugin disable <id> --scope local` writes `<id>: false`; `enable --scope local` writes `true` [obs]. Neither can restore "unset", so remove edits the key directly.
- The CLI does not add `settings.local.json` to `.gitignore` or `.git/info/exclude` [obs]. Setup lists it in its exclude block.
- `--plugin-dir` is per launch and silently shadows a marketplace copy that still lists as enabled [doc]. Command-source link mode is refused on Windows [doc, marketplace-reference]. Neither is used.

### Reload

- `/reload-plugins [--force]` applies installs, enables and edits [doc, cli-reference].
  - It runs only when the person types it. Over Remote Control it replies that it is not available.
  - The Desktop app, the Agent SDK and `-p` accept it only typed.
  - It refuses a change that would invalidate the prompt cache unless `--force` is given.
- No supported mechanism lets an outside process reload a running chat [doc]. Skills Sync can only say: installed, not loaded; type `/reload-plugins` or start a new chat.
- Monitors need a restart. Project-scope plugins run no monitors, and their MCP servers need approval [doc].

## Codex (CLI and Codex in the ChatGPT desktop app)

### Packaging, marketplaces and cache

Source: [doc, plugins/build/plugins and codex/plugins].

- Plugins work in Codex in the ChatGPT desktop app and in the CLI's plugin browser, and not in the IDE extension.
- Manifest: root `plugin.json` with `extensions.com.openai`, and `.codex-plugin/plugin.json` as a compatibility manifest.
- Marketplace files:
  - `$REPO_ROOT/.agents/plugins/marketplace.json`
  - legacy `$REPO_ROOT/.claude-plugin/marketplace.json`
  - personal `~/.agents/plugins/marketplace.json`
- Entries need `policy.installation`, `policy.authentication` and `category`.
- CLI: `codex plugin marketplace add|list|upgrade|remove`. The docs say to install and test a local plugin in the desktop app.
- Installs are copied to `~/.codex/plugins/cache/<mp>/<plugin>/<version>/` [doc says `local` for a local plugin]. The observed folder was the manifest version (`0.0.1`) [obs].
  - The app loads the cached copy [doc].
  - A source edit changes nothing until a re-add [obs].
  - `codex plugin add` again with the same version overwrites the cache in place [obs].
- New skills appear in a new chat or CLI session [doc]. Changed files need a desktop app restart [doc].

### Enable and disable per project

- In a **trusted** project's `.codex/config.toml`, `[plugins."name@marketplace"] enabled = false` turns a plugin off for that project [doc, plugins/build/plugins and config-reference].
- Precedence, highest first [doc, config-basic]:
  1. CLI flags and `-c`
  2. project config, the closest one winning
  3. profile
  4. user
  5. cloud-managed
  6. system
- An untrusted project's config is ignored [doc, obs].
- It does not override workspace-managed enabled states [doc]. A marketplace refresh may write files of disabled plugins [doc].
- Same-name copies from two marketplaces are **not** deduplicated. With both enabled, the prompt lists `play:play-hello` twice [obs]. The release disable is mandatory.
- A trusted project with dev `true` and release `false`, over a user config with dev `false` and release `true`, loaded only the development copy there and only the release copy elsewhere [obs].
- `codex plugin add` rewrites the user `[plugins."<id>"] enabled = true` on every add [obs].
  - That turns the development copy on in every project until the user-level `false` is restored.
  - So the adapter must re-assert it after every refresh.
- `-c 'plugins."x".enabled=true'` did not change `codex debug prompt-input` [obs]. Treat CLI overrides as unproven.
- The CLI did not list a repo marketplace at `<proj>/.agents/plugins/marketplace.json` [obs]. The docs say the desktop app reads them [doc]. Check this in the app.

## Open for Justin's Windows PC

These need the installed runtime:

- Which origin each release copy has: Claude `@synced` or `@oneezy-skills` (the `scope` in `claude plugin list --json`); Codex a GitHub marketplace, the ChatGPT account catalog, or workspace-managed.
- In a real Claude Code chat:
  - the local marketplace copy loads and the released copy's skills and hooks are absent;
  - `/reload-plugins` picks up a rebuild;
  - the trust prompt's wording;
  - the desktop app's worktree behavior.
- Codex in the desktop app:
  - project `.codex/config.toml` switches;
  - the cache folder name;
  - restart or new chat as the minimum refresh;
  - repo marketplaces;
  - the re-add flip.
- Workspace-managed or account-delivered Codex copies may make project-only suppression impossible through supported controls. That is the spec's stop-and-return case.
