---
name: oneezy-naming
description: "Justin's naming rules for anything with a title, in every repo: GitHub issues, phases, maps, specs, labels, branches, commits, PR titles, releases, chat titles and worktrees. Use before creating or renaming any of them, including the tickets /wayfinder, /to-spec and /to-tickets create."
---

Issue, commit, PR and release titles are **one emoji, a name, a colon, then plain words** an eighth grader reads at once: `✨ app: Sign in with Google`. Branches, chats and worktrees take the shapes in their own sections. Matt Pocock's skills find tickets by label and sub-issue link, never by title, so these rules change titles and add labels while every step and label of Matt's skills stays exactly as he wrote it.

Before calling a dependency, read `references/capabilities/contract.md`, then the adapter for this host. Load its actual instructions and discover its tools; a name or mention does not execute it.

## Issues

Three levels, each a GitHub sub-issue of the level above:

| Level | Title | Labels |
|---|---|---|
| Phase | `⬛ Phase <n>: <what the phase delivers>`; `⬛🏁 Phase <n>: ...` when it is a contract milestone | `phase` |
| Map (child of a phase) | `🗺️ map: <the goal>` | `wayfinder:map` |
| Spec (child of a phase) | `📋 spec: <what ships>` | `📋 epic` |
| Ticket (child of a map, a spec or a phase) | `<emoji> <area>: <the work>` | Matt's labels, plus one kind label on build tickets |

- A phase names what it is, never a bare number: `⬛🏁 Phase 5: Report Generator V1`. Its body starts with the hidden tag `<!-- phase:<n> -->`; tools find a phase by that tag, so its title can change freely. Only a 🏁 phase carries a GitHub Milestone.
- A map or a spec stays `map:` or `spec:`; the area names appear only on the tickets under it, since one map or spec spans many areas.
- **Ticket emoji.** Decision work under a map takes its kind: 💬 grilling, 🔎 research, 🧪 prototype, 🙋 a task only Justin can do. Build work takes where the code lives: ✨ an app, 📦 a package, 🔧 the whole repo.
- **Area** is the folder name: `app`, `site` (under `apps/`), `ui`, `tools`, `task-manager` (under `packages/`), or `repo` for repo-wide work. A repo with no `apps/` or `packages/` uses `repo`.
- **The work** starts with a verb (Add, Fix, Decide, Check, Prove, Create), stays under about eight words, and leaves out jargon, paths and ticket numbers.

Example tree:

```
⬛🏁 Phase 5: Report Generator V1                      [phase] + Milestone
├─ 🗺️ map: Plan the Report Generator platform        [wayfinder:map]
│  ├─ 💬 app: Decide how reports save with no signal [wayfinder:grilling]
│  ├─ 🔎 app: Check Better Auth works with Supabase  [wayfinder:research]
│  ├─ 🧪 app: Prove two people can edit one report   [wayfinder:prototype]
│  └─ 🙋 repo: Create the Supabase account           [ready-for-human]
└─ 📋 spec: Report Generator V1                       [📋 epic]
   ├─ ✨ app: Sign in with Google, Microsoft or email code  [ready-for-agent] [✨ feat]
   ├─ ✨ app: Fix photos vanishing when one report is reset [ready-for-agent] [🐛 fix]
   ├─ 📦 ui: Add a dialog component                         [ready-for-agent] [✨ feat]
   └─ 🔧 repo: Add releases, versions and changelogs        [ready-for-agent] [🔧 chore]
⬛ Phase 6: Client accounts                            [phase]
```

## Kind labels

Justin's labels sit beside Matt's and never replace them. One per build ticket:

| Label | Type | Version bump |
|---|---|---|
| `✨ feat` | feat | minor |
| `🐛 fix` | fix | patch |
| `📝 docs` | docs | none |
| `♻️ refactor` | refactor | none |
| `⚡ perf` | perf | patch |
| `✅ test` | test | none |
| `🔧 chore` | chore | none |
| `👷 ci` | ci | none |
| `📋 epic` | (specs only) | none |

Create a missing kind label in the repo. Matt's labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `wayfinder:*`) and `phase` keep their names, colours and meaning untouched.

## Branches, commits and PR titles

- **Branch:** `<type>/<issue>-<slug>`, e.g. `feat/160-sign-in`; board tools read the issue number from it.
- **Commit and PR title:** `<emoji> <type>(<area>): <short lowercase subject>`, the emoji from the kind table: `✨ feat(app): sign in with Google, Microsoft or email code`. A breaking change adds `!` after the area and a `BREAKING CHANGE:` footer.
- Squash merges turn the PR title into the commit and GitHub appends the PR number: `✨ feat(app): sign in with Google, Microsoft or email code (#161)`. So the PR title carries the format, and the PR body carries `Closes #<issue>` for each issue it finishes.

## Releases

One version for the whole repo, tagged `v<major>.<minor>.<patch>`, with the release titled the same. The bump comes from the commits since the last release: any `!` is major, else any `feat` is minor, else any `fix` or `perf` is patch. A repo with its own release scheme (oneezy/skills' `release-<n>`) keeps it. The shared release tool is built on oneezy/tools#135.

## Chat titles

A chat title is an **origin marker**, a space, then the chat's name.

- **Name**: a chat about an issue takes the issue title plus its number. Any other chat takes the ticket shape, `<emoji> <area>: <the work>`.
- **Origin marker**: up to four emoji, in this order, each from a fact you verified (`references/titles.md` has the checks):
  1. Where the session runs: 💻 Justin's computer (also when his phone drives it), ☁️ cloud, 🌐 SSH. ✴️ marks a Claude Code session or a chat imported from one; join it to a known place as ☁️✴️ or 🌐✴️, and use it alone on Justin's computer. ❔ holds the place until it is known.
  2. 🤖 for a delegated subagent session.
  3. 🌳 while the working directory is a linked Git worktree.

```
💻 ✨ app: Sign in with Google, Microsoft or email code #160
☁️✴️🤖 🔎 app: Check Better Auth works with Supabase #171
✴️🌳 🔧 repo: Add releases, versions and changelogs
```

- **Set** the title once the chat's purpose is clear, and retitle it when its issue, task or working location changes. Both are pre-authorized. A title Justin gives word for word wins.
- **Rename** through this session's rename route (`references/titles.md`). With no route, put `Title: <title>` on the first line of your reply for Justin to apply.
- **Pinned voice chats** keep their title until Justin asks for a new one. Work they hand to separate tasks is titled by these rules.
- **Other chats** are renamed only in a cleanup Justin asks for.
- A title is display only: the chat's folder and project keep their names.

## Worktrees

A task worktree's folder is `<repo>-issue-<n>-<slug>`, `<repo>-pr-<n>-<slug>`, or `<repo>-<slug>` with no ticket: lowercase words joined by hyphens, the repo and the number first, and `<slug>` a few words naming the work (`brain-issue-2-fix-login`, `tools-pr-20-session-continuity`).

- Add a numeric suffix only on a collision.
- Pass the name wherever the creation route takes one: the `workspace` command of oneezy/tools `packages/remote-sessions/remote_sessions.py` does, and so do most harness worktree tools.
- Start the harness in the `WorkingDirectory` the `workspace` command returns.
- An existing worktree keeps its folder and its saved session paths.
- When an app chose the folder before you ran, report that the name was not yours to set.
