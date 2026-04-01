import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.DATABASE_URL ?? 'mysql://platform:platform@localhost:3307/hosting_platform_test';

let pool: mysql.Pool | null = null;

export async function isDbAvailable(): Promise<boolean> {
  try {
    const conn = await mysql.createConnection(TEST_DB_URL);
    await conn.ping();
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

export function getTestDb() {
  if (!pool) {
    pool = mysql.createPool({
      uri: TEST_DB_URL,
      waitForConnections: true,
      connectionLimit: 5,
    });
  }
  return drizzle(pool, { schema, mode: 'default' });
}

export async function runMigrations() {
  const db = getTestDb();
  const migrationPath = path.resolve(import.meta.dirname, '../db/migrations/0000_initial_schema.sql');
  const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

  // Split on semicolons and execute each statement
  const statements = migrationSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

export async function cleanTables() {
  const db = getTestDb();
  // Use DELETE instead of TRUNCATE to avoid lock issues in test parallelism
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  const tables = [
    'audit_logs', 'cron_jobs', 'usage_metrics', 'backups',
    'deployment_upgrades', 'catalog_entry_versions',
    'domains', 'deployments', 'clients',
    'hosting_plans', 'regions', 'rbac_roles', 'catalog_entries', 'catalog_repositories', 'users',
  ];
  for (const table of tables) {
    try {
      await db.execute(sql.raw(`DELETE FROM ${table}`));
    } catch {
      // Table may not exist yet — safe to ignore
    }
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

export async function closeTestDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
