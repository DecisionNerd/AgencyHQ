/**
 * Unit of work: recordDecisionAndIntent
 *
 * Commits a Decision, an optional StepContract, an optional Attempt, and a
 * DispatchIntent in one transaction. Provides idempotency via the commands
 * table keyed by commandId.
 *
 * R-002: decision, attempt, and DispatchIntent are committed before any
 * trigger call.
 */

import type pg from "pg";
import type { AttemptInsert } from "./repos/attempts.ts";
import { insertAttempt } from "./repos/attempts.ts";
import type { DecisionInsert } from "./repos/decisions.ts";
import { insertDecision } from "./repos/decisions.ts";
import type { DispatchIntentInsert } from "./repos/dispatch-intents.ts";
import { insertDispatchIntent } from "./repos/dispatch-intents.ts";
import type { StepContractInsert } from "./repos/step-contracts.ts";
import { insertStepContract } from "./repos/step-contracts.ts";
import { insertTransition } from "./repos/transitions.ts";
import { CommandRowSchema } from "./rows.ts";

export interface RecordDecisionAndIntentInput {
  decision: DecisionInsert;
  /** Provide when the decision freezes a new contract. */
  contract?: StepContractInsert;
  /** Provide when the decision admits a new attempt. */
  attempt?: AttemptInsert;
  intent: DispatchIntentInsert;
  audit: {
    actor: string;
    causationId?: string;
    commandId?: string;
  };
}

export interface RecordDecisionAndIntentResult {
  decisionId: string;
  attemptId?: string;
  intentId: string;
}

/**
 * Detect whether x is a Pool (has `totalCount`) vs. a PoolClient (has `release`).
 */
function isPool(x: pg.Pool | pg.PoolClient): x is pg.Pool {
  return "totalCount" in x;
}

/**
 * Run work inside a transaction on the given client.
 * Caller is responsible for BEGIN/COMMIT/ROLLBACK if using a Pool;
 * this helper is used to share the inner logic.
 */
async function runInserts(
  client: pg.PoolClient,
  input: RecordDecisionAndIntentInput,
): Promise<RecordDecisionAndIntentResult> {
  const { decision, contract, attempt, intent, audit } = input;

  // 1. Check idempotency: if commandId is in commands, return stored result.
  if (audit.commandId) {
    const { rows: cmdRows } = await client.query("SELECT * FROM commands WHERE command_id = $1", [
      audit.commandId,
    ]);
    const existing = cmdRows[0];
    if (existing) {
      const cmd = CommandRowSchema.parse(existing);
      // result was stored as JSON of RecordDecisionAndIntentResult
      const stored = cmd.result as RecordDecisionAndIntentResult;
      return stored;
    }
  }

  // 2. Insert decision.
  const decisionRow = await insertDecision(client, decision);

  // 3. Insert contract (if provided).
  if (contract) {
    await insertStepContract(client, contract);
  }

  // 4. Insert attempt (if provided) + initial transition.
  let attemptId: string | undefined;
  if (attempt) {
    const attemptRow = await insertAttempt(client, attempt);
    attemptId = attemptRow.id;
    // Append initial state transition for the attempt.
    await insertTransition(client, {
      aggregate: "attempts",
      aggregate_id: attemptRow.id,
      from_state: null,
      to_state: attemptRow.status,
      actor: audit.actor,
      causation_id: audit.causationId ?? null,
      command_id: audit.commandId ?? null,
    });
  }

  // 5. Insert dispatch intent + initial transition.
  const intentRow = await insertDispatchIntent(client, intent);
  await insertTransition(client, {
    aggregate: "dispatch_intents",
    aggregate_id: intentRow.id,
    from_state: null,
    to_state: intentRow.status,
    actor: audit.actor,
    causation_id: audit.causationId ?? null,
    command_id: audit.commandId ?? null,
  });

  const result: RecordDecisionAndIntentResult =
    attemptId !== undefined
      ? { decisionId: decisionRow.id, attemptId, intentId: intentRow.id }
      : { decisionId: decisionRow.id, intentId: intentRow.id };

  // 6. Insert into commands (idempotency key) last, with the result JSON.
  if (audit.commandId) {
    await client.query(
      `INSERT INTO commands (command_id, kind, result, at)
       VALUES ($1, $2, $3::jsonb, now())`,
      [audit.commandId, "recordDecisionAndIntent", JSON.stringify(result)],
    );
  }

  return result;
}

/**
 * Insert a decision + optional contract + optional attempt + dispatch intent
 * atomically.
 *
 * - If `client` is a `pg.Pool`, wraps the inserts in BEGIN/COMMIT/ROLLBACK.
 * - If `client` is a `pg.PoolClient`, assumes the caller is already inside a
 *   transaction and runs directly.
 * - If `audit.commandId` matches an existing commands row, returns the stored
 *   result without touching the DB further.
 */
export async function recordDecisionAndIntent(
  client: pg.Pool | pg.PoolClient,
  input: RecordDecisionAndIntentInput,
): Promise<RecordDecisionAndIntentResult> {
  if (isPool(client)) {
    const poolClient = await client.connect();
    try {
      await poolClient.query("BEGIN");
      const result = await runInserts(poolClient, input);
      await poolClient.query("COMMIT");
      return result;
    } catch (err) {
      await poolClient.query("ROLLBACK");
      throw err;
    } finally {
      poolClient.release();
    }
  } else {
    return runInserts(client, input);
  }
}
