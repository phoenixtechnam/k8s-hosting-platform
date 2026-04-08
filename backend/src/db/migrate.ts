import { sql } from 'drizzle-orm';
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

console.log('Running migrations...');

const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

for (const file of files) {
  console.log(`  Applying ${file}...`);
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

  // Phase 3 T4.1: proper SQL statement splitter that correctly
  // handles `;` inside line/block comments, string literals, and
  // dollar-quoted blocks. The old naive split-on-';' bug bit us
  // twice during Phase 2c and Phase 3 migrations.
  const statements = splitSqlStatements(content);

  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // Tolerate "already exists" errors for idempotent migrations:
      // 42P07 = duplicate_table, 42701 = duplicate_column,
      // 42P16 = invalid_table_definition (duplicate constraint),
      // 42710 = duplicate_object (type/enum already exists),
      // 42P04 = duplicate_database (CREATE DATABASE re-run)
      const toleratedCodes = ['42P07', '42701', '42P16', '42710', '42P04'];
      if (toleratedCodes.includes(pgErr.code ?? '')) {
        console.log(`    (skipped: ${pgErr.code} — already exists)`);
      } else {
        throw err;
      }
    }
  }
}

console.log('Migrations complete.');
await closeDb();
