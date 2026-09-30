# skills-sync

One skills repo. Every harness. Every project on this host.

Double-click `skills-sync.cmd`, or run `python skills_sync.py` (Python 3.10+, stdlib only, works in WSL). It is idempotent: run it after you edit a skill, install one, or pull.

## What it does

The skills repo (`oneezy/skills`, checkout `V:\dev\skills`) has three folders:

| folder | holds | who writes it |
|---|---|---|
| `skills/<name>/` | Justin's own skills, bare Agent Skills form | Justin, by hand |
| `.agents/skills/<name>/` | the working set: third-party copies from `npx skills add <owner>/<repo>` plus one link per own skill | `npx skills` and this tool |
| `.claude/skills/<name>/` | one link per working-set entry, for Claude Code; not committed | this tool |

Then the two folders every harness reads on this host get one link per skill, pointing at the real folder in the repo:

- `~/.claude/skills/<name>` for Claude Code
- `~/.agents/skills/<name>` for Codex

So a skill edited in `V:\dev\skills` is live in every project at once, and `git push` from the skills repo is how it reaches another host (clone there, run the tool once).

## Commands

```
skills-sync                 layers + user (default)
skills-sync layers          rebuild the two layers in the skills repo
skills-sync user            refresh the links in ~/.claude/skills and ~/.agents/skills
skills-sync projects        picker of git repos under V:\dev; copies skills into the ones you check
skills-sync unlink          remove every link this tool made in the user folders
skills-sync status          counts: own, third-party, linked, missing
```

Options: `--plan` (show, touch nothing), `--json`, `--repo PATH`, `--home PATH`, `--dev PATH`, `--projects app,site` (skip the picker), `--skills a,b` (subset for projects), `--copy` (user step copies instead of linking).

The picker uses the same keys as every tool here: up/down move, space check, a all/none, enter run, q quit.

## Rules it never breaks

- It only ever creates, retargets or removes links whose target is inside the skills repo. A real folder in the way is reported as a conflict and left alone. `synced/` and `.system/` are never touched.
- Third-party copies in `.agents/skills` are never modified; `npx skills update` owns them.
- `projects` writes real copies (a link would not survive a commit), and only into the repos you pick. Use it for a repo that must carry its own skills: cloud sessions and other people only see what is committed.

## Installing skills

- Someone else's: `cd V:\dev\skills && npx skills add <owner>/<repo>`, then `skills-sync`.
- Your own: create `V:\dev\skills\skills\<name>\SKILL.md`, then `skills-sync`. Keep the frontmatter valid YAML (quote a description that contains a colon), or `npx skills` will skip it for other people.
- Others install yours with `npx skills add oneezy/skills`.

## Tests

```
python -m unittest discover -s clis/skills-sync-cli/tests -v
```
