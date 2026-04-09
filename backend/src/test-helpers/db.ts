import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema.js';
import { splitSqlStatements } from '../db/sql-splitter.js';
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

let migrationsApplied = false;

export async function runMigrations() {
  // Migrations are idempotent ONLY if we reset the public schema
  // before applying them. The initial schema (0000) contains
  // `CREATE TYPE ... AS ENUM` statements that fail on re-run. Guard
  // against repeated calls in the same process with an in-memory
  // flag, then do a real wipe + apply on the first call.
  if (migrationsApplied) return;

  const db = getTestDb();
  // Nuke any existing state from previous test runs (or leaked
  // state from the production schema sharing the DB).
  await db.execute(sql.raw('DROP SCHEMA IF EXISTS public CASCADE'));
  await db.execute(sql.raw('CREATE SCHEMA public'));

  const migrationsDir = path.resolve(import.meta.dirname, '../db/migrations');
  // Apply every numbered .sql file in alphabetical order. This
  // matches what the production migration runner does, which means
  // integration tests run against the same final schema as prod
  // including cascades, new tables, and column defaults.
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const migrationSql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // Use the production SQL splitter so dollar-quoted blocks,
    // string literals, and line/block comments are handled
    // correctly. This matches what src/db/migrate.ts does in prod.
    const statements = splitSqlStatements(migrationSql);

    for (const stmt of statements) {
      try {
        await db.execute(sql.raw(stmt));
      } catch (err) {
        // Tolerate idempotent errors the same way the production
        // migrate runner does (duplicate_table / duplicate_object /
        // duplicate_column). This lets the test suite be re-run
        // against a DB that already contains partial state.
        const pgErr = err as { code?: string };
        const tolerated = ['42P07', '42701', '42P16', '42710', '42P04'];
        if (tolerated.includes(pgErr.code ?? '')) continue;
        throw new Error(
          `Migration ${file} failed on statement:\n${stmt.slice(0, 200)}\n\n${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  migrationsApplied = true;
}

export async function cleanTables() {
  const db = getTestDb();
  // Use TRUNCATE CASCADE for PostgreSQL — handles foreign keys automatically.
  // Order matters less because of CASCADE, but listing parents before
  // children still helps readability.
  const tables = [
    'audit_logs', 'cron_jobs', 'usage_metrics', 'backups',
    'deployment_upgrades', 'catalog_entry_versions',
    // Email subsystem (Phase 3 round-3 added cascades from domains)
    'mail_imapsync_jobs',
    'mailbox_quota_events',
    'mailbox_access',
    'mailboxes',
    'email_aliases',
    'email_dkim_keys',
    'email_domains',
    'dns_records',
    'ingress_routes',
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
