# Tools workspace

The words every package in `oneezy/tools` shares: what Justin runs, what it runs against, and where. Each package's own words are in its `GLOSSARY.md`, listed in [`GLOSSARY-MAP.md`](./GLOSSARY-MAP.md).

## Language

**Tool**:
A program in this workspace that Justin runs by double-clicking its `.cmd` file, which opens a **Picker**. A Tool is not a CLI.
_Avoid_: app, script, CLI

**CLI**:
A command-line program driven by arguments, such as `claude`, `codex`, `gh`, `wsl`. Tools call CLIs.
_Avoid_: tool

**Picker**:
The one-screen terminal interface every Tool opens: sections of rows, the same keys everywhere (up/down move, space toggle, a all/none, enter act, x stop or remove, r refresh, q quit).
_Avoid_: menu, TUI

**Harness**:
An AI agent runtime with its own config folder and its own expected skill layout. In scope: Claude Code and Codex; out of scope for now: Hermes, Goose.
_Avoid_: agent, client

**Surface**:
A way of reaching a Harness: terminal, desktop app, VS Code extension, phone app, web or cloud. Surfaces of one Harness read the same config, so syncing a Harness syncs all of them; the set that must stay in step is the **sync layer**.
_Avoid_: client, frontend

**Host**:
A machine or container where a Harness is installed: this Windows PC, the Ubuntu WSL distro, a remote machine over SSH, a cloud sandbox. Skills are synced per Harness per Host.
_Avoid_: machine, environment
