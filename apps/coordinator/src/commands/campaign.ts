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
 * getWorkItem, setWorkItemRank (from @agencyhq/db).
 *
 * Note on setMainEffort: the db repo setMainEffort enforces that the work item
 * must already belong to the campaign (campaign_id match). This command uses
 * getCampaign for existence check and raw SQL for the update to preserve the
 * existing permissive semantics (set main_effort_work_item_id regardless of
 * campaign membership, mirroring the original coordinator behavior).
 */

import {
  assignWorkItemToCampaign,
  claimCommand,
  completeCommand,
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
  | { ok: false; reason: "not_found"; replayed?: boolean };

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

    // Check campaign exists via db repo
    const campaign = await getCampaign(client, campaignId);
    if (!campaign) {
      const result: SetMainEffortResult = { ok: false, reason: "not_found" };
      await completeCommand(client, commandId, result);
      return result;
    }

    // Update main_effort_work_item_id directly — permissive: does not require
    // the work item to already belong to the campaign (db.setMainEffort enforces
    // that guard; this command intentionally does not to preserve existing behavior).
    await client.query(
      `UPDATE campaigns SET main_effort_work_item_id = $1, updated_at = now() WHERE id = $2`,
      [workItemId, campaignId],
    );

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
