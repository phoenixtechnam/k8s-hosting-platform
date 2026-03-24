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
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
}

console.log('Migrations complete.');
await closeDb();
