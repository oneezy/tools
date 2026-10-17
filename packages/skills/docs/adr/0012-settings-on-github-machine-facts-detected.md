# ADR-0012: Settings live in the config on GitHub; machine facts are detected on every run

Date: 2026-10-11. Status: accepted. Supersedes the local file `skills-sync.local.json` (ADR-0001's amendment). Decided in the Skills Sync repair grilling of 2026-10-10 (Q14, Q14b, Q14c).

## Context

The local file lived inside the library clone, so it vanished or changed whenever `~/.skills-sync` was re-pointed, and each machine's answers drifted apart. Justin wants one settings file he can edit anywhere that changes every machine.

## Decision

- Shared settings (which sources and plugins, which harnesses to serve) live in the config, `skills-sync.json` in oneezy/skills, edited on GitHub like any other change.
- Machine facts (which harnesses are installed and where, WSL distros) are detected on every run, and anything remembered is checked to still exist. New harnesses are found by scanning, not by asking.
- There is no local file. A machine answer that cannot be detected becomes a config setting.
