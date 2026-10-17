# ADR-0004: A project selects Plugins by their exact Library id, and setup never takes the whole Library

Date: 2026-10-17. Status: accepted. Recorded by oneezy/tools#211.

## Context

The spec says the project's own Plugins determine its selection, so that setup never activates the whole Library (spec #209, story 6; ADR-0020). Which Plugins a project has installed is Harness state, and reading it is a Harness adapter's job (#213, #214), and no adapter is verified yet. Name conflicts in Claude Code and Codex compare the Plugin's exact name, never its display name.

## Decision

- **The selection is the list named on `develop setup <plugin>...`**, recorded in the project record. `develop setup` with no names reuses the recorded list. With no names and no record, setup refuses and lists the Library's Plugins. Naming a list replaces the recorded one.
- **Each name must equal one Library Plugin id exactly.** Setup refuses three kinds of name and changes nothing:
  - a Harness-qualified id (`play@oneezy-skills`): the origin is the adapter's concern
  - a name that matches an id only when case is ignored, or matches a display name: the identity is ambiguous
  - a name the Library does not have
- **One project has one Library.** Setup with another Library is refused until `develop remove`.
- **Adapters replace only the selected Plugins.** Later, an adapter may propose the selection from what its Harness has installed for the project. The recorded, exact list stays what setup acts on.

## Considered options

- **Every Plugin in the Library by default**: forbidden by the spec.
- **Detect the selection from the Harnesses now**: no adapter is verified, and a guess from cache folders would be the approximate matching the spec rules out.
