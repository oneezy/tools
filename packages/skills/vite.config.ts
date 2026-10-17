import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
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
