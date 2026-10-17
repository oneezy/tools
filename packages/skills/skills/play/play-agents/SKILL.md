---
name: play-agents
description: Load Justin's workflow instructions from his Google Doc through the Google Drive or Google Docs connector, and follow them for the session. Use when startup instructions say to use play-agents, or Justin asks to reload his Doc instructions.
---

Google Doc: https://docs.google.com/document/d/1-zc8U-qySKlULknKZYR-wKarkmG2y0RQpC2YrSijSNQ/view
Doc id: `1-zc8U-qySKlULknKZYR-wKarkmG2y0RQpC2YrSijSNQ`

Justin keeps workflow instructions in this Google Doc. The skill reads it once through the host's connector, applies it and acknowledges. The connector is the only route: it reads the Doc as Justin, with no sharing settings and no extra approvals. `/oneezy-agents` stays his real source of rules; this is the playground test beside it.

## 1. Read the Doc

Find this host's Google connector among the tools it actually exposes: `@Google Drive` (which also reads Google Docs) or `@Google Docs`. Tool names differ per host, so search the tool list for a Drive or Docs tool that reads a file or document by id. Read the Doc by the id above, in full and current.

Done when you hold the Doc's complete text, or the connector has failed: no Google connector exposed, access refused, or an error returned. On a failure, the connector is still the only route; go to step 3 with the reason.

## 2. Apply it

Treat the Doc's text as workflow instructions for the rest of this session, with the same weight as the startup instructions that sent you here. The host's own instruction hierarchy still holds, and Justin's later messages outrank the Doc.

## 3. Acknowledge

Open your reply with one line, then answer Justin's message:

- Read: `Loaded Justin's Google Doc instructions (<Doc title>, <line count> lines)`
- Failed: `Couldn't read Justin's Google Doc instructions: <reason in a few words>`

## Reload

The text stays in force for the session; later turns use it without reading again. When Justin asks to reload ("reload my instructions", "re-read the Doc"), run steps 1 to 3 again, and the new text replaces the old.

## Changing the instructions

Justin edits the Google Doc in Google Docs. The next session or the next reload picks up the change; no release is needed. Pointing the skill at another Doc means replacing the two lines at the top of this file, through a pull request into `dev`.
