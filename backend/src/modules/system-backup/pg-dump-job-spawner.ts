/**
 * Spawn a one-shot Kubernetes Job that runs pg-dump-job.ts inside the
 * platform-api image. Mirrors createPitrJob from postgres-restore.
 *
 * Why a Job (vs in-process):
 *   - pg_dump can take minutes for multi-GB DBs; running inside
 *     platform-api ties up the event loop and risks liveness-probe
 *     SIGKILL.
 *   - Job pod has its own lifecycle, restartPolicy=Never, backoffLimit=0,
 *     ttlSecondsAfterFinished for log retention.
 *
 * Job uses platform-api's ServiceAccount so it inherits all the RBAC
 * + Secret-mount config. The pg_dump binary must be on PATH inside
 * the platform-api container — see Dockerfile (apk add postgresql-client).
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface CreatePgDumpJobInputs {
  readonly runId: string;
  readonly namespace: string;
  readonly cluster: string;
  readonly database: string;
  readonly targetConfigId: string;
  readonly actorUserId: string | null;
  /** Container image of the platform-api build (read from platform-version
   *  ConfigMap so the Job runs the same code as the API that triggered it). */
  readonly image: string;
}

export interface CreatePgDumpJobResult {
  readonly jobName: string;
  readonly namespace: string;
}

export async function createPgDumpJob(
  k8s: K8sClients,
  inputs: CreatePgDumpJobInputs,
): Promise<CreatePgDumpJobResult> {
  const ts = Date.now();
  // Truncate cluster name for K8s 63-char DNS label limit:
  // `pgd-` (4) + safeName (≤30) + `-` (1) + ts (13) ≤ 48.
  const safeCluster = inputs.cluster.slice(0, 30).replace(/[^a-z0-9-]/g, '-');
  const jobName = `pgd-${safeCluster}-${ts}`;
  const jobNamespace = 'platform';

  const jobLabels = {
    'platform.phoenix-host.net/system-backup': 'pg-dump',
    'platform.phoenix-host.net/system-backup-run': inputs.runId,
    'app.kubernetes.io/part-of': 'hosting-platform',
    'app.kubernetes.io/component': 'pg-dump-job',
  };
  const podLabels = {
    ...jobLabels,
    // `app: platform-api` ensures the existing
    // `allow-platform-internal` NetworkPolicy lets the Job reach
    // postgres for the run-row updates.
    app: 'platform-api',
  };

  // Pod env: only what the orchestrator needs to bootstrap. PGUSER /
  // PGPASSWORD are NOT here — they're resolved at runtime by reading
  // the CNPG cluster's bootstrap Secret in its own namespace, which
  // works for cross-namespace clusters like mail/mail-pg (pod env
  // secretKeyRef is namespace-local). JWT_SECRET is also dropped:
  // pg-dump-job never issues or verifies JWTs, so mounting it here
  // would needlessly widen the blast radius of a container escape.
  const env: Array<Record<string, unknown>> = [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'platform-db-credentials', key: 'url' } } },
    {
      // Key in platform-secrets is kebab-case (matches how the
      // platform-api Deployment maps it). Optional so a Job pod can
      // still start in dev clusters that don't have the key — the
      // orchestrator will throw a clean error if the chosen backup
      // target has encrypted credentials and the var is missing.
      name: 'OIDC_ENCRYPTION_KEY',
      valueFrom: { secretKeyRef: { name: 'platform-secrets', key: 'oidc-encryption-key', optional: true } },
    },
    { name: 'PG_DUMP_RUN_ID', value: inputs.runId },
    { name: 'PG_DUMP_NAMESPACE', value: inputs.namespace },
    { name: 'PG_DUMP_CLUSTER', value: inputs.cluster },
    { name: 'PG_DUMP_DATABASE', value: inputs.database },
    { name: 'PG_DUMP_TARGET_CONFIG_ID', value: inputs.targetConfigId },
  ];
  if (inputs.actorUserId) env.push({ name: 'PG_DUMP_ACTOR_USER_ID', value: inputs.actorUserId });

  const body = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: jobNamespace, labels: jobLabels },
    spec: {
      backoffLimit: 0,
      // 24h log retention — operators may inspect via `kubectl logs job/<name>`.
      ttlSecondsAfterFinished: 86400,
      // Hard cap. A 50GB pg_dump @ 10MB/s = ~85min; 90min covers
      // realistic system-DB sizes with buffer.
      activeDeadlineSeconds: 5400,
      template: {
        metadata: { labels: podLabels },
        spec: {
          // Dedicated narrow SA (Phase 2.4b, k8s/base/rbac.yaml):
          // CNPG clusters:get + secrets:get cluster-wide. NOT
          // platform-api which has secrets:* + pods/exec etc.
          serviceAccountName: 'pg-dump-job',
          restartPolicy: 'Never',
          // System DBs land on system-tagged servers — keep dump
          // Job near the data to avoid cross-node bandwidth.
          nodeSelector: { 'platform.phoenix-host.net/node-role': 'server' },
          tolerations: [
            { key: 'platform.phoenix-host.net/server-only', operator: 'Exists', effect: 'NoSchedule' },
          ],
          containers: [{
            name: 'pgdump',
            image: inputs.image,
            // Always pull — `:latest` is mutable.
            imagePullPolicy: 'Always',
            command: ['node', 'dist/cli/pg-dump-job.js'],
            env,
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits:   { cpu: '1', memory: '1Gi' },
            },
          }],
        },
      },
    },
  };

  await (k8s.batch as unknown as {
    createNamespacedJob: (a: { namespace: string; body: unknown }) => Promise<unknown>;
  }).createNamespacedJob({ namespace: jobNamespace, body });

  return { jobName, namespace: jobNamespace };
}
