import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema.js';

let pool: mysql.Pool | null = null;

export function getDb(connectionString: string) {
  if (!pool) {
    pool = mysql.createPool({
      uri: connectionString,
      waitForConnections: true,
      connectionLimit: 10,
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
