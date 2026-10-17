# ADR-0006: Claude Code gets development Plugins from a local-scope marketplace, with the released copies off in that project

Date: 2026-10-17. Status: accepted, adapter unverified until the Windows proof. Recorded by oneezy/tools#213.

## Context

A Development project should load its Plugin from the Development build, under the Plugin's normal name, and only in that project (spec #209). Claude Code loads one copy per manifest name:

- An installed marketplace copy outranks a `.claude/skills` copy and an Account plugin (`@synced`).
- With two enabled marketplace copies, the released one won [obs].

Whether a released copy reached the machine as an Account plugin or as a CLI install from `oneezy-skills` is known only on Justin's PC. The evidence, labelled documented or observed, is in `docs/research/2026-10-17-harness-plugin-loading.md`.

## Decision

- **One mechanism for both origins.**
  - `claude plugin marketplace add <library>/dist/development --scope local` declares the marketplace `<release>-development` in the project's `.claude/settings.local.json`.
  - `claude plugin install <id>@<release>-development --scope local` installs the Plugin for that project. It reads `dist/development/plugins/<id>` in place, so a rebuild is what loads next.
  - The adapter writes the catalog `dist/development/.claude-plugin/marketplace.json`, listing every Plugin built for the Library.
- **The released copies are switched off, never uninstalled.** Setup writes `"<id>@<release>": false` and `"<id>@synced": false` into `.claude/settings.local.json` for each copy Claude lists. Every other project keeps them.
  - A same-name Plugin from any other marketplace that is on in the project is an identity conflict. Setup refuses it with nothing changed.
- **Remove takes back exactly what setup did.**
  - It runs `claude plugin uninstall --scope local` for the copies setup installed.
  - It puts each key back to its prior value, absent included, while the key still holds what setup left.
  - It deletes the marketplace declaration key.
  - It never runs `claude plugin marketplace remove`: that drops the marketplace for every project and uninstalls its Plugins there [obs].
- **`.claude/settings.local.json` joins setup's exclude block.** Setup refuses the file when git tracks it.
- **Refresh is reported, never forced.** Output and `develop status` say the Plugin is installed, not loaded: type `/reload-plugins` or start a new chat.
- **The adapter stays `verified: false`** until the Windows runtime proof. Tests switch it on with `SKILLS_SYNC_TEST_UNVERIFIED_ADAPTERS=claude-code`.

## Considered options

- **A `.claude/skills/<plugin>` link**: it beats an Account plugin with no settings change, but loses to a CLI-installed marketplace copy even when that copy is disabled [obs].
- **`--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`**: these act per launch, and a project cannot set them. The shadowed marketplace copy still lists as enabled [doc].
- **Leaving both copies enabled**: the released copy wins [obs].
- **`claude plugin enable --scope local` on remove**: it writes `true`, so it cannot restore a key that was absent before.

## Consequences

- Claude's per-user `known_marketplaces.json` keeps `<release>-development` after remove. It is an inactive visible entry, which the spec allows.
- A managed setting that enables the released copy outranks local settings. Nothing in a project can switch it off.
