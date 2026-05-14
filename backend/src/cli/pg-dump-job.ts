/**
 * Postgres pg_dump Job entrypoint. Mirrors pitr-job.ts pattern.
 *
 * Inputs (env vars):
 *   PG_DUMP_RUN_ID            uuid of the system_backup_runs row
 *   PG_DUMP_NAMESPACE         source CNPG cluster's namespace
 *   PG_DUMP_CLUSTER           source CNPG cluster's name
 *   PG_DUMP_DATABASE          database name
 *   PG_DUMP_TARGET_CONFIG_ID  uuid of an active backup_configurations row
 *   PG_DUMP_ACTOR_USER_ID     operator id (audit attribution)
 *
 * Required platform env:
 *   DATABASE_URL              from platform-db-credentials Secret
 *   PLATFORM_ENCRYPTION_KEY       from platform-secrets Secret (optional)
 *
 * NOTE: this CLI does NOT call loadConfig() because the Job pod
 * intentionally does not mount JWT_SECRET (Sec review M3 — pg-dump
 * never issues or verifies JWTs, mounting it widens blast radius).
 * loadConfig() requires JWT_SECRET, so we read just the env vars
 * we need directly.
 *
 * Exit codes:
 *   0 = pg_dump completed + uploaded
 *   1 = orchestration failed (run row updated to status='failed')
 *   2 = setup error (missing env, DB connect failed)
 */

import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../db/index.js';
import { runPgDump } from '../modules/system-backup/pg-dump-orchestrator.js';
import { createK8sClients } from '../modules/k8s-provisioner/k8s-client.js';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`pg-dump-job: ${name} env var is required`);
    process.exit(2);
  }
  return v;
};

async function main(): Promise<void> {
  const runId = required('PG_DUMP_RUN_ID');
  const namespace = required('PG_DUMP_NAMESPACE');
  const cluster = required('PG_DUMP_CLUSTER');
  const database = required('PG_DUMP_DATABASE');
  const targetConfigId = required('PG_DUMP_TARGET_CONFIG_ID');
  const actorUserId = process.env.PG_DUMP_ACTOR_USER_ID ?? null;
  const databaseUrl = required('DATABASE_URL');
  const oidcEncryptionKey = process.env.PLATFORM_ENCRYPTION_KEY ?? null;

  const db = getDb(databaseUrl);
  const k8s = createK8sClients();

  console.log(JSON.stringify({
    msg: 'pg-dump-job starting',
    runId, namespace, cluster, database, targetConfigId, actorUserId,
  }));

  try {
    await db.execute(sql`SELECT 1`);
  } catch (err) {
    const e = err as Error & { cause?: Error };
    console.error(JSON.stringify({
      msg: 'pg-dump-job db-connect failed',
      error: e.message,
      cause: e.cause?.message,
    }));
    await closeDb().catch(() => undefined);
    process.exit(2);
  }

  try {
    const result = await runPgDump({
      db,
      k8s,
      runId,
      namespace,
      cluster,
      database,
      targetConfigId,
      oidcEncryptionKey,
    });
    console.log(JSON.stringify({
      msg: 'pg-dump-job complete',
      sizeBytes: result.sizeBytes,
      sha256: result.sha256,
      bundleId: result.bundleId,
      artifactName: result.artifactName,
    }));
    await closeDb();
    process.exit(0);
  } catch (err) {
    const e = err as Error & { code?: string; cause?: Error };
    console.error(JSON.stringify({
      msg: 'pg-dump-job failed',
      error: e.message,
      cause: e.cause?.message,
      code: e.code,
    }));
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('pg-dump-job: unhandled', err);
  process.exit(1);
});
