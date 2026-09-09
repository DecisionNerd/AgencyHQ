import { configure, runs, tasks } from "@trigger.dev/sdk";

const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 120_000;

const FINAL_STATUSES = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "TIMED_OUT",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  configure({
    baseURL: requireEnv("TRIGGER_API_URL"),
    secretKey: requireEnv("TRIGGER_SECRET_KEY"),
  });

  const handle = await tasks.trigger("runtime.probe", {});
  console.log(`Triggered run ${handle.id}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const run = await runs.retrieve(handle.id);
    if (FINAL_STATUSES.has(run.status)) {
      console.log(`Final status: ${run.status}`);
      console.log("Output:", JSON.stringify(run.output, null, 2));
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Run ${handle.id} did not reach a final status within ${MAX_WAIT_MS}ms`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
