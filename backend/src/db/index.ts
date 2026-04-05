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

export type Database = ReturnType<typeof getDb>;
