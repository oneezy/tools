import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // `vp run test` (and `pnpm test` at the root) builds the workspace @oneezy/skills-sync first: the release chain
      // test runs its CLI and reads its dist. The build is a cached nested run, not a dependsOn: root `vp run -r test`
      // starts a dependsOn build at once, beside @oneezy/skills-sync's own test, whose script builds that dist too. Run
      // here (after that test, in workspace order) it replays the build that test just made. The imported
      // release-record, command-report and land/run dry-run tests (.github/scripts/) run here with the package's own
      // tests. They make temp repositories, so the tests are not cached.
      test: {
        command:
          "vp run --cache @oneezy/skills-sync#build && node --test tests/*.test.mjs scripts/oneezy-capabilities.test.mjs .github/scripts/*.test.mjs",
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
