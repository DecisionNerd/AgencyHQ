/**
 * StepContract aggregate.
 * Re-exports the contracts type and provides pure assembly helpers.
 * Supersede, never rebind (R-018).
 */

import type { Digest, LeadProposal, StepContract } from "@agencyhq/contracts";
import type { DecisionId, ProjectId, StepContractId, WorkItemId } from "../ids.ts";

export type { StepContract };

// ---------------------------------------------------------------------------
// freezeContract
// Pure assembly of a StepContract from an already-approved lead proposal.
// Copies bounds from the proposal, never from the project authority schema.
// ---------------------------------------------------------------------------
export type FreezeContractInput = {
  readonly proposal: LeadProposal;
  readonly decisionId: DecisionId;
  readonly workItem: {
    readonly id: WorkItemId;
    readonly projectId: ProjectId;
    readonly intent: string;
    readonly defect?: string;
  };
  readonly project: { readonly id: ProjectId };
  readonly baseRevision: string;
  readonly profileDigest: Digest;
  readonly criteriaDigest: Digest;
  readonly requiredBoundaries: string[];
  readonly humanRequired: boolean;
  readonly version: number;
  readonly id: StepContractId;
};

export function freezeContract(input: FreezeContractInput): StepContract {
  const {
    proposal,
    workItem,
    baseRevision,
    profileDigest,
    criteriaDigest,
    requiredBoundaries,
    humanRequired,
    version,
    id,
  } = input;

  return {
    id,
    workItemId: workItem.id,
    projectId: workItem.projectId,
    version,
    baseRevision,
    inputs: {
      intent: workItem.intent,
      ...(workItem.defect !== undefined ? { defect: workItem.defect } : {}),
    },
    criteria: proposal.criteria,
    criteriaDigest,
    profileId: proposal.profileId,
    profileDigest,
    bounds: {
      paths: proposal.paths,
      capabilities: proposal.capabilities,
      boundary: proposal.boundary,
      budget: proposal.budget,
      review: proposal.review,
      changeClass: proposal.changeClass,
      models: proposal.models,
    },
    requiredBoundaries: requiredBoundaries as StepContract["requiredBoundaries"],
    humanRequired,
    status: "active",
  };
}

// ---------------------------------------------------------------------------
// supersede
// Creates a superseded old contract and a new active contract (version+1).
// The caller must pass all replacement fields explicitly — nothing is silently
// carried from the old contract's criteria or profile digests.
// ---------------------------------------------------------------------------
export type SupersedeInput = {
  readonly nextId: StepContractId;
  readonly proposal: LeadProposal;
  readonly baseRevision: string;
  readonly profileDigest: Digest;
  readonly criteriaDigest: Digest;
  readonly requiredBoundaries: string[];
  readonly humanRequired: boolean;
};

export function supersede(
  contract: StepContract,
  input: SupersedeInput,
): { old: StepContract; next: StepContract } {
  const old: StepContract = {
    ...contract,
    status: "superseded",
    supersededBy: input.nextId,
  };

  const next: StepContract = {
    id: input.nextId,
    workItemId: contract.workItemId,
    projectId: contract.projectId,
    version: contract.version + 1,
    baseRevision: input.baseRevision,
    inputs: contract.inputs,
    criteria: input.proposal.criteria,
    criteriaDigest: input.criteriaDigest,
    profileId: input.proposal.profileId,
    profileDigest: input.profileDigest,
    bounds: {
      paths: input.proposal.paths,
      capabilities: input.proposal.capabilities,
      boundary: input.proposal.boundary,
      budget: input.proposal.budget,
      review: input.proposal.review,
      changeClass: input.proposal.changeClass,
      models: input.proposal.models,
    },
    requiredBoundaries: input.requiredBoundaries as StepContract["requiredBoundaries"],
    humanRequired: input.humanRequired,
    status: "active",
  };

  return { old, next };
}
