# ADR-0015: ChatGPT's plugins are account copies, updated inside ChatGPT and verified through Codex

Date: 2026-10-12. Status: accepted. Amends ADR-0007 (one form per harness) and the tools#150 decision that left Justin to decide whether the ChatGPT copies stay. Decided in the ChatGPT-in-sync work (oneezy/tools#196); Justin asked for everything in sync and for the agent to answer the open questions itself, so each answer below is the agent's pick, recorded here.

## Context

ChatGPT (the website and the desktop app) holds plugins on Justin's account, not on a machine. Checked 2026-10-12: OpenAI documents no API or CLI that uploads or updates a personal plugin; Plugin Creator inside a ChatGPT chat is the only writer (`get_plugin_files`, `update_plugin` with `expected_release_id` and `delete_paths`, create). A business workspace can import a GitHub marketplace that syncs daily, but only a workspace admin can, and Justin's account is personal. Nothing had ever run the hand-written upload checklist, so ChatGPT sat on an old release while every other harness followed the latest one. Separately, a Codex signed in with ChatGPT lists the account's own plugins as remote marketplaces (`created-by-me-remote`, `workspace-*`) beside the library's `oneezy-skills` ones, so each skill showed twice and `status` told Justin to uninstall the account copy.

## Decision

1. **One typed line per release.** Justin types `@oneezy-skills update my ChatGPT plugins to the latest oneezy/skills release` in ChatGPT; `/oneezy-skills` (`references/chatgpt-update.md`) reads the latest `release.json`, diffs each library plugin against its account copy file by file, updates or creates it through Plugin Creator, reads it back and reports. Typing the line authorizes every write that makes a copy exactly the release's, deletions included, for the library's plugins only.
2. **The account copies stay.** They are the ChatGPT destination, not a duplicate to remove. Codex loads both copies of each plugin, so a skill doubled only by the account's copy of the same plugin is a note in `status`, not red; a doubled plugin from any other marketplace (OpenAI's curated one included) keeps its uninstall step.
3. **Verified through Codex, no record.** `status` on a machine whose Codex is signed in with ChatGPT reads the account copies from Codex's own listing and shows a ChatGPT section: green at the release, a `chatgpt-update` manual step carrying the line when a copy is behind or missing. ChatGPT is Justin's account, not the machine, so it is never red. The config's `releases` record is no longer written; the account itself is the record.
4. **Every release plugin goes to ChatGPT**, as to Codex; `machines.plugins.chatgpt` in the config can narrow the list.

## Considered options

- **A scheduled or CI upload:** impossible, no API reaches a personal account.
- **Workspace marketplace import:** fully automatic, but needs a business workspace; recorded in `docs/agents/chatgpt-upload.md` for the day there is one.
- **Uninstall the account copies to keep Codex's list single:** leaves ChatGPT with no plugins at all, the opposite of in sync.
- **Record each upload in `skills-sync.json`:** ChatGPT cannot commit to GitHub without a write connector, and a record can drift from the account; reading the account through Codex cannot.

## Consequences

- The first run uses the account's current, older `/oneezy-skills`, which lacks the procedure, so that once Justin types a Plugin Creator bootstrap line (`docs/agents/chatgpt-upload.md`) that brings the oneezy plugin up; from then on the account carries the procedure and the short line works.
- A machine without a signed-in Codex cannot say whether ChatGPT is current; its `status` says so in one note.
