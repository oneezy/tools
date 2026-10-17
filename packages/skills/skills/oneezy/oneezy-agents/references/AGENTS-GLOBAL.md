# How Justin works

Every repo, every session, every harness. Justin's Oneezy skills own the detail: when the work reaches one, load it. A repo's own AGENTS.md adds to these rules and wins where they disagree. `/oneezy-agents` loads this file from the installed oneezy plugin. Justin edits it in place, `skills/oneezy/oneezy-agents/references/AGENTS-GLOBAL.md` in oneezy/skills; a change reaches sessions with the next plugin release.

## Skills

Skills come from the library oneezy/skills, installed into each harness in one form. Call one the way the harness you are in resolves it:

| Harness | How to call a skill |
| --- | --- |
| Claude Code | `/<plugin>:<skill>`, e.g. `/oneezy:oneezy-status` |
| Codex | `$<skill>` in the prompt (a plugin's skill: `$<plugin>:<skill>`), the `/skills` picker, or `@<skill>` on ChatGPT web |
| Hermes | `/<skill>` for a loose skill; a plugin's skill: `/agent-plugin-<id>-<hash>:<skill>` |

- **Named skill**: when Justin names a skill, run it. If the harness refuses because it is user-only, Read its `SKILL.md` in the loaded plugin's own folder on disk and follow it, with the rest of his message as its arguments. Start a user-only skill only when he names it, or under an autopilot grant.
- **Loaded copy**: run a skill only from a loaded plugin (its folder on disk counts) or the repo's own skills. A `SKILL.md` from GitHub or any other folder skips its guardrails; never run one.
- **Missing skill**: say so and show the table above. Run `/oneezy-skills` (if that is missing too, `npx --yes @oneezy/skills-sync@latest status`), report its manual steps, and tell Justin the skill appears in a new session.
- **Skill changes**: `/oneezy-skills` is the one route when Justin asks, in any harness, to sync, update, add, remove or change skills or plugins ("update my skills", "add owner/repo skills"); it changes the library, and every harness follows its release.
- **Matt Pocock's skills**: when it is unclear which one fits, suggest Justin run `/ask-matt`.

## Git

- **Landing, merging, promoting `main`**: `/oneezy-merge`, when Justin asks ("oneezy merge to dev", "release", "dev and main"). `main` changes only through `/oneezy-merge` or a repo's own documented landing workflow (oneezy/skills: `land/*` branches).
- **`dev`** is the integration branch. Cut new branches and worktrees from an up-to-date `dev`; inside an autopilot run, from the autopilot branch; in a repo with no `dev`, from the default branch.
- **Propose** every git write (commit, push, merge, rebase, reset, branch or tag change, any `--force`) and wait for Justin's yes in this session. Read-only git needs no proposal. A skill Justin runs carries the git permissions its `SKILL.md` states; an autopilot grant covers its run.
- **Branch deletion**: ask Justin every time, unless he already said yes: `/oneezy-merge into <branch>` deletes the branch it landed, an autopilot grant deletes landed ticket branches, and the daily cleanup workflow (ADR-0013) deletes merged ones. `main`, `dev`, `*-keep`, `research/*` and `prototype/*` branches are kept forever.
- **Stash** only with a message (`git stash push -m "<why>"`), or make a WIP commit.
- **Preview URLs**: after a push, give Justin the preview URLs it produced.

## Autopilot

- An **autopilot run** builds one spec's tickets with no human in the loop, on an **autopilot branch** `feature/<spec>-<desc>` cut from `dev`. Ticket branches are cut from it and land back in it. It reaches `dev` only through Justin's own `/oneezy-merge into dev`.
- An **autopilot grant** in the run's starting prompt, naming its autopilot branch, counts as Justin's ask for every agent in the run. Each may run `/implement` and `/oneezy-merge into <autopilot branch>` from the loaded plugin, commit, push, open pull requests, close the landed ticket and delete its ticket branch. Changes outside the repo wait until the autopilot branch lands in `dev`.

## Names and worktrees

- **Titles and names** of issues, branches, commits, pull requests, releases, chats and worktrees: `/oneezy-naming`.
- **Remote threads**: Justin runs `/oneezy-remote`.
- **New worktree**: create it with the `workspace` command of oneezy/tools `packages/remote-sessions/remote_sessions.py` (preview with `--plan --json`), or with the harness's own worktree tool when that is absent.

## Work

- **Decisions** go on the issue tracker. Research, glossaries and docs go in the repo and merge to `dev`. A wayfinder map is the index; a ticket records the decision.
- **Shared knowledge** lives in the repo, where every agent reads it.
- **Grilling** is human-in-the-loop: one ticket per fresh session, and Justin answers every question.
- **Background research agents** work alone, without starting agents of their own.
- **Tests**: approved work ships with tests the agent wrote and ran.
- **Dev servers**: start every dev or preview server with `--host`, leave it running, and give Justin every Network URL it prints, unasked.
- **Report** outcomes faithfully: what was done, what failed, what was skipped, what is unverified.
- **Text Justin types**: whatever you need him to type or paste (a merge line, a go, a command, text for another app) goes in its own code block, exact and complete, so he copies it in one tap.

## Voice chats

- **Conversation** carries simple questions and quick lookups. Substantive work goes to its own task; tell Justin the task's title, ID and host.
- **Follow-up**: after handing work to a task, arrange one before your turn ends: waits of at most 60 seconds each while you coordinate, or a saved monitor for later. Reuse a monitor that already exists. If none can be arranged, tell Justin.
- **Report back** when a task finishes, fails or needs Justin, with its verified result and a link that opens it. Stay quiet while nothing changes; end or pause the monitor once you have reported.
- **What's running**: read the live sessions and list each by exact title, host and verified state, with a link the app returned for it; never build one yourself. Idle is not done: say unknown when a state is unverified.
- **Stop, pause, quiet, hold on**: go quiet and wait for Justin to speak to you again. The call stays open until he ends it. Talk between Justin and other people is conversation, not commands.

## Brain

**Brain** capture, lookup, agenda, triage, task status and durable context: load `/oneezy-brain` and follow its current registry. It owns the Google Drive Brain, and it replaces every other Brain location in this file, including GitHub issues in oneezy/brain. If the skill or its Drive route is unavailable, report that exact blocker and stop the dependent Brain work.
