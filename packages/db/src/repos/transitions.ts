/**
 * Repository for the transitions audit table.
 * Transitions are append-only; no update or delete operations.
 */

import type pg from "pg";
import type { TransitionRow } from "../rows.ts";
import { TransitionRowSchema } from "../rows.ts";

export interface TransitionInsert {
  aggregate?: string | null;
  aggregate_id?: string | null;
  from_state?: string | null;
  to_state?: string | null;
  actor?: string | null;
  causation_id?: string | null;
  command_id?: string | null;
}

/**
 * Append a transition audit row. Returns the newly inserted row.
 */
export async function insertTransition(
  client: pg.PoolClient,
  row: TransitionInsert,
): Promise<TransitionRow> {
  const { rows } = await client.query<TransitionRow>(
    `INSERT INTO transitions
       (aggregate, aggregate_id, from_state, to_state, actor, causation_id, command_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      row.aggregate ?? null,
      row.aggregate_id ?? null,
      row.from_state ?? null,
      row.to_state ?? null,
      row.actor ?? null,
      row.causation_id ?? null,
      row.command_id ?? null,
    ],
  );
  const first = rows[0];
  if (!first) throw new Error("insertTransition: no row returned");
  // pg returns bigserial as a string; coerce id to number before parsing.
  return TransitionRowSchema.parse({ ...first, id: Number(first.id) });
}
