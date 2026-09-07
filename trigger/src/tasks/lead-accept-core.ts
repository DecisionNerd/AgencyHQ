// Pure/injectable pieces of the `lead.accept` task (Packet 3.D, ADR-0006).
//
// Factored out so they can be unit-tested without importing `@trigger.dev/sdk`.
// No Trigger SDK usage. No worktree needed. No domain-acceptance imports.
// No decision logic here — outputs proposals for the coordinator to validate.

import type {
  AcceptanceProposal,
  LeadAcceptPayload,
  VerificationResult,
} from "@agencyhq/contracts";
import {
  AcceptanceProposalSchema,
  LEAD_OUTPUT_JSON_SCHEMAS,
  leadAgentPermissions,
} from "@agencyhq/contracts";

import { scrubbedChildEnv } from "../lib/env.ts";
import { buildAcceptPrompt } from "../opencode/accept-prompt.ts";
import type { AcceptTaskOutput, LeadSession } from "../types.ts";

// ---------------------------------------------------------------------------
// Injected dependency types
// ---------------------------------------------------------------------------

export type AcceptDeps = {
  leadSession: LeadSession;
  /**
   * Create and return a unique working directory for the accept session.
   * The `prefix` argument is passed as-is (e.g. "agencyhq-accept-<attemptId>-").
   * In production this is `os.mkdtemp`; in tests it can return a real temp dir
   * so the unit test can assert the dir exists and is not "/tmp".
   */
  mkdtemp: (prefix: string) => Promise<string>;
  /**
   * Remove the working directory created by `mkdtemp` after a successful run.
   * Called only on success; on failure the directory is kept as evidence.
   * Non-fatal: errors are swallowed so they do not mask the real result.
   */
  rmdir: (path: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// verificationResultRef — mirrors domain/evidence/match.ts without importing it
// ---------------------------------------------------------------------------

/** Stable ref string for a VerificationResult: `<verifier>:<checkId>:<attemptRevision>`. */
function verificationResultRef(r: VerificationResult): string {
  return `${r.verifier.name}:${r.checkId}:${r.attemptRevision}`;
}

// ---------------------------------------------------------------------------
// Post-validation: check cited refs exist in the payload
// ---------------------------------------------------------------------------

/**
 * Validates that every verification_result ref cited in the proposal
 * corresponds to a VerificationResult in the payload.
 *
 * Returns the first unknown ref, or undefined if all refs are known.
 * The coordinator re-checks this; we catch it here to surface a clear error.
 */
export function findUnknownRef(
  proposal: AcceptanceProposal,
  knownRefs: ReadonlySet<string>,
): string | undefined {
  for (const criterion of proposal.criteria) {
    for (const evidence of criterion.evidence) {
      if (evidence.kind === "verification_result" && !knownRefs.has(evidence.ref)) {
        return evidence.ref;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// runAccept
// ---------------------------------------------------------------------------

/**
 * Runs one lead.accept session for the given attempt.
 *
 * No worktree is created — the acceptance proposer reads the diff digest,
 * criteria, verification results, and review findings from the payload.
 *
 * A per-run working directory is created via `deps.mkdtemp` (never a bare
 * "/tmp"). On success the directory is removed; on failure it is kept as
 * evidence so the caller can inspect the lead session artifacts.
 *
 * Post-validates that every cited verification_result ref exists in
 * `payload.verificationResults`. Unknown refs → invalid_output.
 */
export async function runAccept(
  payload: LeadAcceptPayload,
  deps: AcceptDeps,
): Promise<AcceptTaskOutput> {
  // Build the set of known refs before calling the session.
  const knownRefs = new Set<string>(payload.verificationResults.map(verificationResultRef));

  // Build prompts.
  const { systemContext, userPrompt } = buildAcceptPrompt(payload);

  // Scrubbed environment: no credentials, no Trigger tokens.
  const env = scrubbedChildEnv({ attemptId: payload.attemptId });

  // Create a per-run working directory. Using mkdtemp (injected) ensures the
  // directory is unique and is never the bare "/tmp". The directory is removed
  // on success; on failure it is kept for evidence (see finally block below).
  const dir = await deps.mkdtemp(`agencyhq-accept-${payload.attemptId}-`);

  let success = false;
  try {
    // Call the lead session.
    let proposal: AcceptanceProposal;
    try {
      const result = await deps.leadSession<AcceptanceProposal>({
        dir,
        runDir: dir,
        model: payload.model,
        agentName: "agencyhq-lead",
        ruleset: leadAgentPermissions(),
        env,
        systemContext,
        userPrompt,
        schema: LEAD_OUTPUT_JSON_SCHEMAS.acceptanceProposal,
        parse: (raw: unknown): AcceptanceProposal => AcceptanceProposalSchema.parse(raw),
        timeoutMs: 240_000,
      });
      proposal = result.value;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "invalid_output", reason: `Lead session error: ${reason}` };
    }

    // Post-validate: every cited verification_result ref must exist in the payload.
    const unknownRef = findUnknownRef(proposal, knownRefs);
    if (unknownRef !== undefined) {
      return {
        kind: "invalid_output",
        reason:
          `Proposal cites unknown verification_result ref "${unknownRef}". ` +
          `Only refs from payload.verificationResults are valid.`,
      };
    }

    success = true;
    return proposal;
  } finally {
    // Remove the working directory on success only; keep on failure for evidence.
    if (success) {
      await deps.rmdir(dir).catch(() => {
        /* non-fatal; best-effort cleanup */
      });
    }
  }
}
