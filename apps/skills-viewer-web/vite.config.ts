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
  test: {
    include: ["src/**/*.test.ts"],
  },
});
