import { defineConfig } from "vite-plus";

// `vp test run` (the package's `test` script, after `tsc` builds dist/): tests import the TypeScript
// sources and spawn the built CLI. Many start git and the CLI several times, so they get a long timeout.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
