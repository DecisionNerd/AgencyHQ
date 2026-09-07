// `defineConfig` option names verified against the installed
// `@trigger.dev/sdk@4.5.16` / `@trigger.dev/core@4.5.16` type declarations
// (node_modules/.pnpm/@trigger.dev+core@4.5.16.../v3/config.d.ts) and
// https://trigger.dev/docs/config/config-file, both read 2026-09-07.
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_ME",
  dirs: ["./src/tasks"],
  runtime: "node",
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
    },
  },
  logLevel: "info",
});
