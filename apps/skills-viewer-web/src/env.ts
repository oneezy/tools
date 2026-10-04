import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({
  GITHUB_TOKEN: {
    description:
      "Optional GitHub token (no scopes needed for public repos). Lifts the tarball API from 60 to 5,000 requests an hour.",
    schema: (value) => value || undefined,
  },
});
