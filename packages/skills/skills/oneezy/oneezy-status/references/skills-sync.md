# Skills Sync result mode

Two inputs: the canonical script's command, exit code and complete action report for a run that just happened, and the machine's current `status --json` (run `npx --yes @oneezy/skills-sync@latest status --json`, or `scripts/sync.sh status --json` beside `/oneezy-skills`; `status` reads GitHub and the machine and writes nothing, so it is safe here). Read-only: fill missing evidence through supported discovery/readbacks, never rerun mutation to make the report look successful.

## Definition of done

**Done** is `ok: true` and `manualSteps: []` in `status --json`, nothing less. `ok` is false while any line is red (a harness line, the release line, a checkout). Manual steps are work only Justin can do; they never turn a line red, they keep the machine from being done. In a cloud thread expect `release: null`, no plugin lines and no checkouts, and possibly the `cloud-setup` step. When `status --json` has no `manualSteps` key, the tool is older than 0.9.0: say `Skills Sync <version from --help> cannot list manual steps yet; done cannot be judged`, never write "No manual steps open.", and do not run `branches` or `hook` (0.9.0 commands).

## Per-harness lines

Open the report with one line for the machine, then one green or red line per harness in `harnesses`, in the order the tool gives them:

```
Skills Sync: not done (3 red lines, 1 manual step)   (latest oneezy/skills release-17, ae92a54)
✅ Codex  plugins from GitHub
❌ Claude Code  account plugins: 2 red
   ! matt-pocock@synced 1.3.0 (latest 1.3.1)
   ! global block in /home/justin/.claude/CLAUDE.md is stale (brain); run sync
✅ Hermes  plugins from GitHub
Checkouts: ✅ /home/justin/dev/skills on dev, clean   ❌ /home/justin/dev/tools on feat/x, dirty (2 files)
Manual steps (1): ...
```

- A harness is ✅ when none of its `lines` has `ok: false`, ❌ otherwise; list its red lines (`mark`, `text`) under it. The `.` notes (loose links left alone, other plugins) are not listed unless asked. A harness `status` does not list was not found on the machine: say so in one clause, not as a red line.
- A Codex `hook` with `trusted: false` is green with a manual step (`codex-trust`); do not paint it red.
- The release line (top-level `lines`) and each `checkouts` entry with `ok: false` are red on the machine line, not under a harness.
- Close the report with `manualSteps` (after everything else, run evidence included): each `title`, then its `steps` numbered, exactly as the tool wrote them (they are phone-ready). Nothing open and the `manualSteps` key present: "No manual steps open." Key absent: the version sentence under Definition of done.
- Quote the tool's words for red lines and steps; add no advice of your own. The next move for a red line is `sync`, which the tool's line says. The steps are Justin's: list them and never perform one (no `codex plugin remove`, no folder or link deletion, no settings or setup-script edit) unless he asks for that exact step in this conversation.

## Run evidence

- **✅ Verified**: executed changes whose exact target readback agrees. Include each host and path, plugin versions before → after, hook entry and global block state, the files removed, ownership and idempotence/rollback evidence.
- **❌ Failed**: attempted destinations, failed precondition or command, affected paths and preserved state. A failed prerequisite means zero instruction writes to that destination; independent valid destinations may complete.
- **Skipped / unreachable / held**: each selected or registered destination not executed, with the exact reason. Dispatch, plan, build, permission refusal and absent account/tool route are not successful installation.

Name the checkouts in reach and their state. Keep source-library HEAD and each upstream source version/SHA before → after separate from generated package versions and installed native/cloud plugin versions. An unqueried version is unknown. Record an explicitly requested update apart from the release a plain sync took; pins and dirty work retain their bytes. Use full SHAs and actual release tags, not guessed latest labels.

Before the manual steps, which close the report, give tests and their actual outcomes, draft PR links and remaining blockers. Held review work requires new merge/release approval. Cloud upload is separate from local CLI installation and managed links; source generation never proves either installed or loaded behavior. Report unsupported hosts explicitly, including missing capability adapters.
