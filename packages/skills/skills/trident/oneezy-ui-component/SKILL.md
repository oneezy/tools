---
name: oneezy-ui-component
description: Author a new @layerd/ui component in packages/ui, from the folder to the generated barrel export. Use when Justin or a ticket asks for a new library component (atom, molecule, organism, template, page) or for moving a component into the library.
---

Steps first; the rules behind them stay in their homes and are not repeated
here. Before step 1 read `packages/ui/AGENTS.md` (conventions) and skim
`packages/ui/CONTEXT.md` (vocabulary: tiers under "Organization", rails,
base props). The model to copy is
`packages/ui/src/lib/components/atoms/example/example.svelte`; the base
component's API is `packages/ui/src/lib/base/component.svelte.ts`
(`ComponentProps`) and `component.svelte` (the default renderer).

## Steps

1. **Place it.** Pick the tier by what the component is made of
   (CONTEXT "Organization"). Folder and file share one lowercase word,
   kebab-case only when a second word is unavoidable:
   `packages/ui/src/lib/components/<tier>/<name>/<name>.svelte`. Add
   `<name>.svelte.ts` only when the component owns rune state outside its
   markup (a class with `$state` fields); rune-free helpers are plain `.ts`.
   The barrel derives `<Name>` from the file name, so the name is the export.
2. **Open with the story tags and the props type.** The JSDoc block is
   read by the stories generator (`@tags`, and the optional `@story`,
   `@props`, `@ignore`, `@enable`, `@type`, `@layout`, `@dev`; contract at
   the top of `packages/tools/src/generators/stories.ts`). Import from the
   bare `@layerd/ui` only, inside the package too. Declare and export
   `<Name>Props extends ComponentProps` (an `Omit<ComponentProps, 'x'>` when
   one base prop must be redefined); own props are one lowercase word,
   camelCase as the fallback. Destructure with `...props` last:

   ```svelte
   <script lang="ts">
   	/**
   	 * @tags ui, <topic>
   	 */
   	import { Component, type ComponentProps } from '@layerd/ui';

   	export interface BadgeProps extends ComponentProps {
   		count?: number;
   	}

   	let { count = 0, children = undefined, ...props }: BadgeProps = $props();
   </script>
   ```

3. **Render on the base component with the default renderer** (ADR 0001,
   `packages/ui/docs/adr/0001-*.md`). Spread `{...props}` onto `<Component>`,
   set `tag` when the element is not a `div`, and put content or layout
   snippets (`left`, `center`, `right`, cells, `bg`/`full`/`fg`) inside:

   ```svelte
   <Component {...props} tag="span" class="badge {(props.class ?? '').trim()}">
   	{#snippet center()}
   		{#if children}{@render children()}{:else}{count}{/if}
   	{/snippet}
   </Component>
   ```

   A root override (`{#snippet component({ props, content })}`) is written
   only when the markup needs several elements or a native element with
   structured children (`details`, `select`, `img`, `iframe`), and then it
   renders the `layout` argument too. Colour, appearance and size come from
   the base props the consumer sets; the component never restyles its own
   layout through them.
4. **Style in the markup.** Tailwind utilities in `class=`; the theme is
   worn through base props, so palette utilities (`bg-primary-500`,
   `text-red-500`) stay out, white and black allowed. Raw CSS goes in
   `<style lang="postcss">` opened with `@reference "#ui.css";`. The
   element carrying `class="<name>"` is rendered by the base component,
   outside this file's CSS scope, so a rule that targets it is written
   `:global(.<name>)`; a scoped `.<name>` is reported unused and dropped.
5. **Rails and icons in canonical form.** Rails by their canonical names
   (`content`, `xs`, `sm`, `lg`, `xl`, `xxl`, `full`, `gutter-*`, `left`,
   `right`; CONTEXT "Rails"); icons through `icon="home"` or
   `icon="mdi--home"`. The aliases and the Icon `name` prop stay for old
   code only.
6. **Leave breakpoints to the consumer** (ADR 0002): the component reads
   no viewport and no `mq`; a consumer that needs two layouts branches on
   `mq` around it.
7. **Generate the barrel.** From the repo root run `pnpm barrels` twice.
   The first run adds `<Name>` and `<Name>Props` to
   `packages/ui/src/lib/components/index.ts` and the root barrel; the
   second run leaves `git status` unchanged. Barrels are never edited by
   hand; a hand edit is overwritten.
8. **Test beside it** as `<name>.test.ts`, written with `/tdd`. As of
   2026-09-28 no package in the workspace has Vitest (`vp` has not landed),
   so the test file waits; the report says so in one line.
9. **Check.** `pnpm --filter @layerd/ui check` reports 0 errors and 0
   warnings.

## Done when

- The folder holds `<name>.svelte` and, only for rune state, `<name>.svelte.ts`.
- `<Name>Props` is exported and the barrels carry it after `pnpm barrels`,
  with a zero diff on the second run.
- The component renders through the default renderer, or its override
  renders `layout` and the report names the element that required it.
- `svelte-check` in `packages/ui` is 0/0.
- `<name>.test.ts` exists, or the report states that Vitest is not yet in
  the workspace.
