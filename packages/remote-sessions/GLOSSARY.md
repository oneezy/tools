# Remote sessions

Claude sessions that keep running in the background on a Host, reachable from the phone through Remote Control, and the named folders Claude and Codex share for one piece of work. Shared words (Tool, Picker, Harness, Host) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md); Ticket is the [task manager's](../task-manager/GLOSSARY.md).

## Language

**Thread**:
Justin's word for one Claude conversation running as a background session, reachable through Remote Control.
_Avoid_: session (the Harness's word), chat, agent

**Task**:
A named piece of work the launcher keeps one Thread and one Worktree for; starting the same name again reuses both.
_Avoid_: job, ticket (a Task may serve one)

**Managed**:
A Thread this launcher started and may stop. A Thread started anywhere else is never stopped here.
_Avoid_: owned, tracked

**History**:
Saved conversations that cannot be resumed as they are; hidden in the Picker until asked for, and resumed only by an explicit recovery.
_Avoid_: archive

**Recovery**:
Starting a replacement conversation for a Task whose folder or Thread is gone, keeping the old history and branch.
_Avoid_: restore, reset

**Worktree**:
The persistent folder one Task works in, under `<repo>/.claude/worktrees/<name>`, named `<repo>-issue-<n>-<slug>`, `<repo>-pr-<n>-<slug>` or `<repo>-<slug>`. Claude and Codex share it.
_Avoid_: workspace (the command that prepares it), checkout, clone

**Project root**:
The folder whose repos the launcher manages on a Host: `V:\dev` on Windows, `~/dev` elsewhere.
_Avoid_: dev folder, workspace
