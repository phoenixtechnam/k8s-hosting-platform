import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

let pool: pg.Pool | null = null;

export function getDb(connectionString: string) {
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 25,                          // Max connections in the pool
      idleTimeoutMillis: 60_000,        // Close idle connections after 60s
      connectionTimeoutMillis: 10_000,  // Timeout for new connections
    });
  }
  return drizzle(pool, { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Borrow a raw pg.Client from the same pool the Drizzle instance uses.
 * Required for long-lived `LISTEN` consumers (the Task Tracker SSE
 * stream) — Drizzle has no surface for `LISTEN/NOTIFY`. Caller MUST
 * release the client when done. The pool is initialised on first
 * `getDb()` call; this throws if called before `getDb()`.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('db pool not initialised — call getDb(connectionString) first');
  }
  return pool;
}

export type Database = ReturnType<typeof getDb>;
