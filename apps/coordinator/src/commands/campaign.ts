/**
 * Campaign commands:
 *  - createCampaign: create a named campaign.
 *  - assignCampaign: assign a work item to a campaign.
 *  - setMainEffort: set the main-effort work item for a campaign.
 *  - setWorkItemRank: update a work item's rank with optimistic locking.
 *
 * All commands are idempotent by commandId (R-010).
 *
 * DB repos used: insertCampaign, getCampaign, assignWorkItemToCampaign,
 * getWorkItem, setWorkItemRank, setMainEffort (from @agencyhq/db).
 *
 * Note on setMainEffort: uses the db repo which enforces membership — the work
 * item must already belong to the campaign. Returns not_a_member otherwise.
 */

import {
  assignWorkItemToCampaign,
  claimCommand,
  completeCommand,
  setMainEffort as dbSetMainEffort,
  setWorkItemRank as dbSetWorkItemRank,
  getCampaign,
  getWorkItem,
  insertCampaign,
} from "@agencyhq/db";
// Note: 'setWorkItemRank as dbSetWorkItemRank' alias avoids clash with the
// exported command function of the same name in this module.
import type pg from "pg";

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type CampaignDeps = {
  pool: pg.Pool;
};

// ---------------------------------------------------------------------------
// createCampaign
// ---------------------------------------------------------------------------

export type CreateCampaignInput = {
  commandId: string;
  name: string;
};

export type CreateCampaignResult =
  | { ok: true; campaignId: string; replayed?: boolean }
  | { ok: false; reason: string; replayed?: boolean };

export async function createCampaign(
  deps: CampaignDeps,
  input: CreateCampaignInput,
): Promise<CreateCampaignResult> {
  const { commandId, name } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "create_campaign");
    if (!claim.claimed) {
      const stored = claim.result as CreateCampaignResult;
      return { ...stored, replayed: true };
    }

    const campaignId = `cmp-${commandId.slice(0, 8)}`;

    await insertCampaign(client, { id: campaignId, name });

    const result: CreateCampaignResult = { ok: true, campaignId };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// assignCampaign
// ---------------------------------------------------------------------------

export type AssignCampaignInput = {
  commandId: string;
  workItemId: string;
  campaignId: string;
};

export type AssignCampaignResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "not_found"; replayed?: boolean };

export async function assignCampaign(
  deps: CampaignDeps,
  input: AssignCampaignInput,
): Promise<AssignCampaignResult> {
  const { commandId, workItemId, campaignId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "assign_campaign");
    if (!claim.claimed) {
      const stored = claim.result as AssignCampaignResult;
      return { ...stored, replayed: true };
    }

    // Check campaign exists via db repo
    const campaign = await getCampaign(client, campaignId);
    if (!campaign) {
      const result: AssignCampaignResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    await assignWorkItemToCampaign(client, workItemId, campaignId);

    const result: AssignCampaignResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// setMainEffort
// ---------------------------------------------------------------------------

export type SetMainEffortInput = {
  commandId: string;
  campaignId: string;
  workItemId: string;
};

export type SetMainEffortResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "not_found" | "not_a_member"; replayed?: boolean };

export async function setMainEffort(
  deps: CampaignDeps,
  input: SetMainEffortInput,
): Promise<SetMainEffortResult> {
  const { commandId, campaignId, workItemId } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "set_main_effort");
    if (!claim.claimed) {
      const stored = claim.result as SetMainEffortResult;
      return { ...stored, replayed: true };
    }

    // Use db repo which enforces campaign membership guard (T-8).
    const outcome = await dbSetMainEffort(client, campaignId, workItemId);

    if (!outcome.ok) {
      const reason: "not_found" | "not_a_member" =
        outcome.reason === "campaign_not_found" ? "not_found" : "not_a_member";
      const result: SetMainEffortResult = { ok: false, reason };
      await completeCommand(client, commandId, result);
      return result;
    }

    const result: SetMainEffortResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// setWorkItemRank
// ---------------------------------------------------------------------------

export type SetWorkItemRankInput = {
  commandId: string;
  workItemId: string;
  rank: number;
  expectedVersion: number;
};

export type SetWorkItemRankResult =
  | { ok: true; replayed?: boolean }
  | { ok: false; reason: "stale_version" | "not_found"; replayed?: boolean };

export async function setWorkItemRank(
  deps: CampaignDeps,
  input: SetWorkItemRankInput,
): Promise<SetWorkItemRankResult> {
  const { commandId, workItemId, rank, expectedVersion } = input;
  const client = await deps.pool.connect();

  try {
    const claim = await claimCommand(client, commandId, "set_rank");
    if (!claim.claimed) {
      const stored = claim.result as SetWorkItemRankResult;
      return { ...stored, replayed: true };
    }

    // Atomic CAS update via db repo (bumps version on success).
    const outcome = await dbSetWorkItemRank(client, workItemId, rank, expectedVersion);

    if (outcome === "stale") {
      // Distinguish not_found from stale_version: check if the row exists.
      const existing = await getWorkItem(client, workItemId);
      const reason: "not_found" | "stale_version" = existing ? "stale_version" : "not_found";
      const result: SetWorkItemRankResult = { ok: false, reason };
      await completeCommand(client, commandId, result);
      return result;
    }

    const result: SetWorkItemRankResult = { ok: true };
    await completeCommand(client, commandId, result);
    return result;
  } finally {
    client.release();
  }
}
