---
name: oneezy-app-route
description: Author a new route, feature module or app-only component in apps/app or apps/site, with remote functions as the data layer. Use when Justin or a ticket asks for a new page, screen, form, feature or business-shaped component in the Report Generator or the site.
---

Steps first; the rules stay in their homes. Before step 1 read the app's
`AGENTS.md` (`apps/app/AGENTS.md` holds the layout and data rules;
`apps/site/AGENTS.md` holds only what the site does differently) and the
"Authoring conventions" section of the root `AGENTS.md`. Library components
are authored with `/oneezy-ui-component`, not here; `apps/play` has no rules.
Working reference: `apps/app/src/routes/simple/` (route, `.remote.ts`,
`.types.ts`) and `apps/app/src/lib/components/panel/panel.svelte`.

## Steps

1. **Place it.** A route lives in `src/routes/<group>/<route>/` and starts
   there; code a second route needs moves to `src/lib/<feature>/`. An
   app-only component (business-shaped, so not `@layerd/ui`) is
   `src/lib/components/<name>/<name>.svelte`. Server-only code is
   `src/lib/server/` or, when colocated, `<folder>.<role>.server.ts`.
   Names: one lowercase word, kebab-case when a second word is unavoidable.
2. **Split the route into its files.** `+page.svelte` stays thin: it imports
   the same-folder `<route>.svelte` and renders it, nothing else. The page
   lives in `<route>.svelte`; further colocated components are kebab nouns
   (`photo-grid.svelte`). Support modules are `<folder>.<role>.ts` with the
   roles `remote`, `types`, `utils`, `schema`, `state`, `constants`
   (`state` only as `.svelte.ts` when it uses runes; `schema` holds the
   valibot schemas, `import * as v from 'valibot'` being the one namespace
   import by design).

   ```svelte
   <!-- +page.svelte -->
   <script lang="ts">
   	import Invoices from './invoices.svelte';
   </script>

   <Invoices />
   ```

3. **Guard first.** Every `.remote.ts` is a public endpoint and guards
   itself: a named `guard` function reads `getRequestEvent().locals` and
   calls `error(401)` or `redirect(303, ...)` when the field
   `hooks.server.ts` sets is absent, and every exported remote function
   calls `guard()` before its first `await`. Neither app has a
   `hooks.server.ts` yet, so `App.Locals` is empty; write `guard` now with
   the check as its one line for the auth ticket to fill. A
   `+page.server.ts` guards a page, not data; `load` is for redirects and
   the print-token page only.
4. **Name the data layer by what it does.** `fetchX` for `query`,
   `query.batch` and `query.live`; `getXData` for `prerender` (the site's
   build-time content); `submitX` for `form`. Arguments are validated with
   a schema from `<folder>.schema.ts`. A `.remote.ts` may import
   `$lib/server` and never lives under it.

   ```ts
   // invoices.remote.ts
   import { error } from '@sveltejs/kit';
   import { getRequestEvent, query } from '$app/server';
   import type { InvoiceType } from './invoices.types';

   function guard(): void {
   	const { locals } = getRequestEvent();
   	if (!locals) error(401); // auth ticket: check the session hooks.server.ts sets
   }

   export const fetchInvoices = query(async (): Promise<InvoiceType[]> => {
   	guard();
   	return [];
   });
   ```

   The route component reads it at the top of its script
   (`const invoices = await fetchInvoices();`); async components are on in
   every app.
5. **Type it.** Route-local types live in `<folder>.types.ts` and end in
   `Type` (`InvoiceType`, `InvoiceStatusType`). A component's props are
   `<Name>Props`, extending `ComponentProps` when the component is built on
   `Component`. Values camelCase, constants SCREAMING_SNAKE, booleans
   `is`/`has`/`should`, converters `to*`, factories `create*`.
6. **Import from the barrels.** `@layerd/ui` for library components, the
   bare `$lib` for anything under `src/lib` (the barrel is generated and
   exports remote functions too), a `./` path only for a file in the same
   route folder. Named imports; named `function` declarations for anything
   exported, arrows for callbacks and handlers.
7. **Regenerate the barrel** when a file was added under `src/lib`:
   `pnpm barrels` at the root, twice; the second run leaves `git status`
   unchanged. Never edit `src/lib/index.ts` by hand.
8. **Check and build.** `pnpm --filter <app> check` reports 0 errors and 0
   warnings (`app` or `site`), then `pnpm --filter <app> build` passes.
   Report both commands and their last line.

## Done when

- `+page.svelte` renders a same-folder `<route>.svelte` and holds nothing
  else; support modules carry `<folder>.<role>.ts` names.
- Every `.remote.ts` opens with `guard()` reading `getRequestEvent().locals`
  and every export is a `fetchX`, `getXData` or `submitX`.
- Route-local types end in `Type`; component props are `<Name>Props`.
- Imports are bare `@layerd/ui`, bare `$lib` or same-folder `./`.
- `svelte-check` for the app is 0/0 and its `vite build` passes; a test
  file sits beside new logic once Vitest is in the workspace (it is not,
  as of 2026-09-28; say so).
