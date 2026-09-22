@echo off
rem Double-click: one picker for every remote session on this PC. Claude Code servers per folder (worktree mode),
rem other bridged Claude sessions, and the Codex machine-wide daemon. Arrows move, space checks, enter starts, x stops.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0remote-control.ps1"
