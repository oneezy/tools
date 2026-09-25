# Status

The one message `/oneezy-status` produces. One template; each slot names its source per state. Copy it, fill every slot, apply the rules. Nothing above the H1, nothing below the code block.

## Template

````markdown
# <subject> <state>

**<prefix>:** <headline> ([open](<headline url>)) `<labels>`

<One line: what was done, in plain words.> Milestone <name> in <days> days.

### Quick Links

- PR #<n> ([open](<pr url>))
- Task Board ([open](<board url>))
- <Branch | Dev Branch> ([open](<github branch url>))
- Vercel ([open](https://vercel.com/<team>))
- Apps
  - <project> ([branch](<branch preview url>)) ([dev](<base preview url>))

### Overview (<open>/<total>)

- ✅ ~~[#<n>](<url>) <ticket title>~~ `<labels>`
  - <what was done, up to five bullets>

### Git

<one line>

### Builds (<count>)

- ✅ <project>

### Errors (<total>)

- ❌ <source>: <count> `<message>` in `<file>`

<one line: the read of the failure and the smallest fix>

### Warnings (<total>)

- ⚠️ <source>: <count> `<rule or message>` in `<file>`

### Next Up (3)

1. [#<n>](<url>) <title> `<labels>`
2. [#<n>](<url>) <title> `<labels>`, by hand
3. [#<n>](<url>) <title> `<labels>`

<Two or three sentences: take item 1 because <why>; what 2 and 3 unblock; what can run in parallel; whether this differs from the board's Next Up column.>

```text
<opening skill per the table in SKILL.md> … Do not touch main. Commit only when I say so, then run /oneezy-merge into <base>.
```
````

## Slots by state

| Slot | closeout | open | blocked | branch |
|---|---|---|---|---|
| subject | `PR #<n>` | `PR #<n>` | `PR #<n>` | `` `<branch>` `` |
| state word | closeout | open | blocked | status |
| prefix, headline | PR title split at the colon | same | same | last commit subject split at the colon; `**tree:**` and the branch name when there is no commit ahead |
| labels | tickets the PR closes | tickets the PR will close | same | tickets named in commit subjects |
| Quick Links | PR, Task Board, Dev Branch, Vercel, Apps with branch and dev | PR, Task Board, Branch, Vercel, Apps with branch only | same as open | Task Board, Branch when pushed, Vercel |
| Overview items | ✅ struck tickets, else the PR snapshot | tickets without ✅, else the snapshot | same as open | commits ahead as `<sha> <subject>`, then `<n> files uncommitted: <top three paths>` |
| Git line | `` `<branch>` → `<base>`, squash <sha>, branch deleted `` (`` branch kept `` for `prototype/*`, or the refusal) | `` `<branch>` → PR #<n> open, <n> ahead of `<base>` `` | `` `<branch>`, PR open, branch kept `` | `` `<branch>` off `<base>`, <n> ahead, <n> files uncommitted `` |
| Builds | ✅ per project | ✅ or ⏳ per project | ❌ on the failed one | `- none yet` |

## Rules

- **Always present**: the H1, the headline, the summary line, Quick Links, Overview, Git, Builds, Next Up with its recommendation and code block. **Present only with content**: Errors, Warnings, the milestone clause, any Quick Link whose URL was not found, the Overview count when no map is open.
- **Overview** always says what was done. Tickets when there are tickets, each with its subtasks as linked lines when it has them or the snapshot under it; the snapshot alone when there are no tickets; the commits and files when there is no PR.
- **Links** are one-word markdown links in parentheses after the thing they open: `(open)`, `(branch)`, `(dev)`. Ticket numbers are the link wherever a ticket is named: `[#30](url) Title`. No bare URLs. Link words and two-word headings are Title Case.
- **Labels**: every ticket reference ends with its labels in inline code. The headline carries the labels of the tickets it covers.
- **Counts** in headings: Overview is open over total among the map's child tickets. Builds is the number of Vercel projects. Errors and Warnings are deduplicated totals across all build logs, at most five bullets shown under each. Next Up is the number listed. Quick Links and Git carry no count.
- **Unread build logs**: one line under Builds saying so, naming the tracking ticket when one exists.
- **Length**: at most 35 lines excluding the code block. Trim the Overview first, then the recommendation.
- **Headings**: the H1 and H3s only; no emoji in headings; status emoji start bullets (✅ ❌ ⚠️ ⏳).
