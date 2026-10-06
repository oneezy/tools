# tools

Justin's tools, one pnpm workspace on Vite Plus. Windows 11 with PowerShell 7 is the primary host; Linux is a future target. Install Vite Plus once per machine (https://viteplus.dev/guide/); it brings the Node (`.node-version`) and pnpm (`packageManager`) this repo pins.

```
pnpm install   # once, at the root
pnpm build     # Vite Plus (vp run -r): every package's build, in dependency order
pnpm test      # every package's tests
pnpm check     # static checks (PowerShell parse, bash -n, py_compile, tsc)
pnpm dev       # vp dev: the skills viewer website
```

| package | language | what it is |
|---|---|---|
| `packages/skills-sync` | TypeScript | `npx @oneezy/skills-sync`: one skills library linked into every harness |
| `packages/skills-viewer` | TypeScript | static map of a skills library (graph.json, graph.mmd, graph.html) |
| `packages/remote-sessions` | Python | Claude session picker, Remote Control launcher, the shared `workspace` worktree command |
| `packages/task-manager` | PowerShell + bash | one GitHub project per repo, and the `status.sh` behind `.github/workflows/task-manager.yml` |
| `packages/apps-sync` | PowerShell + Python | App Updater for Windows applications and Ubuntu CLI tools |
| `apps/skills-viewer-web` | SvelteKit (Vite+) | paste a GitHub repo, see its skills map; deployed to Vercel |

Every tool is run from its package folder; the old `clis/` shims are gone. See `AGENTS.md` for the conventions.
