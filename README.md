# tools

Justin's tools, one pnpm workspace. Windows 11 with PowerShell 7 is the primary host; Linux is a future target.

```
pnpm install   # once, at the root
pnpm build     # Turborepo: every package's build
pnpm test      # every package's tests
pnpm check     # static checks (PowerShell parse, bash -n, py_compile, tsc)
pnpm dev       # the dev servers of the packages that have one
```

| package | language | what it is |
|---|---|---|
| `packages/skills-sync` | TypeScript | `npx @oneezy/skills-sync`: one skills library linked into every harness |
| `packages/skills-viewer` | TypeScript | static map of a skills library (graph.json, graph.mmd, graph.html) |
| `packages/remote-sessions` | Python | Claude session picker, Remote Control launcher, the shared `workspace` worktree command |
| `packages/task-manager` | PowerShell + bash | one GitHub project per repo, and the `status.sh` behind `.github/workflows/task-manager.yml` |
| `packages/apps-sync` | PowerShell + Python | App Updater for Windows applications and Ubuntu CLI tools |

`clis/<old-name>/` keeps compatibility shims: every `.cmd`, `.ps1`, `.sh` and `remote_sessions.py` there delegates to its package, so saved shortcuts and documented paths keep working. See `AGENTS.md` for the conventions.
