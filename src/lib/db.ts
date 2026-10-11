/**
 * Postgres access.
 *
 * Uses node-postgres, which is the driver Neon's own guidance recommends on
 * Vercel: attachDatabasePool lets a single pooled client survive across warm
 * invocations instead of opening a fresh TLS connection per request.
 *
 * Two different connection strings are used on purpose:
 *   - pooled  (-pooler): normal query traffic, including from Vercel.
 *   - direct  (no -pooler): schema migrations. PgBouncer runs in transaction
 *     mode and cannot service CREATE EXTENSION or session-level SET.
 */
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { requireEnv } from "./env";

let pool: Pool | null = null;
let poolAttachAttempted = false;

/** Lazily attach Vercel's pool so warm invocations reuse connections. */
async function attachToVercel(current: Pool): Promise<void> {
  if (poolAttachAttempted) return;
  if (!process.env.VERCEL || !process.env.VERCEL_ENV) return;
  poolAttachAttempted = true;
  try {
    const mod: unknown = await import("@vercel/functions");
    const attach = (mod as { attachDatabasePool?: (p: Pool) => void }).attachDatabasePool;
    if (typeof attach === "function") attach(current);
  } catch {
    // Not fatal: without the hook the pool still works, it just reconnects
    // per cold start.
  }
}

/** Pooled client for application queries. */
export function getPool(): Pool {
  if (!pool) {
    const connectionString = requireEnv("DATABASE_URL");
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Neon requires TLS; the connection string already sets sslmode=require,
      // but node-postgres does not honour that parameter on its own.
      ssl: connectionString.includes("sslmode=disable")
        ? false
        : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
    void attachToVercel(pool);
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never[]);
  return res.rows;
}

/**
 * Run `fn` inside a transaction on a dedicated client.
 * Callers must release the client; this helper guarantees it.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Direct (unpooled) connection, for schema work only. */
export async function withDirectConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const connectionString = requireEnv("DATABASE_URL_UNPOOLED");
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 20_000,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    // pool.end() waits for checked-out clients, so release before closing.
    client.release();
    await pool.end();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
