# Context

Glossary for the `tools` repo. Terms only; no implementation detail.

## Tool

A program in `clis/` that Justin runs by double-clicking its `.cmd` file. It opens a terminal **picker**: an arrow-key list where space checks rows, enter acts on the checked rows, and q quits. The folder name keeps the historical `-cli` suffix, but a tool is not a CLI in the sense below.

## CLI

A command-line program driven by arguments, such as `claude`, `codex`, `gh`, `wsl`. Tools call CLIs; tools are not themselves CLIs.

## Harness

An AI agent runtime with its own config folder and its own expected skill layout. In scope: Claude Code and Codex. Out of scope for now: Hermes, Goose.

## Surface

A way of reaching a harness: terminal, desktop app, VS Code extension, phone app, web or cloud. One harness has many surfaces, and they read the same harness config, so syncing a harness syncs all of its surfaces. Justin calls the set of surfaces that must stay in step the **sync layer**.

## Host

A machine or container where a harness is installed: this Windows PC, the Ubuntu WSL distro, a remote machine over SSH, a cloud sandbox. Skills are synced per harness per host.

## Picker

The default user interface of a tool. One screen, sections of rows, the same key bindings in every tool: up/down move, space toggle, a all/none, enter act, x stop or remove, r refresh, q quit.
