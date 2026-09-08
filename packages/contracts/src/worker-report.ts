import { z } from "zod";

/**
 * A worker's self-report on one attempt. This is context for the Lead and
 * reviewer — never evidence. Criteria are evaluated against verified outputs,
 * not the worker's claims. (TESTING.md §67-73)
 */
export const WorkerReportSchema = z.object({
  /** Plain-English description of what the worker attempted. */
  attempted: z.string(),
  /** Paths or identifiers of artifacts produced. */
  outputs: z.array(z.string()),
  /** Checks the worker ran locally; claimed results are informational only. */
  checksRun: z.array(
    z.object({
      command: z.string(),
      claimedResult: z.enum(["pass", "fail", "unknown"]),
    }),
  ),
  /** Criterion ids or descriptions the worker believes it did not satisfy. */
  unmetCriteria: z.array(z.string()),
  /** Known limitations or partial completions. */
  limitations: z.array(z.string()),
  /** Out-of-scope observations that may warrant a separate WorkItem. */
  findings: z.array(
    z.object({
      subject: z.string(),
      cause: z.string(),
      description: z.string(),
    }),
  ),
});
export type WorkerReport = z.infer<typeof WorkerReportSchema>;
