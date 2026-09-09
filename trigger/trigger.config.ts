// `defineConfig` option names verified against the installed
// `@trigger.dev/sdk@4.5.16` / `@trigger.dev/core@4.5.16` type declarations
// (node_modules/.pnpm/@trigger.dev+core@4.5.16.../v3/config.d.ts) and
// https://trigger.dev/docs/config/config-file, both read 2026-09-07.
//
// Build extensions — only affect `trigger deploy` (container profile builds),
// not `trigger dev`. Verified from:
//   - `@trigger.dev/build@4.5.16` .d.ts (additionalPackages JSDoc: "when
//     deploying"; aptGet is a BuildExtension, invoked by the deploy bundler)
//   - https://trigger.dev/docs/config/extensions/aptGet (read 2026-09-08)
// Resolution verified: `node -e "import('@trigger.dev/build/extensions/core')
//   .then(m=>console.log(Object.keys(m)))"` from trigger/ exits 0 (2026-09-08).
// Option names `packages` verified from the installed .d.ts (AptGetOptions and
// AdditionalPackagesOptions both declare `packages: string[]`).
import { additionalPackages, aptGet } from "@trigger.dev/build/extensions/core";
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
  build: {
    // Deploy-time build extensions (container profile only; no effect on `trigger dev`).
    // See https://trigger.dev/docs/config/extensions/aptGet (read 2026-09-08).
    extensions: [
      // Install git so task code can shell out to `git` inside the container.
      aptGet({ packages: ["git"] }),
      // Install opencode-ai so `worker.attempt` can call the opencode CLI.
      // Pin matches the host OpenCode version qualified by the Slice 1 trial.
      additionalPackages({ packages: ["opencode-ai@1.18.29"] }),
    ],
  },
});
