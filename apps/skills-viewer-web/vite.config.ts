import adapter from "@sveltejs/adapter-vercel";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    sveltekit({
      // Node runtime: the repo tarball is extracted to a temp dir and parsed with node:fs.
      adapter: adapter({ runtime: "nodejs22.x" }),
    }),
  ],
  // ships .svelte files; vitefu misses it under the vite-plus-core alias, so SSR must compile it
  ssr: { noExternal: ["@xyflow/svelte"] },
  test: {
    include: ["src/**/*.test.ts"],
  },
  // `vp run test` / `vp run check` (and `pnpm test` / `pnpm check` at the root) build the
  // skills-viewer engine first: both import its dist.
  run: {
    tasks: {
      test: {
        command: "vp test",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
      check: {
        command: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
        dependsOn: [{ task: "build", from: "dependencies" }],
      },
    },
  },
});
