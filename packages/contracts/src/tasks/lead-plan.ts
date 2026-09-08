import { z } from "zod";

import { AuthorityNarrowingSchema, AuthoritySchema } from "../authority.ts";
import { LeadPlanOutputSchema } from "../lead-proposal.ts";
import { RevisionManifestSchema } from "../manifest.ts";

export type { LeadPlanOutput } from "../lead-proposal.ts";
export { LeadPlanOutputSchema };

/**
 * Payload for the lead.plan task.
 *
 * `authority` is the delegated-authority record for this project/work-item.
 * `narrowing` is an optional per-work-item narrowing of the authority.
 */
export const LeadPlanPayloadSchema = z.object({
  workItemId: z.string().min(1),
  projectId: z.string().min(1),
  repoPath: z.string().min(1),
  baseRevision: z.string().min(1),
  worktreeBase: z.string().min(1),
  /** Delegated-authority record for this project/work-item. */
  authority: AuthoritySchema,
  /** Optional per-work-item narrowing of the authority. */
  narrowing: AuthorityNarrowingSchema.optional(),
  /** Verification profile ids the Lead may select from (project catalog). */
  profileCatalog: z.array(z.string().min(1)).optional(),
  operatorIntent: z.string().min(1),
  /** Optional reproduction of a known defect. */
  defect: z.string().optional(),
  model: z.string().min(1),
  /**
   * Revision manifest for multi-repository WorkItems. The Lead uses this to
   * understand scope and produce contracts that reference the correct target
   * refs and base revisions.
   */
  manifest: RevisionManifestSchema.optional(),
});
export type LeadPlanPayload = z.infer<typeof LeadPlanPayloadSchema>;
