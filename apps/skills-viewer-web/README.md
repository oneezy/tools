# skills-viewer-web

Paste `owner/repo` or a GitHub URL, get the map of that repo's agent skills. The website half of the skills viewer ([#86](https://github.com/oneezy/tools/issues/86), map [#54](https://github.com/oneezy/tools/issues/54)); the parsing is the `skills-viewer` package (v0.2, [#88](https://github.com/oneezy/tools/pull/88)); build it once (`pnpm build` at the root) before `pnpm dev` here.

```
pnpm install          # once, at the workspace root
pnpm dev              # here: vp dev, http://localhost:5173
pnpm test             # vp test: input round trip, map data
pnpm check            # svelte-check
pnpm build            # vp build → .vercel/output
```

## How it works

1. **Input**: `owner/repo`, `owner/repo@ref`, any github.com URL (`.git`, `git@github.com:`, `/tree/<ref>/<folder>`, `/blob/<ref>/<file>`), parsed by the engine's `parseRepoInput`. The page keeps it in `?repo=`, so a map is a shareable link.
2. **Fetch and parse** (`src/lib/server/analyze.ts`): `loadGitHub(repo, { via: "tarball" })` from `skills-viewer`: one GitHub REST call, unpacked in memory, mapped by the engine (skills, plugins, parts, links, flows; duplicate skill copies merged). It runs in a server function because a browser can't read the tarball redirect; the engine's `via: "tree"` mode is the browser-safe alternative if parsing ever moves client-side.
3. **Serve**: `GET /api/graph?repo=…` → `{ graph }`, where `graph.meta.source` says where it came from. The CDN caches each repo and ref for an hour (`s-maxage=3600`), so repeat visits cost no GitHub requests.
4. **Draw** (`src/lib/map/`): `toMapData` turns the graph into cards, groups (plugin, else the folder holding the skills) and prefix families; `layouts.ts` places them with ELK (in a lazily loaded web worker) or d3-force; `Canvas.svelte` is the board on `@xyflow/svelte`. Layouts: Libraries, Flow, Force, switchable and remembered per browser. Wheel pans, Ctrl+wheel / Ctrl +/- / pinch zooms, Shift+1 fits, `/` searches, tap a card for its links with the SKILL.md line behind each one.

## Rate limit

Unauthenticated, GitHub allows 60 tarball requests an hour per server IP. Set `GITHUB_TOKEN` (any token; no scopes needed for public repos) in the Vercel project's environment variables to get 5,000. Declared in `src/env.ts`.

## Deploy (Vercel)

One Vercel project, linked to `oneezy/tools`, **Root Directory `apps/skills-viewer-web`**. `vercel.json` sets the rest: SvelteKit preset, pnpm through corepack (the root `packageManager` pins pnpm 12), a build of this app and its workspace dependencies (`pnpm --filter "skills-viewer-web..." run build`, so the engine's `dist` exists), and `turbo-ignore` so pushes that don't touch this app or its dependencies skip the deploy. Every PR gets a preview URL.

## SvelteKit 3 notes

- Kit options live in `vite.config.ts` (`sveltekit({ adapter })`); there is no `svelte.config.js`.
- `#lib/…` (package.json `imports`) replaces `$lib`; environment variables come from `$app/env/private` and are declared in `src/env.ts`.
