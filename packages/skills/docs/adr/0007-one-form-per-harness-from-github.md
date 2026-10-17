# ADR-0007: One form per harness, installed from GitHub or the account, with no library on the machine

Date: 2026-10-11. Status: accepted. Amends ADR-0003 ("both forms stay") for machines; the library still builds both forms. Decided in Justin's Skills Sync repair grilling of 2026-10-10 (Q1, Q3, Q6, Q10, Q13, Q17).

## Context

Machines carried a library clone at `~/.skills-sync` that skills-sync re-pointed at whatever checkout last ran it (a detached, shallow Codex test clone on the PC), plus loose links into it and into `V:\dev\skills`, CLI-installed plugins, and real folders in `~/.codex/skills`. Cloud threads got the claude.ai account plugins and 101 loose links from the setup script, so every skill was listed twice and bare `/name` broke. There were three places to edit and no telling which one a harness was reading.

## Decision

- GitHub `oneezy/skills` is the one place skills are edited (dev, then main). Every installed copy is a harness cache the tool replaces; nothing on a machine is edited by hand.
- Each harness gets exactly one form. The plugin form wherever the harness has a plugin route; the loose-skill form only where it has none. Never both, so no skill name is listed twice.
  - Claude Code (PC and cloud): the plugins enabled on Justin's claude.ai account, delivered as `<id>@synced`. The tool stops installing its own Claude Code plugins, because a CLI-installed plugin of the same name hides the account one.
  - Codex: plugins from the GitHub marketplace `oneezy/skills`.
  - Hermes: plugins, once a probe confirms its format; until then it keeps the loose form.
  - Goose and per-project links are dropped until a harness needs them.
- No library folder on any machine. `~/.skills-sync` stops being a library clone; the tool downloads what it needs from GitHub, and nothing on a machine is a second copy to edit.
- Harness defaults are never touched: built-in skills (`~/.codex/skills/.system`), plugins and hook entries the tool did not write stay as they are.

## Consequences

- diagram-design, frontend-design and play must be switched on at claude.ai (UI only); until they are, Claude Code lacks them. A probe tests whether Hermes can do that by computer use.
- Non-library skills found in `~/.codex/skills` are shown one by one at cleanup for adopt (into the library) or delete.
- Probes before building: Codex plugins duplicating ChatGPT account plugins, the Claude desktop app receiving `@synced` plugins, Hermes plugin format.
