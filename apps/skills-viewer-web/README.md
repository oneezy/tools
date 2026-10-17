# skills-viewer-web

Paste `owner/repo` or a GitHub URL, get the map of that repo's agent skills. In local development, the **Local / Web** switch also maps `packages/skills` and refreshes on saves. Only authored source and restored dependencies are read; generated plugin copies are excluded. The fixed local endpoint exists only in the Vite development server, not the deployed website. The website half of the skills viewer ([#86](https://github.com/oneezy/tools/issues/86), map [#54](https://github.com/oneezy/tools/issues/54)); the parsing is the `skills-viewer` package (v0.2, [#88](https://github.com/oneezy/tools/pull/88)). Root `pnpm dev` builds its prerequisites automatically and starts the skill watcher too. `test` and `check` are Vite Plus tasks in `vite.config.ts` that build the engine first.

```
pnpm install          # once, at the workspace root
pnpm dev              # here: viewer only; root: prepare + viewer + skills watcher
vp run test           # here (pnpm test at the root): builds the engine, then vp test
vp run check          # here (pnpm check at the root): builds the engine, then svelte-check
pnpm build            # vp build → .vercel/output
```

## How it works

Local library membership comes from `packages/skills/skills-sync.json` and its lockfile, including dependency renames. Authored folders such as `skills/dev` appear as their own groups even before they have a plugin definition. Global harness installations are not scanned. Local and Web use the same library labels and colors while showing their own source versions.

**Filters** offers library checkboxes, Show all / Hide all, and **Links between libraries** (off by default). Hidden libraries are removed from the map, search, and connecting lines. Cross-library relations remain available in skill details when both libraries are visible. Preferences are saved in browser local storage separately for Local and each GitHub repository/subfolder; they do not change installed skills. Newly discovered libraries start visible.

1. **Input**: `owner/repo`, `owner/repo@ref`, any github.com URL (`.git`, `git@github.com:`, `/tree/<ref>/<folder>`, `/blob/<ref>/<file>`), parsed by the engine's `parseRepoInput`. The page keeps it in `?repo=`, so a map is a shareable link.
2. **Fetch and parse** (`src/lib/server/analyze.ts`): `loadGitHub(repo, { via: "tarball" })` from `skills-viewer`: one GitHub REST call, unpacked in memory, mapped by the engine (skills, plugins, parts, links, flows; duplicate skill copies merged). It runs in a server function because a browser can't read the tarball redirect; the engine's `via: "tree"` mode is the browser-safe alternative if parsing ever moves client-side.
3. **Serve**: `GET /api/graph?repo=…` → `{ graph }`, where `graph.meta.source` says where it came from. The CDN caches each repo and ref for an hour (`s-maxage=3600`), so repeat visits cost no GitHub requests.
4. **Draw** (`src/lib/map/`): `toMapData` turns the graph into cards, groups (plugin, else the folder holding the skills) and prefix families; `layouts.ts` places them with ELK (in a lazily loaded web worker) or d3-force; `Canvas.svelte` is the board on `@xyflow/svelte`. Layouts: Libraries, Flow, Force, switchable and remembered per browser. Wheel pans, Ctrl+wheel / Ctrl +/- / pinch zooms, Shift+1 fits, `/` searches, tap a card for its links with the SKILL.md line behind each one.

## Focused workflows

Select a skill and choose **Open workflow**. This view follows that skill across library boundaries, independently of the Libraries visibility filters. Cards keep library names and colors. Select a card to inspect the evidence and expand or collapse its document; select an arrow for its source line. Files can be hidden, and unreferenced files are available from the owning skill's details without being represented as executed steps.

Solid arrows show detected instruction structure; dashed arrows show relationships without asserting execution order. Repeated calls have separate occurrences. Recursive references point back to the ancestor. Explicit parallel task lists fan out; they join only when the source explicitly waits for all. Repetition uses a return arrow. The view caps expansion at 250 nodes and reports that limit.

The engine uses static rules only. Folder names do not assign roles or execution semantics. The same workflow data powers Local and Web. Local saves replace the in-memory graph only after its content fingerprint changes; no graph file or plugin build is needed. The current parser supports Markdown action lists and numbered action sections, explicit references, and bounded branching cues, not arbitrary natural-language control flow. Source evidence remains visible so detected structure can be checked.

## Rate limit

Unauthenticated, GitHub allows 60 tarball requests an hour per server IP. Set `GITHUB_TOKEN` (any token; no scopes needed for public repos) in the Vercel project's environment variables to get 5,000. Declared in `src/env.ts`.

## Deploy (Vercel)

One Vercel project, linked to `oneezy/tools`, **Root Directory `apps/skills-viewer-web`**. `vercel.json` sets the rest: SvelteKit preset, pnpm through corepack (the root `packageManager` pins pnpm 12), a build of this app and its workspace dependencies (`pnpm --filter "skills-viewer-web..." run build`, so the engine's `dist` exists), and an `ignoreCommand` (`scripts/vercel-ignore.sh`: a `git diff` over this app, the engine and the workspace files) so pushes that don't touch them skip the deploy. Every PR gets a preview URL.

## SvelteKit 3 notes

- Kit options live in `vite.config.ts` (`sveltekit({ adapter })`); there is no `svelte.config.js`.
- `#lib/…` (package.json `imports`) replaces `$lib`; environment variables come from `$app/env/private` and are declared in `src/env.ts`.
