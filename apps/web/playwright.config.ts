import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const webDist = resolve(__dirname, "dist");
const coordinatorMain = resolve(repoRoot, "apps/coordinator/src/main.ts");

const baseURL = process.env.AGENCYHQ_WEB_URL ?? "http://127.0.0.1:8793";
const port = new URL(baseURL).port || "8793";

export default defineConfig({
  testDir: "./e2e",
  retries: 1,
  trace: "on-first-retry",
  use: {
    baseURL,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Build web, then seed DB, then start coordinator serving the built app.
    // All commands share the merged env (DATABASE_URL, RUNTIME, etc.).
    command: [
      `pnpm --filter @agencyhq/web build`,
      `pnpm --filter @agencyhq/coordinator seed:control-plane`,
      `node ${coordinatorMain}`,
    ].join(" && "),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      RUNTIME: "fake",
      AGENCYHQ_API_TOKEN: "browser-test-token",
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      WEB_DIST: webDist,
      PORT: port,
      // Required by coordinator config even for fake runtime
      AGENCYHQ_WORKTREE_BASE: "/tmp/browser-test-worktrees",
      AGENCYHQ_WORKER_MODEL: "claude-sonnet-4-5",
      AGENCYHQ_LEAD_MODEL: "claude-sonnet-4-5",
      AGENCYHQ_REVIEWER_MODEL: "openai/gpt-5.6-sol",
    },
  },
});
