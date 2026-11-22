## Choose the meeting

Accept `/oneezy-meeting`, `$oneezy-meeting`, "Oneezy meeting," and "Onizi meeting." Treat slash forms as user request text; do not claim they register an application command. Keep this skill separate from any existing Oneezy or Onizi status skill. Do not capture `/oneezy-status` or rename or edit that skill.

Answer questions about this workflow and handle requested skill edits directly. Show the meeting menu only when the user wants a meeting report.

If the user does not specify a meeting type, show this menu as normal Markdown, not a code block, and stop to await their choice. Preserve any project, source, timeframe, or supplied update from the request for the next turn. Do not silently default to standup or prepare seven reports.

# 🗓️ Oneezy meeting

Which meeting would you like? Reply with its number or name.

1. Daily standup: Yesterday, today, and anything stopping progress.
2. Backlog refinement: Review upcoming tasks and make them clear and ready.
3. Sprint planning: Choose the goal and work for the next work period.
4. Sprint review: Summarize finished work and progress over a chosen period.
5. Sprint retrospective: Discuss what worked, what did not, and what to improve.
6. Quarterly review: Review results and priorities over three months.
7. Yearly review: Review results and priorities over a year.

Use a number as a meeting selection only in an explicit meeting request or after showing this menu. Do not interpret "two weeks" as meeting 2. Honor changed selections. If a number is outside 1 to 7, ask for a valid selection without inventing another meeting. If a name is unclear or multiple types are requested without an order, ask one focused clarification. Accept a requested ordered series and run one meeting at a time.

If the type is already clear, skip the menu. Recognize these names and aliases within a Oneezy meeting request, or as a reply to its menu:

| Number | Meeting | Aliases | Template |
| --- | --- | --- | --- |
| 1 | Daily standup | standup, daily scrum, daily check-in, /standup | [daily standup](daily-standup.md) |
| 2 | Backlog refinement | backlog, refinement, /backlog | [backlog refinement](backlog-refinement.md) |
| 3 | Sprint planning | planning, plan the next sprint, /sprint, /planning | [sprint planning](sprint-planning.md) |
| 4 | Sprint review | review, weekly review, progress highlights, /review | [sprint review](sprint-review.md) |
| 5 | Sprint retrospective | retrospective, retro, /retro | [sprint retrospective](sprint-retrospective.md) |
| 6 | Quarterly review | quarter review, /quarterly | [quarterly review](quarterly-review.md) |
| 7 | Yearly review | annual review, year review, /yearly | [yearly review](yearly-review.md) |

Read [shared rules](shared-rules.md) and only the selected template. Follow its evidence needs, period rules, prompts, and layout. Use the template locally; do not require its source repository to be available each time.
