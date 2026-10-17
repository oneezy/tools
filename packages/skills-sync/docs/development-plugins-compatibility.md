# Development Plugins: compatibility matrix

What is proven for Development projects, and where. Spec oneezy/tools#209, ticket #217. Last updated 2026-10-17, before any Windows run. Every Windows cell reads **unproven** until Justin runs `runbooks/development-plugins-windows.md` and an agent fills it from his evidence.

The three evidence levels differ in weight, and only the third accepts a behavior:

- **Cloud tests**: the built CLI against fake `claude` and `codex` executables in temporary homes, on Linux (`packages/skills-sync/test`). They prove Skills Sync's own logic and the files it writes. They prove nothing about what a real Harness loads. The watcher's fake-terminal tests also ran on a Windows CI runner (#212).
- **Observed, Linux**: the real Claude Code 2.1.302 and codex-cli 0.163.0 CLIs against a temporary home, once, during research (`research/2026-10-17-harness-plugin-loading.md`). They show what a CLI lists or renders. A chat, and Codex in the ChatGPT desktop app, never ran.
- **Windows proof**: the runbook on Justin's Windows 11 PC, in the real apps. Only this accepts a behavior.

Fill a Windows cell as `pass`, `fail` or `partial`, with the version and the runbook step. Leave `unproven` where nothing ran, and leave the ticket open for any cell that is not `pass`.

## Shared behavior

| Behavior | Cloud tests | Windows 11 proof | Step |
| --- | --- | --- | --- |
| One editable source: an edit through either project's alias reaches the Library, and the alias is a symlink or a junction | `develop-project`, `develop-watcher` | unproven: link kind, and edits through it from VS Code and Notepad | 5.3, 7.3, 7.4 |
| The launcher activates only the project it runs in | `develop-project` (a temporary npm prefix, two projects) | unproven | 2, 5.4 |
| Setup, status and remove: record, exclude block, projects index; all or none; idempotent | `develop-project` | unproven | 5, 11 |
| Development build: normal names, only changed output rewritten, last good output kept as `stale`, `failed` writes nothing | `develop-build` | unproven: the directory swap with a Harness or editor holding a file | 2, 7.7, 7.8, 9 |
| One watcher per Library; a second launch names the owner and starts nothing | `develop-watcher` | unproven | 7.1, 7.2 |
| Closing the owning terminal stops the watcher (Windows Terminal tab, console window, through pnpm, killed parent, Ctrl+C, Ctrl+Break) | `develop-watcher` with fake terminals | unproven in a real console | 8.1, 8.3, 8.4 |
| Stopped status; restart catches up on edits made while stopped | `develop-watcher` | unproven | 8.1, 8.2 |
| Identical saves rebuild nothing; additions, supporting-file edits, renames and removals rebuild | `develop-watcher`, on Linux `fs.watch` | unproven: Windows change events and editors' saves | 7.4, 7.5 |
| A failed first build leaves the project's configuration alone; a later failure keeps the last good build; a fix recovers | `develop-build`, `develop-project`, `develop-claude-code`, `develop-codex`, `develop-watcher` | unproven | 7.7, 9 |
| Sync respects Development projects; the release build and `release.mjs` leave development output alone | `develop-sync` | unproven against real Harnesses | 10 |
| Switch-off restores the project, keeps source, unrelated files and later manual edits | `develop-project`, `develop-claude-code`, `develop-codex` | unproven | 11 |
| Account and cloud Plugin configuration is unchanged | the fakes' account rows stay as they were | unproven: needs the real account state, before and after | 1.2, 12 |

## Claude Code

| Behavior | Cloud tests | Observed, Linux | Windows 11 proof | Step |
| --- | --- | --- | --- | --- |
| A local-scope marketplace over `dist/development` installs the Plugin for one project, read in place | `develop-claude-code` | yes, the CLI reads the source and the cache copy stays stale | unproven | 5.2, 6.1 |
| Released copies (`@oneezy-skills` and `@synced`) are switched off in that project only and stay on elsewhere | `develop-claude-code` | yes for a marketplace copy. A `@synced` copy was only observed under a different mechanism | unproven in a chat | 6.1, 6.2 |
| With both copies enabled the released one wins, so switching it off is required | not applicable | yes | unproven | 6.1 |
| The development copy loads in a real chat under the Plugin's normal name, with one `play:*` set and no hooks note | none | none | unproven | 6.1 |
| Claude Code Desktop, and its worktrees, load the same copy | none | none | unproven | 6.2 |
| `/reload-plugins` loads a rebuild into a running chat; a new chat does too | status text only | the CLI details read the new source | unproven | 7.6 |
| Reload cannot be started by Skills Sync, so status says installed is not loaded | `develop-claude-code` | documented | by design; no proof needed | 7.6 |
| The workspace trust question for a project with local settings | none | none | unproven | 3, 6.1 |
| The inactive `oneezy-skills-development` entry stays after switch-off, and a missing `dist\development` is or is not a broken marketplace | none | the entry stays, as `marketplace remove` is never run | unproven | 11.3, 11.5 |
| Link-mode plugins | not used | documented as refused on Windows | not applicable | |

## Codex in the ChatGPT desktop app

| Behavior | Cloud tests | Observed, Linux | Windows 11 proof | Step |
| --- | --- | --- | --- | --- |
| A development marketplace adds a cache copy that is off for every project and on through a trusted project's `.codex/config.toml`, with the released copy off | `develop-codex` with a modelled `config.toml` | yes, with codex-cli 0.163.0 `debug prompt-input` | unproven in the app. Desktop 0.162.0-alpha.17.2 honoured project plugin switches for the older `pnpm skills:dev` block (2026-10-15), not for this arrangement | 5.2, 6.3 |
| Two enabled copies list two `play:*` sets, so the release copy must be off | `develop-codex` | yes | unproven | 6.3 |
| An untrusted project ignores its config and keeps the released copy | `develop-codex` | yes | unproven in the app | 3, 6.3 |
| Every `codex plugin add` switches the copy on for every project until setup switches it off again (the re-enable window) | `develop-codex` | yes | unproven. Justin decides whether the guarded sequence is acceptable | 5.2, 7.6, 13 Q5 |
| A rebuild reaches Codex only through another add; a new chat or a restart is the minimum | `develop-codex` (stale status) | the cache refreshed on re-add | unproven: which of the two | 7.6 |
| The cache folder is named after the version, not `local` | none | version | unproven in the app | 7.6 |
| A copy from the ChatGPT account or a workspace cannot be switched off by a project, so setup refuses | `develop-codex` | none | unproven. The stop-and-ask case if Justin's release copy has this origin | 4.1 |
| The app reads a repo marketplace at `<project>\.agents\plugins\marketplace.json` | none | the CLI neither lists it nor adds from it | unproven | 13 Q8 |
| An add made from the app also flips the user switch | none | the CLI does | unproven | 13 Q7 |
| `codex -C <project> debug prompt-input` agrees with what the app loads | none | none | unproven | 6.3 |
| Inactive development entries stay visible in the Plugins Directory | none | none | unproven | 6.4, 11.3 |
| Sync keeps the development copies, and a copy left on for every project is a red line | `develop-sync` | none | unproven | 10.1, 10.3, 10.4 |

## Closing the ticket

#217 stays open while any Windows cell is not `pass`. Each Harness adapter turns `verified` on in `ADAPTERS` (`src/develop-project.ts`) only when its rows pass. A `fail` in "project-only precedence" cells is the spec's return-to-Justin case: build no substitute, and do not change account Plugin settings or Harness caches.
