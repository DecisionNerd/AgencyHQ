// Print a run's status, metadata, output, and error for trial records.
// Usage: node --env-file=.env scripts/run-info.ts <runId>
// Secrets are never part of the printed fields.
import { runs } from "@trigger.dev/sdk";

import { configureFromEnv } from "./lib/trigger-client.ts";

const runId = process.argv[2];
if (!runId) {
  throw new Error("usage: node --env-file=.env scripts/run-info.ts <runId>");
}
configureFromEnv();
const r = await runs.retrieve(runId);
console.log(
  JSON.stringify(
    {
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      metadata: r.metadata,
      output: r.output,
      error: r.error,
    },
    null,
    1,
  ),
);
