import { sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import { getDb, closeDb } from './index.js';
import { splitSqlStatements } from './sql-splitter.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = getDb(databaseUrl);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, 'migrations');

// Walk up to 5 levels of err.cause looking for a SQLSTATE code field.
// Drizzle ≥0.34 wraps the underlying pg error in DrizzleQueryError; the
// pg `.code` field only appears on the wrapper's `.cause`.
type PgLike = { code?: string; message?: string; cause?: unknown };
function findPgCode(e: unknown): string | undefined {
  let cur: PgLike | undefined = e as PgLike;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur.code) return cur.code;
    cur = cur.cause as PgLike | undefined;
  }
  return undefined;
}

// Track applied migrations in a dedicated table so we don't re-run the
// entire history on every restart. Pre-existing clusters (where the
// schema was applied in 2026-04 before this tracker existed) bootstrap
// by detecting the well-known `users` table and back-populating every
// migration file as already-applied. This is intentionally permissive
// — once the tracker exists, we trust it.
async function ensureTrackerTable(): Promise<void> {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS public.__platform_migrations (
      filename TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `));
}

async function backfillTrackerForLegacyDb(allFiles: string[]): Promise<void> {
  // Empty tracker + populated schema = pre-tracker cluster. Mark every
  // migration file as already applied. New migrations land cleanly on
  // top because they're keyed by filename.
  const trackerRows = await db.execute(sql.raw(
    `SELECT COUNT(*)::int AS n FROM public.__platform_migrations`
  )) as { rows?: Array<{ n: number }> };
  const tracked = trackerRows.rows?.[0]?.n ?? 0;
  if (tracked > 0) return;

  const usersExists = await db.execute(sql.raw(
    `SELECT to_regclass('public.users') AS r`
  )) as { rows?: Array<{ r: string | null }> };
  const hasUsers = usersExists.rows?.[0]?.r != null;
  if (!hasUsers) return;

  console.log('  Detected pre-tracker cluster (schema present, tracker empty).');
  console.log(`  Back-populating __platform_migrations with ${allFiles.length} files.`);
  for (const file of allFiles) {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    await db.execute(sql.raw(
      `INSERT INTO public.__platform_migrations (filename, sha256) VALUES ('${file}', '${sha256}')
       ON CONFLICT (filename) DO NOTHING`
    ));
  }
}

async function alreadyApplied(file: string): Promise<boolean> {
  const res = await db.execute(sql.raw(
    `SELECT 1 FROM public.__platform_migrations WHERE filename = '${file}' LIMIT 1`
  )) as { rows?: Array<unknown> };
  return (res.rows?.length ?? 0) > 0;
}

async function recordApplied(file: string, content: string): Promise<void> {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  await db.execute(sql.raw(
    `INSERT INTO public.__platform_migrations (filename, sha256) VALUES ('${file}', '${sha256}')
     ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`
  ));
}

console.log('Running migrations...');

await ensureTrackerTable();

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

await backfillTrackerForLegacyDb(files);

let appliedCount = 0;
let skippedCount = 0;

for (const file of files) {
  if (await alreadyApplied(file)) {
    skippedCount++;
    continue;
  }
  console.log(`  Applying ${file}...`);
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

  // Phase 3 T4.1: proper SQL statement splitter that correctly
  // handles `;` inside line/block comments, string literals, and
  // dollar-quoted blocks.
  const statements = splitSqlStatements(content);

  let fileFailed = false;
  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: unknown) {
      const code = findPgCode(err) ?? '';
      // Tolerate "already exists" errors for idempotent migrations:
      // 42P07 = duplicate_table, 42701 = duplicate_column,
      // 42P16 = invalid_table_definition (duplicate constraint),
      // 42710 = duplicate_object (type/enum already exists),
      // 42P04 = duplicate_database (CREATE DATABASE re-run)
      const toleratedCodes = ['42P07', '42701', '42P16', '42710', '42P04'];
      if (toleratedCodes.includes(code)) {
        console.log(`    (skipped: ${code} — already exists)`);
      } else {
        fileFailed = true;
        throw err;
      }
    }
  }
  if (!fileFailed) {
    await recordApplied(file, content);
    appliedCount++;
  }
}

console.log(`Migrations complete: ${appliedCount} applied, ${skippedCount} already tracked.`);
await closeDb();
