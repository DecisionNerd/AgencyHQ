import assert from "node:assert/strict";
import test from "node:test";

import { WorkerReportSchema } from "../src/worker-report.ts";

const validReport = {
  attempted: "Implemented rejection of invalid input in parser.ts",
  outputs: ["src/parser.ts", "src/parser.test.ts"],
  checksRun: [
    { command: "pnpm test", claimedResult: "pass" as const },
    { command: "pnpm typecheck", claimedResult: "pass" as const },
  ],
  unmetCriteria: [],
  limitations: [],
  findings: [
    {
      subject: "Unrelated diagnostic improvement",
      cause: "Noticed during implementation",
      description: "Error message in parser could be more descriptive.",
    },
  ],
};

test("WorkerReportSchema: parses a valid report", () => {
  const result = WorkerReportSchema.safeParse(validReport);
  assert.equal(result.success, true, JSON.stringify(result));
});

test("WorkerReportSchema: parses report with empty arrays", () => {
  const minimal = {
    attempted: "Tried to fix bug",
    outputs: [],
    checksRun: [],
    unmetCriteria: [],
    limitations: [],
    findings: [],
  };
  const result = WorkerReportSchema.safeParse(minimal);
  assert.equal(result.success, true);
});

test("WorkerReportSchema: rejects invalid claimedResult", () => {
  const bad = {
    ...validReport,
    checksRun: [{ command: "pnpm test", claimedResult: "skipped" }],
  };
  const result = WorkerReportSchema.safeParse(bad);
  assert.equal(result.success, false);
});

test("WorkerReportSchema: rejects missing attempted field", () => {
  const { attempted: _omit, ...bad } = validReport;
  const result = WorkerReportSchema.safeParse(bad);
  assert.equal(result.success, false);
});
