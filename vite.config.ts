import { defineConfig } from "vite-plus";

// Workspace root. `pnpm build|test|check` run every package's script of that name through
// Vite Task (`vp run -r`), in dependency order; `pnpm check` runs `vp check` here first.
// `pnpm dev` (`vp dev`) serves the one app with a dev server.
//
// `vp check` = Oxfmt + Oxlint + type checks for the JS/TS in every package. Markdown, copied
// fixtures, generated examples and the skills-viewer page templates are left as written.
const untouched = [
  "**/dist/**",
  "**/.svelte-kit/**",
  "**/.vercel/**",
  "**/*.md",
  "docs/research/**",
  "packages/skills-viewer/fixtures/**",
  "packages/skills-viewer/examples/**",
  "packages/skills-viewer/templates/**",
  "packages/skills-sync/test/fixtures/**",
  "pnpm-lock.yaml",
  // workflow files change only through a person's merge (automerge skips .github/); caller.yml is their template
  ".github/**",
  "packages/task-manager/caller.yml",
  // SvelteKit's page shell, %sveltekit.*% placeholders and all
  "apps/skills-viewer-web/src/app.html",
];

export default defineConfig({
  defaultPackage: { dev: "./apps/skills-viewer-web", preview: "./apps/skills-viewer-web" },
  fmt: {
    printWidth: 120,
    ignorePatterns: untouched,
  },
  lint: {
    ignorePatterns: untouched,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
