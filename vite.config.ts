import { defineConfig } from "vite-plus";

// Workspace root. `pnpm build|test|check` run every package's script of that name through
// Vite Task (`vp run -r`), in dependency order. `pnpm dev` (`vp dev`) serves the one app with
// a dev server.
export default defineConfig({
  defaultPackage: { dev: "./apps/skills-viewer-web", preview: "./apps/skills-viewer-web" },
});
