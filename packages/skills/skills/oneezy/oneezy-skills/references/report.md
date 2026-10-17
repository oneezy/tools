## Report

After the canonical script, run `status --json` and invoke `/oneezy-status` in Skills Sync mode with the command, exit code, complete actions, that status output and before/after readbacks. Its `references/skills-sync.md` owns the report shape. A landed change includes the actual release tag and `/oneezy-migrate` report; held source work includes its draft PR and tests. A missing requested skill remains a named blocker.

The message ends with the open manual steps, from `manualSteps` in the status output: each step's `title`, then its `steps` numbered, nothing reworded, nothing dropped. The stable ids are `claude-plugins`, `claude-account`, `codex-trust`, `codex-other-plugins`, `adopt-or-delete` and, in a cloud thread, `cloud-setup`. An empty list ends with "No manual steps open." When `status --json` has no `manualSteps` key, the tool is older than 0.9.0: say `Skills Sync <version from --help> cannot list manual steps yet; done cannot be judged`, never write "No manual steps open.", and do not run `branches` or `hook` (0.9.0 commands). A red line (`ok: false`) is reported before the steps and is not a manual step.

## How to call a skill

When a skill Justin typed does not resolve, show this table instead of improvising, and never fetch its `SKILL.md` from GitHub or run one from a folder the harness did not load (ADR-0011). It is the same table the tool writes into each harness's global file.

| Harness | How to call a skill |
|---|---|
| Claude Code | `/<plugin>:<skill>`, e.g. `/oneezy:oneezy-status` |
| Codex | `$<skill>` in the prompt (a plugin's skill: `$<plugin>:<skill>`), the `/skills` picker, or `@<skill>` on ChatGPT web |
| Hermes | `/<skill>` for a loose skill; a plugin's skill: `/agent-plugin-<id>-<hash>:<skill>` |

## Boundaries

- Never remove or deselect a third-party skill to make room for one of Justin's, or to fix a name clash: rename his copy (`play-<name>`, or a rename in the config).
- Keep `disable-model-invocation` wherever upstream sets it.
- The tool owns the skills block in the global instructions file of Claude Code and Codex and one session-start hook entry in each harness that has a hooks file (Claude Code, Codex; ADR-0010, ADR-0011), and nothing else in them; run the canonical script to refresh them and preserve every other byte. No block goes into a repository file. Other hooks and settings stay untouched, and `check` is a command people and CI run, never a hook.
- Own skills are edited in the library, `skills/<group>/<name>/`, and nowhere else: what a harness holds is a cache the tool replaces. Third-party skills change through **Change** only; the copies the tool makes stay as it wrote them.
- A sync never moves a source: the release carries the committed lock. A source moves through `update`, when Justin asks or in the library's daily upstream check (`.github/workflows/run.yml`), and every move lands with its report in the commit.
