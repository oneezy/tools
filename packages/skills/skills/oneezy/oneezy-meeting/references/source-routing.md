# Source routing

## Resolve and use a dependency

1. Match the user's source, project, and period to the table below. Respect source exclusions before loading any dependency.
2. Check the current skill catalog and tool registry. Follow catalog pagination. Read the selected skill's instructions and invocation policy using the runtime's skill reader or its verified local path. Discover relevant plugin tools when supported. Treat a repository copy, installation flag, loaded skill, exposed tool, and successful account read as different evidence.
3. Use agent-callable dependencies through the available skill-loading or tool mechanism. In ChatGPT, `@` selects a plugin or skill in the composer. In Codex, `$skill-name` selects a skill. The `/oneezy-*` labels below are Justin's request aliases where the installed skill or host accepts them. Writing a mention in a response does not execute it or attach a plugin to a chat.
4. Check host policy before chaining skills. Respect `allow_implicit_invocation: false`, `disable-model-invocation: true`, and any explicit-only rule in the target's instructions. Do not bypass a user-only invocation restriction by loading its files or running its scripts. When the current host's meaning is uncertain, report the dependency as unavailable for chaining and provide the exact user invocation for that host.
5. Complete relevant authorized reads when tools are available. If a required dependency is unavailable, distinguish missing skill, missing tools, required user invocation, missing connection, and denied source access. Ask for the smallest necessary action only when it blocks the report; otherwise draft with a coverage note. Do not install plugins, run skill-sync, change permissions, schedule meetings, or write records merely to prepare a report.

## Choose the source

| Requested information | Skill or request alias | Plugin selector when needed | Evidence and limits |
| --- | --- | --- | --- |
| Brain priorities, notes, saved tasks, follow-ups | `/oneezy-brain`; canonical name `oneezy-brain` | `@Google Drive` | Load the current Brain skill and resolve its private Drive registry and live Schema/List. Consume the verified Inbox/Backlog and linked context Docs. GitHub Brain issues and Spaces are historical provenance, never fallback task state. If the installed skill is stale or Drive access is missing, report that exact gap and continue only independent sources. |
| Client repo tasks, code changes, pull requests, releases, docs | No extra skill required for evidence reads | `@GitHub` | Resolve the actual owner/repo and account. Read current project evidence. A closed issue supports its recorded status; check delivery evidence before claiming release. |
| A supplied Oneezy status report, or a separately requested status workflow | `/oneezy-status`; canonical name `oneezy-status` | `@GitHub` when its sources need it | Read a supplied status as evidence. For an explicitly requested status workflow, load its verified instructions when permitted. Keep its output separate from the meeting report and preserve its template. A meeting request alone does not trigger a second status report. |
| Existing sprint-review workflow explicitly named by the user | `/review`; canonical name `sprint-review` | Relevant source plugin | Keep the selected Oneezy meeting template authoritative for a Oneezy meeting. Use this separate skill only when requested or when its instructions provide a needed compatible reference. Avoid duplicate reports. |
| Earlier conversations or decisions absent from visible context | `personal-context` | Available Personal Context capability | Read the skill and use its search only when its conditions apply. Search results are continuity evidence; verify current work against direct sources. |
| ChatGPT Library files | `openai-library:library` | `@OpenAI Library` | Read the Library skill before searching or saving. Prefer current file contents to older summaries. Save only when authorized. |
| Drive docs, sheets, slides, transcripts | `google-drive:google-drive`, then its applicable `google-docs`, `google-sheets`, or `google-slides` skill | `@Google Drive` | Load the entry skill and relevant format skill. Retrieve only relevant files and full content needed for the report. |
| Gmail messages | No additional exposed Gmail skill required | `@Gmail` | Search and read relevant threads. Report preparation does not authorize sending mail. |
| Outlook messages | No additional exposed Outlook Email skill required | `@Outlook Email` | Use the correct account and relevant messages. No sending as part of report preparation. |
| Google meeting dates or event details | No additional exposed calendar skill required | `@Google Calendar` | Read relevant events. A scheduled event does not prove attendance or completion. |
| Outlook meeting dates or event details | No additional exposed calendar skill required | `@Outlook Calendar` | Read relevant events. Meeting selection does not authorize event creation or invitations. |
| Trello project tasks | No additional exposed Trello skill required | `@Trello` | Read the named board, lists, cards, and relevant updates. Keep recorded status distinct from delivery evidence. |
| monday.com project work | Relevant monday.com workflow if exposed at runtime | `@monday.com` | Read the named project or board and relevant items. Do not update tasks to make the report match a proposed plan. |
| Figma design work | `figma:figma-use` for `use_figma`, or the operation's mandatory prerequisite such as `figma-design-to-code` | `@Figma` | Load the exact prerequisite before its tool. Retrieve relevant file or node evidence; an existing design does not establish implemented behavior. |
| Vercel deployments or build status | `vercel:vercel-api` or `vercel:deployments-cicd` as relevant | `@Vercel` | Load applicable guidance and read deployment evidence. Keep code merge, successful build, and production deployment distinct. |
| ChatGPT Pages or Spaces | Applicable `pages:write-page`, `pages:maintain-space`, or `pages:organize-space` skill for an authorized write | `@Pages` | Read relevant accessible pages through exposed tools. Use a writing skill only when saving or editing is authorized. |
| Justin's writing style and final report wording | `write-like-me:write-like-me`, `unslop` | `@Write Like Me` when style retrieval is needed | Apply available writing instructions. These shape prose; they do not supply project-completion evidence. Keep source attribution and uncertainty intact. |
| Local text documents, PDFs, spreadsheets, decks | `documents`, `pdf`, `Spreadsheets`, `Presentations` as applicable | Source plugin only when needed | Read format-specific instructions. Artifact creation and saving follow the requested output and authorization. |
| Another named provider, such as WhatsApp, Slack, Teams, Notion, or Box | Discover an applicable skill | Discover the exact plugin selector | Inspect current tools, then use `plugin-management:plugin-management` discovery before declaring access unavailable. Do not infer access from an old chat, package cache, or a recommended plugin. |

For a missing dependency, provide a concrete continuation prompt with the same project, period, and meeting type, for example `@GitHub /oneezy-meeting review the last 2 weeks for owner/repo`. Tell the user to select the actual `@` item in ChatGPT. Include `/oneezy-brain` only where its installed alias is accepted; otherwise use the skill selector available in that host.

## Current discovery

Discover dependencies in the current host before using them. Repository presence does not prove installation, loaded instructions do not prove tool access, and an exposed tool does not prove account authorization. Use the capability discovery guide for a missing source, and report only the evidence obtained in this run.

Official invocation references: [Plugins](https://learn.chatgpt.com/docs/plugins), [Build skills](https://learn.chatgpt.com/docs/build-skills). Check the current host's instructions before relying on a selector or policy.
