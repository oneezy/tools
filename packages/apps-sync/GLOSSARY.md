# Apps sync

App Sync (also App Updater): one table of the software Justin keeps current on Windows and in Ubuntu WSL, checked and updated only when he asks. Shared words (Tool, Picker, Host, CLI) are in the workspace [`GLOSSARY.md`](../../GLOSSARY.md).

## Language

**App**:
One piece of software App Sync keeps current: a Windows application or a CLI, one row however many Installations it has.
_Avoid_: tool (one of Justin's own programs, see the workspace glossary), package, software

**Installation**:
One copy of an App on one Host (Windows or native Ubuntu), with its own Owner and version. Two Installations may differ in version; that is not a mismatch.
_Avoid_: instance, install

**Owner**:
What put an Installation there and so may change it (WinGet, APT, npm, Vite Plus, the publisher's own updater), with its channel and scope. An unknown or conflicting Owner blocks every change.
_Avoid_: source, manager

**Catalog**:
The reviewed recipes App Sync knows: per App, how to detect each Installation, compare versions and update it. Discoveries join only by explicit review.
_Avoid_: inventory, registry

**Check latest**:
The one action that asks release services what is newest. Launch and refresh never do; an unchecked latest is the normal state.
_Avoid_: scan, refresh

**Freshness**:
What Check latest concluded for an Installation: **Current**, **Newer installed**, **Update available**, or a distinct reason it could not tell. A failed check is never Current.
_Avoid_: status (the task manager's word), up to date

**Plan**:
The exact, confirmed list of what an Update or Install will run for the selected Installations, rechecked right before it runs.
_Avoid_: job, batch

**Update**:
Moving an existing Installation to a newer version. Never installs a missing one.
_Avoid_: upgrade

**Install**:
Adding a missing Installation, only when explicitly selected. Never touches an existing one.

**Report**:
The saved before, target and after evidence of one run, kept even when the run fails or is cancelled.
_Avoid_: log
