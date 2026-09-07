import pg from "pg";

/**
 * Create a pg.Pool for the given database URL.
 */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Run fn inside a transaction. Commits on success, rolls back on error, then rethrows.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set the search_path for the given client (or pool client).
 * Uses pg.escapeIdentifier to safely quote the schema name.
 */
export async function withSchema(client: pg.PoolClient | pg.Client, schema: string): Promise<void> {
  await client.query(`SET search_path TO ${pg.escapeIdentifier(schema)}, public`);
}
