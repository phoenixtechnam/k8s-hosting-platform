import { loadConfig } from './config/index.js';
import { getDb, closeDb } from './db/index.js';
import { buildApp } from './app.js';

const config = loadConfig();
const db = getDb(config.DATABASE_URL);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Server listening on port ${config.PORT}`);
