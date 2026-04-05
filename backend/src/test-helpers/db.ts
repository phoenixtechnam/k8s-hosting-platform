import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import fs from 'fs';
import path from 'path';

const TEST_DB_URL = process.env.DATABASE_URL ?? 'postgresql://platform:local-dev-password@localhost:5432/hosting_platform_test';

let pool: pg.Pool | null = null;

export async function isDbAvailable(): Promise<boolean> {
  try {
    const client = new pg.Client({ connectionString: TEST_DB_URL });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export function getTestDb() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 5,
    });
  }
  return drizzle(pool, { schema });
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
  // Use TRUNCATE CASCADE for PostgreSQL — handles foreign keys automatically
  const tables = [
    'audit_logs', 'cron_jobs', 'usage_metrics', 'backups',
    'deployment_upgrades', 'catalog_entry_versions',
    'domains', 'deployments', 'clients',
    'hosting_plans', 'regions', 'rbac_roles', 'catalog_entries', 'catalog_repositories', 'users',
  ];
  for (const table of tables) {
    try {
      await db.execute(sql.raw(`TRUNCATE TABLE ${table} CASCADE`));
    } catch {
      // Table may not exist yet — safe to ignore
    }
  }
}

export async function closeTestDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
