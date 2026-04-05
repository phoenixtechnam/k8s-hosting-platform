import { sql } from 'drizzle-orm';
import { getDb, closeDb } from './index.js';
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
  const statements = content
    .split(';')
    .map((s) => s.trim())
    .map((s) => s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // Tolerate "already exists" errors for idempotent migrations:
      // 42P07 = duplicate_table, 42701 = duplicate_column,
      // 42P16 = invalid_table_definition (duplicate constraint),
      // 42710 = duplicate_object (type/enum already exists)
      const toleratedCodes = ['42P07', '42701', '42P16', '42710'];
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
