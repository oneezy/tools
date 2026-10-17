import adapter from "@sveltejs/adapter-vercel";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { localSkills } from "./dev/local-skills.ts";

export default defineConfig(({ command }) => ({
  resolve: {
    alias:
      command === "serve"
        ? [
            {
              find: /^skills-viewer\/node$/,
              replacement: fileURLToPath(new URL("../../packages/skills-viewer/src/node.ts", import.meta.url)),
            },
            {
              find: /^skills-viewer$/,
              replacement: fileURLToPath(new URL("../../packages/skills-viewer/src/index.ts", import.meta.url)),
            },
          ]
        : [],
  },
  plugins: [
    localSkills(),
    sveltekit({
      // Node runtime: the repo tarball is extracted to a temp dir and parsed with node:fs.
      adapter: adapter({ runtime: "nodejs22.x" }),
    }),
  ],
  // ships .svelte files; vitefu misses it under the vite-plus-core alias, so SSR must compile it
  ssr: { noExternal: ["@xyflow/svelte"] },
  server: { watch: { ignored: ["**/.vercel/**"] } },
  test: {
    include: ["src/**/*.test.ts", "dev/**/*.test.ts"],
  },
  // `vp run test` / `vp run check` (and `pnpm test` / `pnpm check` at the root) build the
  // skills-viewer engine first: both import its dist.
  run: {
    tasks: {
      bundle: {
        command: "vp build",
        dependsOn: [{ task: "build", from: "dependencies" }],
        cache: {
          input: [{ auto: true }, "!.svelte-kit/**", "!.vercel/**"],
          output: [".svelte-kit/output/**", ".vercel/output/**"],
        },
      },
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
}));
