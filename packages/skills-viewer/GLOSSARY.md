# Skills viewer

A map of an agent skills library or plugin: where to start, what each skill does, what it calls. This package is the engine; `apps/skills-viewer-web` is the website that draws it. Shared words (Harness) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md); a library's own words (Plugin, Catalog) are in [skills-sync's](../skills-sync/GLOSSARY.md).

## Language

### The map

**Skill map**:
Everything the engine found in one library or plugin: skills, Parts, Edges, Flows. One per analysis, from a local folder or a GitHub repo.
_Avoid_: graph (the file format), diagram

**Mode**:
How a skill can be triggered: **auto** (the agent picks it, and it can be slashed), **manual-only** (only a slash or mention runs it), **model-only** (hidden from the slash menu).
_Avoid_: invocation type, visibility

**Entry point**:
A manual-only skill that nothing calls or suggests: where a person starts.
_Avoid_: root, command

**Sub-skill**:
A skill that is not manual-only and that something calls.
_Avoid_: child, helper

**Edge**:
A relationship one skill's body states about another, with the line that says it: **calls**, **suggests**, **needs first**, **reference**.
_Avoid_: link (a relation with a Part), dependency

**Part**:
Anything in a library besides a skill: a plugin's command, agent, hook or MCP server, or a skill's script, reference or asset.
_Avoid_: file, resource

**Flow**:
An ordered, parallel or looping run of skills that one skill or command describes.
_Avoid_: pipeline, workflow

**Unresolved**:
A name a skill mentions that the library does not contain.
_Avoid_: missing, broken

### The website

**Card**:
One skill drawn on the canvas.
_Avoid_: node (the engine's word), tile

**Family**:
Four or more skills in one group sharing a name prefix, boxed together.
_Avoid_: cluster, prefix group

**Layout**:
One way of placing the Cards: **Libraries**, **Flow** or **Force**.
_Avoid_: view, mode (taken)
