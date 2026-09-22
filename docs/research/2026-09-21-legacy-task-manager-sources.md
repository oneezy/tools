# Legacy task-manager sources: what they actually specify

Research for [What do the legacy task-manager sources actually specify?](https://github.com/oneezy/tools/issues/6), part of the map [Tools: every tool in clis/ runs from its .cmd on every host](https://github.com/oneezy/tools/issues/1). Read-only: nothing in the Sheets or `.legacy/` was modified.

## Summary

- Five Sheets and 35 legacy files collapse to about a dozen distinct sources: one 2023 GPT-era task schema (Sheet 1 + `.legacy/*/data/`, byte-identical across the three `agile-*` folders) and one 2017-2021 Favro-era label vocabulary (Sheets 2-5, three of which are copies).
- The consolidated ticket has ~40 fields, of which the ones Justin actually drove meetings from are: type, three-axis priority (developer MoSCoW / business / customer), Fibonacci estimate, a 7-8 step status ladder with per-column WIP limits, view, sprint, dependencies before/after, due date, and archived.
- Eight meeting commands exist but only Daily Standup (`/standup`, 15 min, daily) has a script; Sprint Planning, Backlog Refinement, Review, Retro and Quarterly have only a slot on the calendar, and Yearly and Release Demo are names only. Monday planning plus Friday review/retro implies one-week sprints at 20 points/week.
- Sources conflict on priority scheme (4 variants), status set (6 variants, with emoji collisions between priority and status), default view, meeting command names, and whether Blocked is a status or a tag.
- Wayfinder/triage/to-tickets plus native GitHub already cover hierarchy, blocking, claim, comments, checklists and the "inbox" bucket; the real gaps are Projects fields (Status ladder, Priority, Estimate, Iteration, Due), WIP limits, the recurring/frequency idea, and the meeting cadence as skills.

## 1. Inventory

### Google Sheets (all five readable; tab names and gids recovered from the public `htmlview` page)

| # | Title (owner, created / modified) | Tabs (gid) | What it contains | Duplicate of |
|---|---|---|---|---|
| S1 | **Backlog (dev)** (justinoneill2007, 2023-10-09 / 2026-09-21) | `Backlog` (1915777059, the README link), `Schema` (1170366056), `list` (495817315) | The 2023 task schema. `Backlog`: 41 flat columns (`id … action`), 11 rows of generated sample data (fictional org "Quanta", projects "Brix Worx v1" / "Moixin Deal v2", seven fictional users). `Schema`: 42 keys with order, REQUIRED flag, allowed values, instructions, and who fills it (auto generate / ask user / user only). `list`: a prompt table used to generate the sample rows (allowed options per column). | Flat form of `collections.txt` and `tasks.json`; field docs match `instructions.md` |
| S2 | **Agile/ Scrum Labels** (justinoneill2007, 2017-05-07 / 2021-09-17) | `LABELS` (2023871387, README link), `WORKFLOW` (1341131013) | "AGILE + SCRUM + GTD (LABELS)": 29 label columns (CATEGORY, USER ROLES, ACTION Yes/No, INVOICE, CLIENT Workflow, ROAD MAP, BACKLOG Status/Type, USER STORY Status, DESIGN, DEVELOPMENT, BUG TRIAGE/TYPE/PRIORITY, SEMVER, CONTEXT, TIME, RELEASES, CYCLES, PRIORITY, DIFFICULTY, POINTS, ENERGY, FREQUENCY, REMINDERS, PROCESS). `WORKFLOW`: a client pipeline LEAD → CONTACT FORM → QUESTIONNAIRE → PROPOSAL → CONTRACT → INVOICE → STATUS → REVIEW. | Superset of the `LABELS` tab in S3-S5 (adds 16 columns) |
| S3 | **Agile System** (worxcoin, 2018-07-10 / 2021-08-12) | `tags` (38292496), `collections` (920657178), `LABELS` (2023871387, README link) | `tags`: Favro-era label board, 35 columns grouped AGILE//SCRUM, SOFTWARE, SALES, BUGS, TIME, ESTIMATES, WSJF, plus the COLLECTIONS column (Dashboard, Backlog/Planning/Sprint levels, Road Map, Calendar, Reference, Inbox). `collections`: Favro setup, ORG > COLLECTION > BACKLOG > BOARD with "Ready for…" columns. `LABELS`: 13-column lite label set. | `collections` and `LABELS` byte-identical to S4 and S5; `tags` identical except blank-row spacing and one duplicated "★ Tester" cell |
| S4 | **3. Agile System (Favro)** (wwwinfraredcameras, 2017-11-20 / 2021-09-09) | `tags` (38292496, README link), `collections`, `LABELS` | Same three tabs as S3. | Copy of S3 (`collections`, `LABELS` md5-identical; `tags` differs only by empty rows) |
| S5 | **Agile System (Favro)** (coinbotvps, 2018-06-12 / 2023-03-16) | `tags` (38292496, README link), `collections`, `LABELS` | Same three tabs as S3/S4. | Copy of S3/S4 (same md5 for `collections` and `LABELS`; `tags` spacing-only diff) |

S3, S4 and S5 are three copies of one workbook shared into three Google accounts; S2 is the older, larger label sheet they were trimmed from. Only S1 carries the task schema that the 2023 GPT prompts run on. The README's gid for S3 points at its lite `LABELS` tab; for S4 and S5 it points at `tags`.

### `clis/task-manager-cli/.legacy/`

The three `data/` folders under `agile-dev/`, `agile-meetings/` and `agile-story-mapping/` are byte-identical (md5 checked, nine files each). Only the `prompt.txt` files differ.

| Path | What it contains | Duplicate of |
|---|---|---|
| `agile.txt` | Transcript of a YouTube talk on Kanban/agile boards: process vs buffer columns, trigger point, WIP limits (people × 1.5-2), card aging, blocked-item handling, swim lanes, imperative column names, pull not push, shared WIP, "walk the board" from top right. Reference material, not Justin's own spec. | unique |
| `collections.txt` | Nested data model `collections > organizations > projects > tasks` with the full task field tree (priority.developer/business/customer, date.*, user.*, details.*, dependencies.*, action.*). | Tree form of S1 `Schema` and `tasks.json` |
| `[EMOJI_LABELS].txt` | Emoji vocabulary: Tasks (🔲 Todo ✅ Done ⭐ Important ❤️ Fav), Priority (🟩🟨🟧🟥 Low→Critical), Kanban (⚪ Todo 🔵 Next 🟡 Doing 🟠 Review 🔴 Blocked 🟢 Done), Phase (🟦 Development 🟪 Staging ⬛ Production), Log, and ~24 topic tags. | unique |
| `[PROJECT_TEMPLATE].txt` | A client folder tree (Assets, Financial, Communications, Project Management, …). Not about tickets. | unique |
| `agile-*/data/Instructions.txt` | Daily Standup script: eight actions (Greet, Main Goal, Wins, Blockers/Deadlines, Donut Chart, Priority Table, three-question checklist, Show JSON). | Text form of the `Daily Standup` entry in `meetings.json` |
| `agile-*/data/TaskBreakdown.txt` | A four-line prompt: break a task into sub-tasks with guidance, **estimated hours**, and a learning link each. | unique |
| `agile-*/data/_instructions.md` | Zapier-backed GPT that reads/updates a Google Sheet. Defines the bracket notation, the `/{v} table|list|code|download|summary|steps|checklist` output commands, and "Backlog Columns" (priority Critical→Low, Fibonacci estimations, 7 statuses, 9 types, dates, owner, dependencies, views). | Near-duplicate of `taskmanager.md` |
| `agile-*/data/instructions.md` | The prose field spec ("like Trello or Favro … inspired by GTD"): every task attribute with type, allowed values and defaults, including the MoSCoW/WSJF/Kano priority triad, phase, team, semver, frequency, location, GTD action. | Prose form of S1 `Schema` |
| `agile-*/data/instructions-v2.md` | Meeting-Leader GPT working from uploaded `meetings.json`, `team.json`, `tasks.json`; greets, offers the meeting menu (`/standup /backlog /sprint /review /retro /quarterly /yearly`), summarises yesterday/today/blockers, shows top-10 table, suggests next task. | Same text as `agile-meetings/prompt_old.txt` (formatting only) |
| `agile-*/data/taskmanager.md` | Scrum-Master GPT: variable notation (`(v)` generated, `[v]` user choice, `$v` default, `?v` ask, `!!v` required, `~v` optional, `/v` command), the same commands, task fields with `$new` added to status, and two modes (numbered replies, minified JSON every fifth reply). | Near-duplicate of `_instructions.md` |
| `agile-*/data/meetings.json` | Six meetings with command, leader, participants, day, start/end, duration, frequency. Only Daily Standup has instructions; the other five have empty action lists. | Source of truth for section 3 |
| `agile-*/data/tasks.json` | Empty instance of the nested schema (one collection/org/project/task with every field blank; `version: "0.0.1"`). | Instance of `collections.txt` |
| `agile-*/data/team.json` | Justin's profile: roles Developer + Design, **WIP limits per status**, **20 story points per week**, and the **story-point examples table** (1 → 5-10 min … 13 → 1-2 weeks). | unique, load-bearing |
| `agile-dev/prompt.txt` | Empty (0 bytes). | n/a |
| `agile-meetings/prompt.txt` | "Roy", a cowboy scrum master persona; command menu adds `/help`, `/meetings`, `/release` (Release Demo); standup template with Yesterday ✅ / Today 🔲🟨 / Blockers 🟥 lists and a JSON recap. | unique |
| `agile-meetings/prompt_old.txt` | See `instructions-v2.md`. | duplicate |
| `agile-story-mapping/prompt.txt` | Story-mapping facilitator: eight steps (Big Picture → Capture Ideas → Organize → User Journey → Prioritize → Iterations → Gaps → Execute) producing a table with theme/category columns and priority rows (1 = MVP, 2, 3 …). | unique |

## 2. Consolidated ticket shape

Merged from S1 `Schema` (authoritative for allowed values and defaults), `instructions.md` (prose), `collections.txt`/`tasks.json` (nesting), `team.json` (limits and examples), and the label sheets where they add something.

### Hierarchy

`collection` (personal | work) → `organization` → `project` → `task`. Earlier Favro form: ORG (ONEEZY) → COLLECTION (Inbox, Trash, Calendar, Reference, Backlog/Planning/Sprint levels, Road Map) → BACKLOG → BOARD.

### Fields

| Field | Required | Values / default | Who fills |
|---|---|---|---|
| id | yes | integer, auto | system |
| title | yes | string, "3-4 words"; also `short title` | system from user input |
| tags | yes | 2-3 lowercase keywords (`#tag`) | system, refined over time |
| type | yes | epic, feature, **task** (default), tech debt, learning, reference, question, meeting, bug, support | user/system |
| views | no | Inbox, Backlog, Kanban, Sprint, Archived; default Inbox (Schema) or Backlog (prompts, see conflicts) | system |
| sprint | no | on hold, in planning, current, next, complete; default blank | user |
| priority.developer | yes | 🟥 Must have, 🟧 Should have, 🟨 Could have, ⬜ Won't have (MoSCoW); "Must have first" | user |
| priority.business | no | WSJF float (Schema) or 1-5 ⭐ (sample data) | user |
| priority.customer | no | Basic, Performance, Excitement (Kano) or 😟😐🙂 | user |
| estimation | yes | 1, 2, 3, 5, 8, 13, 21 | system by complexity, user confirms |
| status | yes | ⬜ To Do (default), 🟦 Next Up, 🟨 In Progress, 🟥 Blocked, 🟩 Done, 🟧 In Review, 🟪 Complete (+ `$new` and 🟪 Staging / ⬛ Complete in some sources) | user via meetings |
| date.created / modified | yes | auto | system |
| date.due | no | "Always show these tasks first" | user |
| user.created | yes | defaults to the creating user (Justin) | system |
| user.assigned / user.owned | no | | user |
| phase | no | new, on hold, in planning, design, development, alpha, beta, rc, rtm, production | user |
| details.summary | no | 40-60 words, auto | system |
| details.description | no | | user |
| details.steps | no | ordered list | system |
| details.checklist | no | items with complete/incomplete counts; "🔲 subtask" / "✅ s̶u̶b̶t̶a̶s̶k̶" | user |
| details.requirements | no | ordered list | user |
| details.comments[] | no | time, user, comment; total auto | user only |
| team | no | agile, business, content, designer, developer, qa, support, marketing, photography, print, video (multi) | user |
| version | no | semver; patch/feature by judgement, "always ask if breaking change" | system |
| dependencies.before / after / total | no | arrays of task ids; total derived | user/system |
| frequency | no | once (default), daily, weekly, monthly, quarterly, yearly | user |
| archived | no | boolean, default false | user only |
| location | no | home, work, local, travel, event (or home/work/errands; or GTD contexts Home/Work/Phone/Tablet/Computer/Errands) | user |
| action.yes | no | do it, delegate it (assign owner), defer it (date specific), project, automate | user |
| action.no | no | trash it (archive), incubate it (create due date), reference it | user |

### Statuses (ladder, with the per-column WIP limits from `team.json`)

| Status | WIP limit | Notes |
|---|---|---|
| ⬜ To Do | none | default |
| 🟦 Next Up | 3 | Favro "➜ Up Next"; `[EMOJI_LABELS]` "🔵 Next" |
| 🟨 In Progress | 3-5 | "🟡 Doing" |
| 🟥 Blocked | 2 | a status here; `agile.txt` argues for a tag that still counts toward WIP |
| 🟩 Done | none | dev-done; precedes review |
| 🟧 In Review | 2 | |
| 🟪 Complete | none | accepted/released; S1 `list` inserts 🟪 Staging before ⬛ Complete |

The Favro `collections` tab adds the flow columns between levels: "Ready for… BACKLOG / PLANNING / SPRINT / DESIGN / WEB / MARKETING", plus BLOCKERS, TRASH, COMPLETE lanes per level. These are the buffer columns `agile.txt` describes (a column where no work is done, owned by the upstream stage, pulled by the downstream one).

### Types

epic, feature, task, tech debt, learning, reference, question, meeting, bug, support. The label sheets reduce this to Feature, Support, Architecture, Technical Debt, with bugs handled as their own board (BUG: STATUS Open/Closed, BUG: TYPE Minor/Major/Breaking, BUG: PRIORITY Fix Now/Later/Future/Never/What).

### Priority dimensions

1. **Developer**: MoSCoW (Must/Should/Could/Won't) in the 2023 schema; Low/Medium/High/Critical (1-4) in every other source.
2. **Business**: WSJF. The `tags` tab decomposes it: PROFIT VALUE, TIME CRITICAL, OPPORTUNITY, SIZE, each ▰▱▱▱ 1-4, and a `wsjf` result column. The 2023 sample data simplified it to 1-5 stars.
3. **Customer**: Kano (Basic / Performance / Excitement), rendered 😟 😐 🙂.
4. Also present in the sheets and never used in the prompts: FEATURE: PRIORITY as "We Want / Need / Promise / Require" and "We Would / Could / Should / Must"; DIFFICULTY (Easy/Normal/Hard/Extreme); ENERGY (0-100 %).

### Fibonacci estimation

Scale 1, 2, 3, 5, 8, 13, 21 (S2 `POINTS` also lists 0). Capacity: **20 story points per week**. `team.json` examples:

| Points | Time | Complexity | Example |
|---|---|---|---|
| 1 | 5-10 min | very easy | quick tasks |
| 2 | 20-30 min | easy | small CSS tweaks |
| 3 | 1-2 h | moderate | simple components |
| 5 | 4-8 h | moderate to hard | designing logos or ads |
| 8 | 2-3 days | hard | features needing research |
| 13 | 1-2 weeks | needs refinement | high-level features |
| 21 | (undefined) | | |

Rules stated in the prompts: the system proposes the estimate from complexity and time; tables sort by priority desc then estimate asc; tables show the story-point sum in the header; `TaskBreakdown.txt` instead asks for hours per sub-task, and the sheets keep a separate HOURS scale (1 h … 6 months).

### Views

Inbox (capture, GTD), Backlog, Kanban, Sprint, Archived. Favro collections: Dashboard, Inbox (integrations), Calendar, Reference, Bugs, Road Map (Crawl / Walk / Run), Trash. Levels: ❶ Backlog (High), ❷ Planning (Mid), ❸ Sprint (Low), ➜ Road Map (Space).

### Dependencies

`before` (ids this task depends on), `after` (ids that depend on it), `total`. `_instructions.md`: "use task id to control". (S1 `Schema` describes both arrays with the same sentence; a copy error.)

### Archive

`archived: false` by default, user-only; `views` includes Archived; GTD `trash it (archive)`; Favro has a TRASH lane per level. Nothing says when Complete items get archived.

## 3. Meeting types

From `meetings.json` unless noted. Participants beyond the leader are "Developer Team" for standup and unspecified elsewhere; in practice the team is Justin (`team.json`).

| Meeting | Command | Leader | Cadence | Duration | Inputs | Outputs | Decides |
|---|---|---|---|---|---|---|---|
| Daily Standup | `/standup` | 🥋 Scrum Master | daily 09:00-09:15 | 15 min | tasks in the current sprint; answers to yesterday / today / blockers | greeting; sprint goal restated; wins; blockers and deadlines; donut chart of sprint status; top-priority table (ID, Project, Title (count), Tags, Type, Priority, Estimations (sum), Status; sorted priority desc, estimate asc; filtered To Do / Next Up / In Progress / Blocked / Done); updated statuses; suggested next task with reasoning; JSON snapshot | what moves today, what is blocked, which task is next |
| Sprint Planning | `/planning` (json) / `/sprint` (prompts) | Product Owner | Monday 10:00-12:00, start of sprint | 2 h | (unspecified) | (unspecified) | sprint goal and sprint backlog (implied by Scrum, not written) |
| Backlog Refinement | `/backlog` | Product Owner | Wednesday 11:00-12:00, weekly | 1 h | (unspecified) | (unspecified) | estimates, priorities, splitting (implied) |
| Sprint Review | `/review` | Product Owner | Friday 13:00-14:00, end of sprint | 1 h | (unspecified) | (unspecified) | what is Done vs Complete (implied) |
| Sprint Retrospective | `/retro` | Scrum Master | Friday 15:00-16:00, end of sprint | 1 h | (unspecified) | (unspecified) | process changes (implied) |
| Quarterly Review | `/business` (json) / `/quarterly` (prompts) | CEO | first Monday of the quarter 13:00-16:00 | 3 h | (unspecified) | (unspecified) | road map (Crawl/Walk/Run, Q1-Q4 labels) (implied) |
| Yearly Review | `/yearly` | (none) | (none) | | | | name only |
| Release Demo | `/release` | (none) | (none; `agile-meetings/prompt.txt` only) | | | | name only |

Menus: `/meeting` or `/meetings` shows the list; `/help` lists commands; `/tasks table` prints the backlog. Every meeting session opens with a summary of Yesterday/Today/Blockers, flags tasks with blockers or due dates, shows the top-10 table, and suggests the next task; every session ends with an updated `tasks.json` (or a Sheet update via Zapier). Monday planning and Friday review/retro imply a **one-week sprint**, consistent with "Story Points Per Week: 20". No source states the sprint length outright.

Two facilitated sessions live outside `meetings.json`: **story mapping** (eight steps to a theme × priority table, `agile-story-mapping/prompt.txt`) and **task breakdown** (sub-tasks with guidance, hours and a learning link, `TaskBreakdown.txt`).

## 4. Vocabulary (candidate CONTEXT.md entries)

Terms Justin coined or consistently reused; not written to CONTEXT.md.

- **Backlog / Planning / Sprint / Road Map**: the four altitudes (High, Mid, Low, "Space" level). Road map phases are **Crawl, Walk, Run**.
- **Ready for…**: a buffer column between two stages ("Ready for… SPRINT"); work waits there to be pulled. Matches `agile.txt`'s buffer column.
- **Next Up**: the status after To Do; the short queue (limit 3) the next pull comes from.
- **Blockers**: a lane/status, not a tag, in every one of Justin's sources.
- **Inbox / Reference / Trash / Calendar / Dashboard**: GTD-style collections around the boards.
- **Views**: Inbox, Backlog, Kanban, Sprint, Archived, the perspectives a task appears in.
- **Story points / points per week**: Fibonacci estimate and weekly capacity (20).
- **WIP limit**: a per-status cap (`team.json`).
- **Priority triad**: developer (MoSCoW), business (WSJF), customer (Kano).
- **Type**: epic, feature, task, tech debt, learning, reference, question, meeting, bug, support.
- **Phase**: new → on hold → in planning → design → development → alpha → beta → rc → rtm → production.
- **Action** (GTD): do it / delegate it / defer it / project / automate; trash it / incubate it / reference it.
- **Meeting Leader** (a.k.a. Expert Agent): the persona a meeting is run as (Scrum Master, Product Owner, CEO).
- **Collection > Organization > Project > Task**: the 2023 hierarchy; `collection` is personal | work.
- **Slash commands** for meetings (`/standup`, `/backlog`, `/sprint`, `/review`, `/retro`, `/quarterly`, `/yearly`, `/release`) and output modifiers (`/{v} table|list|code|download|summary|steps|checklist`).
- **Bracket notation**: `(v)` agent-generated, `[v]` user's pick from a list, `{v}` template, `$v` default, `?v` ask if unsure, `!!v` required, `~v` optional.
- From `agile.txt`, kept as reference terms: process column vs buffer column, trigger point, card aging, single-piece flow, shared WIP, silver-bullet swim lane, walk the board (top right first), imperative column names.

## 5. Conflicts between sources

| Topic | Variants | Where |
|---|---|---|
| Priority scheme | Critical/High/Medium/Low (⬜ Low in `_instructions.md`, 🟩 Low in `[EMOJI_LABELS]`); MoSCoW Must/Should/Could/Won't; business as WSJF float vs 1-5 stars vs four ▰▱ sub-scores; customer as Kano names vs 😟😐🙂; "We Want/Need/Promise/Require" | `_instructions.md`, `taskmanager.md`, `[EMOJI_LABELS]`, S1 `Schema` vs `list`, S2-S5 `tags`/`LABELS` |
| Status set | 7 (Schema, `instructions.md`, `team.json`); 8 with `$new` (`taskmanager.md`); 8 with 🟪 Staging + ⬛ Complete (S1 `list`/`Backlog`); 6 with different colours ⚪🔵🟡🟠🔴🟢 (`[EMOJI_LABELS]`); Favro On Hold/Blocker/Up Next/In Progress/Done/In Review/Complete; S2 Backlog Status New/In Progress/Complete/On Hold/Blocked | as listed |
| Emoji collisions | 🟥 = Critical/Must have and Blocked; 🟧 = High and In Review; 🟨 = Medium/Could have and In Progress; 🟪 = Staging (phase) and Complete (status) | `[EMOJI_LABELS]` vs `_instructions.md`/Schema |
| Done vs Complete | Done precedes In Review precedes Complete; nothing defines the difference; `phase` (staging/production) overlaps with the Staging status | Schema, S1 `list` |
| Default view | `$backlog` (`_instructions.md`, `taskmanager.md`, `instructions.md`) vs "defaults to inbox" (S1 `Schema`); Sprint is a view in `instructions.md` but a separate field in `Schema` | |
| Types | 9 (`_instructions.md`) vs 10 with `question` (`instructions.md`, Schema) vs 4 (sheets) | |
| Estimation | Fibonacci everywhere, but S2 POINTS includes 0; 21 has no example; `TaskBreakdown.txt` and the sheets' HOURS column estimate in time; 13 = "1-2 weeks" against a 20-points-per-week capacity | `team.json`, S2, `TaskBreakdown.txt` |
| WIP limits | In Progress 3-5 (`team.json`) vs `agile.txt`'s rule people × 1.5-2 (2-3 for one person); `agile.txt` says a blocked card should stay in its column and count toward WIP, Justin's sources move it to a Blocked status/lane | `team.json`, `agile.txt` |
| Meeting commands | `/planning` and `/business` (`meetings.json`) vs `/sprint` and `/quarterly` (all prompts); `/release`, `/yearly`, `/help`, `/meetings` only in `agile-meetings/prompt.txt`; `meetings.json` has no Yearly Review | |
| Meeting leaders | Sprint Planning led by Product Owner, Retro by Scrum Master, Quarterly by CEO; one person plays all three | `meetings.json`, `team.json` |
| Dependencies | `after` documented with the `before` sentence; `action` values in the sample rows (assign it, deadline, create project, automate it, archive it) are not in `action.yes`/`action.no` | S1 `Schema` vs `Backlog`/`list` |
| Location | home/work/local/travel/event vs home/work/errands vs GTD contexts Home/Work/Phone/Tablet/Computer/Errands | `instructions.md`, S1 `list`, S2/S3 `LABELS` |
| Team taxonomy | 11 `team` values vs TEAM (Board Member, Bugs, Design, Drone, Engineering …) vs CATEGORY vs USER ROLES: four overlapping lists | Schema, `tags`, `LABELS` |
| Owner | single `owner [Justin]` vs `user.created/assigned/owned` triple with seven fictional users | `_instructions.md` vs Schema |
| Data store | Google Sheet read/written through Zapier (`_instructions.md`, `taskmanager.md`) vs uploaded `tasks.json` re-downloaded each session (`instructions-v2.md`); the map rules out writing to Sheets at all | |

## 6. Delta table

"Already provided" refers to `.claude/skills/wayfinder`, `triage`, `to-tickets`, `oneezy-status`, `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and native GitHub Issues / Projects v2.

| Legacy concept | Already provided | Gap |
|---|---|---|
| Collection > Organization > Project > Task | Account (`oneezy`, `layerdbiz`) > repo > issue; a Projects v2 board can span repos; a wayfinder **map** with **sub-issues** is the epic | The personal/work `collection` and the cross-repo "Work" overview (already in the map's Not yet specified) |
| Type (epic, feature, task, tech debt, learning, reference, question, meeting, bug, support) | triage category roles `bug` / `enhancement`; `wayfinder:map|research|prototype|grilling|task` labels | learning, reference, question, meeting, support, tech debt have no home; decide labels vs GitHub issue types |
| Status ladder To Do → Next Up → In Progress → Blocked → Done → In Review → Complete | Open/closed; assignee = **claim** (In Progress); native **blocked_by** = Blocked; triage state roles `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`; `/oneezy-status` Next Up (3) | A Projects Status field with these columns (default is Todo / In Progress / Done); Done vs Complete definition; whether Blocked is derived from dependencies or a column |
| Priority (developer / business / customer) | Nothing; wayfinder orders by map order; triage has no priority | A Priority field and one scheme (MoSCoW vs Low-Critical); WSJF/Kano probably dropped for one person |
| Fibonacci estimate, 20 points/week, examples table | Nothing (to-tickets sizes to "one context window") | A Projects number field; the examples table as agent guidance; capacity per iteration |
| Views Inbox / Backlog / Kanban / Sprint / Archived | triage "show what needs attention" (unlabeled = Inbox); frontier query = takeable Backlog; Projects board/table/roadmap views | Named views per project, created zero-touch |
| Sprint (on hold / in planning / current / next / complete) | Nothing | Projects Iteration field; length (one week inferred); roll-over automation |
| WIP limits per status | Projects board columns support a column limit | Values (Next Up 3, In Progress 3-5, Blocked 2, In Review 2) and enforcement |
| Dependencies before / after / total | Native issue dependencies (`blocked_by` / `blocking`), visible in the UI, used by wayfinder | None; `total` is derived |
| Archived / Trash | Closed issues; Projects auto-archive workflow; `wontfix` + `.out-of-scope/` KB | Policy for when Complete items are archived |
| Tags | Labels | A label taxonomy per repo (emoji or not) created zero-touch |
| created / assigned / owned | author / assignee | None for one person |
| Dates created / modified / due | Native created / updated | A Due date field |
| Phase (development → production) | Branch model dev/main and Vercel previews | Not a ticket field; derive from PR state |
| Version (semver per task) | Releases / tags | Drop from tickets |
| Frequency (recurring) | Nothing | Recurring issues need a scheduled workflow, or drop |
| Location / Context / Energy | Nothing | Belongs to the personal "brain" project (out of scope) |
| GTD action (do / delegate / defer / project / automate; trash / incubate / reference) | `ready-for-human` ≈ do it; `ready-for-agent` ≈ delegate; `needs-info` ≈ defer; `wontfix` ≈ trash; `.out-of-scope/` and `docs/` ≈ reference; a map ≈ project | incubate (date trigger) |
| Meetings: standup / planning / refinement / review / retro / quarterly / yearly / release | `/oneezy-status` (standup output: Overview, Next Up, next prompt); `/triage` (refinement); `/wayfinder` charting (story mapping); `/to-tickets` (planning breakdown); `/code-review` (review) | Cadence and calendar; retro, quarterly, yearly, release demo; meeting commands as skills; donut chart and priority table |
| Meeting Leader personas | Skills already carry the role | None |
| Details: summary / steps / checklist / requirements / comments | Issue body, task lists, comments, `AGENT-BRIEF.md`, to-tickets acceptance criteria | None |
| Data store (Sheet via Zapier, `tasks.json`) | GitHub issues + Projects | None; map rule: never write to Sheets or a local tracker |
| Client pipeline (Lead → … → Invoice) and `[PROJECT_TEMPLATE]` | Nothing | Out of scope for task-manager |
| Road map Crawl / Walk / Run, Quarter labels | Milestones; Projects roadmap view | Decide milestones vs a Roadmap field |

## Sources

Google Sheets (read-only; CSV export `…/export?format=csv&gid=<gid>`):

- S1 Backlog (dev): https://docs.google.com/spreadsheets/d/15Y-ckNg5aO5PlqZfjJhT5mmluhe3u1R-f-YflbBInjs (tabs `Backlog` 1915777059, `Schema` 1170366056, `list` 495817315)
- S2 Agile/ Scrum Labels: https://docs.google.com/spreadsheets/d/1flyQ-gWJ0oYroYGEZ5xScl7Qe1R6qPrrvyL7F9XGpJc (tabs `LABELS` 2023871387, `WORKFLOW` 1341131013)
- S3 Agile System: https://docs.google.com/spreadsheets/d/1bS1aRXIVHjzawLNAhFvRZjVj7wbMxW_YWLRZYybEoFA (tabs `tags` 38292496, `collections` 920657178, `LABELS` 2023871387)
- S4 3. Agile System (Favro): https://docs.google.com/spreadsheets/d/18Of37IbEJvcY-OWME4Unok5fZDBQBGZrIAoN7TsVyTA (same tabs)
- S5 Agile System (Favro): https://docs.google.com/spreadsheets/d/1e9qBcirsiyqPu-MtPjTzFnkibE8pr8sfzYIHpeM9Lbg (same tabs)

Repo files:

- `clis/task-manager-cli/README.md`
- `clis/task-manager-cli/.legacy/agile.txt`, `collections.txt`, `[EMOJI_LABELS].txt`, `[PROJECT_TEMPLATE].txt`
- `clis/task-manager-cli/.legacy/agile-dev/data/*` (identical to `agile-meetings/data/*` and `agile-story-mapping/data/*`)
- `clis/task-manager-cli/.legacy/agile-dev/prompt.txt` (empty), `agile-meetings/prompt.txt`, `agile-meetings/prompt_old.txt`, `agile-story-mapping/prompt.txt`
- `.claude/skills/wayfinder/SKILL.md`, `.claude/skills/to-tickets/SKILL.md`, `.claude/skills/triage/SKILL.md`, `.claude/skills/oneezy-status/STATUS.md`
- `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`
