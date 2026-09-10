/**
 * Repository for the project_credentials table (0008_container_runtime).
 *
 * Credentials are stored as AES-256-GCM ciphertext blobs. This module
 * handles raw ciphertext row storage; callers are responsible for
 * encryption/decryption via packages/db/src/crypto.ts.
 *
 * SECURITY: Secret values never appear in thrown errors or log output.
 * Only project_id, purpose, key_version, and timestamps are safe to log.
 */

import type pg from "pg";
import type { ProjectCredentialRow } from "../rows.ts";
import { ProjectCredentialRowSchema } from "../rows.ts";

export interface ProjectCredentialPut {
  project_id: string;
  purpose: "git-read" | "integrate";
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
}

/**
 * Upsert (put) an encrypted credential row.
 * On conflict (project_id, purpose), updates ciphertext, iv, tag,
 * key_version, and updated_at.
 */
export async function putProjectCredential(
  client: pg.PoolClient,
  row: ProjectCredentialPut,
): Promise<ProjectCredentialRow> {
  const { rows } = await client.query<ProjectCredentialRow>(
    `INSERT INTO project_credentials
       (project_id, purpose, ciphertext, iv, tag, key_version)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, purpose)
     DO UPDATE SET
       ciphertext  = EXCLUDED.ciphertext,
       iv          = EXCLUDED.iv,
       tag         = EXCLUDED.tag,
       key_version = EXCLUDED.key_version,
       updated_at  = now()
     RETURNING *`,
    [row.project_id, row.purpose, row.ciphertext, row.iv, row.tag, row.key_version],
  );
  const first = rows[0];
  if (!first) throw new Error("putProjectCredential: no row returned");
  return ProjectCredentialRowSchema.parse(first);
}

/**
 * Get an encrypted credential row. Returns null if not found.
 */
export async function getProjectCredential(
  client: pg.PoolClient,
  projectId: string,
  purpose: "git-read" | "integrate",
): Promise<ProjectCredentialRow | null> {
  const { rows } = await client.query<ProjectCredentialRow>(
    `SELECT * FROM project_credentials WHERE project_id = $1 AND purpose = $2`,
    [projectId, purpose],
  );
  const first = rows[0];
  if (!first) return null;
  return ProjectCredentialRowSchema.parse(first);
}

/**
 * Delete a credential row. Returns true if a row was deleted, false if not found.
 */
export async function deleteProjectCredential(
  client: pg.PoolClient,
  projectId: string,
  purpose: "git-read" | "integrate",
): Promise<boolean> {
  const { rowCount } = await client.query(
    `DELETE FROM project_credentials WHERE project_id = $1 AND purpose = $2`,
    [projectId, purpose],
  );
  return (rowCount ?? 0) > 0;
}
