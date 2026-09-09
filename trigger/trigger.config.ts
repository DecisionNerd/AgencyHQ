// `defineConfig` option names verified against the installed
// `@trigger.dev/sdk@4.5.16` / `@trigger.dev/core@4.5.16` type declarations:
//
//   runtime: "node-24" — ConfigRuntime enum value verified from:
//     node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
//     node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/build.d.ts
//     ZodEnum<["node","node-22","node-24","node-26","experimental-node-24",...]>
//     (read 2026-09-09)
//
//   build.extensions: BuildExtension[] verified from:
//     node_modules/.pnpm/@trigger.dev+core@4.5.16_supports-color@10.2.2/
//     node_modules/@trigger.dev/core/dist/commonjs/v3/config.d.ts
//     TriggerConfig.build.extensions?: BuildExtension[]
//     (read 2026-09-09)
//
// Machine presets (per-task) are set in the individual task files.
// The global machine default is not set here; tasks specify their own presets.
import { defineConfig } from "@trigger.dev/sdk";

import { agencyhqToolchain } from "./build/toolchain.ts";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_ME",
  dirs: ["./src/tasks"],
  // node-24: matches the workspace Node runtime (engines: ">=24") and the
  // host Node 24.16.0 qualified in the Slice 1 trial. ConfigRuntime verified
  // against node_modules/@trigger.dev/core/dist/commonjs/v3/schemas/build.d.ts
  // (read 2026-09-09).
  runtime: "node-24",
  maxDuration: 900,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
    },
  },
  logLevel: "info",
  build: {
    // Deploy-time build extension (container profile only; no effect on `trigger dev`).
    // agencyhqToolchain() installs git, ca-certificates, opencode-ai@1.18.29,
    // pnpm@11.25.0 via npm install -g (both land on PATH), creates /home/node
    // and /tmp/agencyhq owned by uid 1000 (node), sets ENV HOME and
    // AGENCYHQ_RUN_ROOT, and injects three deploy-time env vars. See
    // trigger/build/toolchain.ts for the full specification and .d.ts citations.
    extensions: [agencyhqToolchain()],
  },
});
