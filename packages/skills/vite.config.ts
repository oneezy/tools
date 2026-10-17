import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // `vp run test` (and `pnpm test` at the root) builds the workspace @oneezy/skills-sync first: the release chain
      // test runs its CLI and reads its dist. The imported release-record, command-report and land/run dry-run tests
      // (.github/scripts/) run here with the package's own tests. They make temp repositories, so nothing is cached.
      test: {
        command: "node --test tests/*.test.mjs scripts/oneezy-capabilities.test.mjs .github/scripts/*.test.mjs",
        dependsOn: [{ task: "build", from: "devDependencies" }],
        cache: false,
      },
      "package-plugins": {
        command: "skills-sync build --repo . --plugins --catalogs",
        cache: {
          input: [{ auto: true }, "!plugins/**", "!dist/**", "!.claude-plugin/**", "!.agents/plugins/**"],
          output: ["plugins/**", "dist/hermes/**", ".claude-plugin/**", ".agents/plugins/**"],
        },
      },
    },
  },
});
