/**
 * Review aggregate.
 * Adversarial review evidence: reviewer identity, subject versions, findings.
 */

import type { AttemptId, ReviewId } from "../ids.ts";
import type { Finding } from "./finding.ts";

export type Review = {
  readonly id: ReviewId;
  readonly attemptId: AttemptId;
  readonly attemptRevision: string;
  readonly diffDigest: string;
  readonly criteriaDigest: string;
  readonly profileDigest: string;
  readonly reviewerModel: string;
  readonly findings: Finding[];
};
