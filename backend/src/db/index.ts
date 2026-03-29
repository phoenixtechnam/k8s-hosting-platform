import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

let pool: mysql.Pool | null = null;

export function getDb(connectionString: string) {
  if (!pool) {
    pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: 25,             // Up from 10 — handles concurrent API requests
      queueLimit: 50,                  // Max queued connection requests before rejecting
      idleTimeout: 60_000,             // Close idle connections after 60s
      maxIdle: 10,                     // Keep 10 idle connections warm
      enableKeepAlive: true,           // TCP keepalive to prevent stale connections
      keepAliveInitialDelay: 30_000,   // Keepalive probe after 30s idle
    });
  }
  return drizzle(pool, { schema, mode: 'default' });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export type Database = ReturnType<typeof getDb>;
