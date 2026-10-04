# skills-viewer-web

Paste `owner/repo` or a GitHub URL, get the map of that repo's agent skills. The website half of the skills viewer ([#86](https://github.com/oneezy/tools/issues/86), map [#54](https://github.com/oneezy/tools/issues/54)); the parsing is the `skills-viewer` package.

```
pnpm install          # once, at the workspace root
pnpm dev              # here: vp dev, http://localhost:5173
pnpm test             # vp test: input parsing
pnpm check            # svelte-check
pnpm build            # vp build → .vercel/output
```

## How it works

1. **Input** (`src/lib/repo.ts`): `owner/repo`, `github.com/o/r(.git)`, `git@github.com:o/r`, `/tree/<ref>/<folder>` and `/blob/<ref>/<file>` (scans the file's folder). The page keeps it in `?repo=`, so a map is a shareable link.
2. **Fetch** (`src/lib/server/analyze.ts`): one GitHub REST call, `repos/o/r/tarball/<ref>`, from a server function. A browser can't read that redirect (codeload allows no other origins). The tarball streams into a temp dir: regular files only (no symlinks), files over 2 MB skipped, repos over 100 MB refused.
3. **Parse**: `buildGraph` from `packages/skills-viewer`, imported from its TypeScript source, so the engine needs no build step here. Paths in the result are made repo-relative.
4. **Serve**: `GET /api/graph?repo=…` → `{ source, graph }`. The CDN caches each repo and ref for an hour (`s-maxage=3600`), so repeat visits cost no GitHub requests.

## Rate limit

Unauthenticated, GitHub allows 60 tarball requests an hour per server IP. Set `GITHUB_TOKEN` (any token; no scopes needed for public repos) in the Vercel project's environment variables to get 5,000. Declared in `src/env.ts`.

## Deploy (Vercel)

One Vercel project, linked to `oneezy/tools`, **Root Directory `apps/skills-viewer-web`**. `vercel.json` sets the rest: SvelteKit preset, pnpm through corepack (the root `packageManager` pins pnpm 12), `vp build`, and `turbo-ignore` so pushes that don't touch this app or its dependencies skip the deploy. Every PR gets a preview URL.

## SvelteKit 3 notes

- Kit options live in `vite.config.ts` (`sveltekit({ adapter })`); there is no `svelte.config.js`.
- `#lib/…` (package.json `imports`) replaces `$lib`; environment variables come from `$app/env/private` and are declared in `src/env.ts`.
