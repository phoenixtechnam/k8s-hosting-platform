/**
 * Postgres PITR Job entrypoint.
 *
 * Runs as a one-shot Kubernetes Job (created by the platform-api
 * route handler) instead of inside the platform-api process. This
 * decouples the orchestration from platform-api's lifecycle —
 * critical because during cutover (postgres briefly unreachable),
 * platform-api's pg connection pool retries saturate the Node event
 * loop, /healthz can't respond, and k8s liveness probe SIGKILLs the
 * pod mid-orchestration. Running in a dedicated Job pod with no
 * postgres-readiness dependencies survives that window cleanly.
 *
 * Inputs are passed as env vars (cleaner than CLI args, easier to
 * escape, and matches platform-api's config style):
 *
 *   PITR_CLUSTER_NAMESPACE      source CNPG cluster's namespace
 *   PITR_CLUSTER_NAME           source CNPG cluster's name
 *   PITR_SNAPSHOT_NAME          Longhorn snapshot CR name
 *   PITR_RECOVERY_TARGET_TIME   ISO-8601 timestamp (optional)
 *   PITR_ACTOR_USER_ID          user id of the operator who triggered
 *
 * Database connection: same DATABASE_URL as platform-api (mounted
 * from platform-config Secret). Kubeconfig: in-cluster service-account
 * token (no KUBECONFIG_PATH set).
 *
 * Exit codes:
 *   0 = orchestration completed successfully
 *   1 = orchestration failed (steps trace + admin notification already
 *       emitted by promotePostgresFromSnapshot's catch block)
 *   2 = setup error (missing env, DB connect failed)
 */

import { loadConfig } from '../config/index.js';
import { getDb, closeDb } from '../db/index.js';
import { createK8sClients } from '../modules/k8s-provisioner/k8s-client.js';
import { promotePostgresFromSnapshot, type PitrStep } from '../modules/postgres-restore/service.js';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) {
    console.error(`pitr-job: ${name} env var is required`);
    process.exit(2);
  }
  return v;
};

async function main(): Promise<void> {
  const clusterNamespace = required('PITR_CLUSTER_NAMESPACE');
  const clusterName = required('PITR_CLUSTER_NAME');
  const snapshotName = required('PITR_SNAPSHOT_NAME');
  const recoveryTargetTime = process.env.PITR_RECOVERY_TARGET_TIME ?? null;
  const actorUserId = process.env.PITR_ACTOR_USER_ID ?? null;

  const config = loadConfig();
  const db = getDb(config.DATABASE_URL);
  const k8s = createK8sClients(); // in-cluster

  console.log(JSON.stringify({
    msg: 'pitr-job starting',
    clusterNamespace, clusterName, snapshotName, recoveryTargetTime, actorUserId,
  }));

  try {
    const result = await promotePostgresFromSnapshot(
      { k8s, db },
      { clusterNamespace, clusterName, snapshotName, recoveryTargetTime, actorUserId },
    );
    console.log(JSON.stringify({ msg: 'pitr-job complete', result }));
    await closeDb();
    process.exit(0);
  } catch (err) {
    const e = err as Error & { steps?: readonly PitrStep[]; code?: number };
    console.error(JSON.stringify({
      msg: 'pitr-job failed',
      error: e.message,
      code: e.code,
      steps: e.steps,
    }));
    await closeDb().catch(() => undefined);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ msg: 'pitr-job uncaught', error: (err as Error).message }));
  process.exit(2);
});
