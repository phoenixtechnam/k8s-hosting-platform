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
      const mysqlErr = err as { errno?: number; code?: string };
      // Tolerate "already exists" errors for idempotent migrations:
      // 1050 = Table already exists, 1060 = Duplicate column name,
      // 1061 = Duplicate key name, 1062 = Duplicate entry
      const toleratedErrors = [1050, 1060, 1061, 1062];
      if (toleratedErrors.includes(mysqlErr.errno ?? 0)) {
        console.log(`    (skipped: ${mysqlErr.code ?? 'already exists'})`);
      } else {
        throw err;
      }
    }
  }
}

console.log('Migrations complete.');
await closeDb();
