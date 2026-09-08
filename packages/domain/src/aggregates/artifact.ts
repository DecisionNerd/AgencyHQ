/**
 * Artifact aggregate.
 * Content-addressed output: attempt commit id, diff digest, path summary.
 */

import type { ArtifactId, AttemptId } from "../ids.ts";

export type Artifact = {
  readonly id: ArtifactId;
  readonly attemptId: AttemptId;
  /** Git commit sha of the attempt's worktree at completion. */
  readonly revision: string;
  /** SHA-256 digest of the diff. */
  readonly diffDigest: string;
  /** Relative paths changed in this artifact. */
  readonly changedPaths: string[];
};
