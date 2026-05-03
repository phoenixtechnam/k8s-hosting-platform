import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  isPostgresRestoreInProgressClusterWide,
  acquirePitrLockOrThrow,
  releasePitrLock,
  createPitrJob,
  getPlatformApiImage,
} from './service.js';

const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
function validateName(s: string, kind: string): void {
  if (!s || s.length > 253 || !NAME_RE.test(s)) {
    throw new ApiError('INVALID_FIELD_VALUE', `Invalid ${kind} name`, 400, { field: kind });
  }
}

export async function postgresRestoreRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/postgres-restore/status
  // Returns whether a PITR is currently in flight. The CNPG-write
  // lockout middleware reads this to gate other postgres-mutating
  // routes during restore.
  app.get('/admin/postgres-restore/status', async () => {
    return success(await isPostgresRestoreInProgressClusterWide(app.db));
  });

  // POST /api/v1/admin/postgres-restore
  // Body: { clusterNamespace, clusterName, snapshotName, recoveryTargetTime? }
  //
  // ASYNC: spawns a one-shot Kubernetes Job that runs the orchestration
  // in a dedicated pod, then returns 202 immediately. The Job's pod
  // has no postgres-readiness dependency, so the cutover window
  // (postgres briefly down) does not kill the orchestrator the way it
  // did when this ran inside platform-api. Poll
  // GET /admin/postgres-restore/status for progress; the orchestrator
  // updates the DB-backed lock with phase markers as it progresses.
  //
  // Race semantics: pre-checks the cluster-wide lock and refuses 409
  // if a PITR is already in flight. The Job itself also acquires the
  // lock atomically (race-safe critical section in
  // acquirePitrLockOrThrow), so two near-simultaneous POSTs that both
  // pass the route's pre-check will result in one Job winning and the
  // other Job failing-fast with 409 — which surfaces as a sticky
  // admin notification, not silent corruption.
  app.post('/admin/postgres-restore', {
    schema: {
      tags: ['PostgresRestore'],
      summary: 'PITR restore (async, runs in dedicated k8s Job): bootstrap from a Longhorn snapshot, optionally with WAL replay, then auto-promote (replace source cluster). Returns 202 with the Job name; poll /status for progress.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['clusterNamespace', 'clusterName', 'snapshotName'],
        properties: {
          clusterNamespace: { type: 'string', minLength: 1, maxLength: 253 },
          clusterName: { type: 'string', minLength: 1, maxLength: 253 },
          snapshotName: { type: 'string', minLength: 1, maxLength: 253 },
          recoveryTargetTime: { type: 'string', format: 'date-time' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      clusterNamespace: string;
      clusterName: string;
      snapshotName: string;
      recoveryTargetTime?: string;
    };
    validateName(body.clusterNamespace, 'clusterNamespace');
    validateName(body.clusterName, 'clusterName');
    validateName(body.snapshotName, 'snapshotName');

    const kc = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kc);
    const actor = (request as unknown as { user?: { sub?: string } }).user;

    // Race-safe lock acquisition. Synchronous critical section
    // between cluster-wide check and in-memory set, then DB write,
    // before the Job is created. This prevents two concurrent POSTs
    // from both creating Jobs that race on the lock from inside the
    // Job pods (where the loser would emit a misleading "INTERRUPTED"
    // admin notification). Only ONE POST passes the lock acquire;
    // the other gets 409 here, before any Job is spawned.
    try {
      await acquirePitrLockOrThrow(app.db, {
        clusterNamespace: body.clusterNamespace,
        clusterName: body.clusterName,
        snapshotName: body.snapshotName,
      });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 409) {
        throw new ApiError('PITR_PRECONDITION_FAILED', (err as Error).message, 409);
      }
      throw err;
    }

    // From here on, ALL failure paths must release the lock — the
    // Job hasn't been created yet so the orchestration's finally
    // can't run. Only release on errors before createPitrJob; once
    // the Job is created, it owns the lock release.
    let image: string;
    try {
      image = await getPlatformApiImage(k8s);
    } catch (err) {
      await releasePitrLock(app.db).catch(() => undefined);
      throw new ApiError('PITR_FAILED', `Failed to resolve platform-api image: ${(err as Error).message}`, 500);
    }

    let job;
    try {
      job = await createPitrJob(k8s, {
        clusterNamespace: body.clusterNamespace,
        clusterName: body.clusterName,
        snapshotName: body.snapshotName,
        recoveryTargetTime: body.recoveryTargetTime ?? null,
        actorUserId: actor?.sub ?? null,
        image,
      });
    } catch (err) {
      await releasePitrLock(app.db).catch(() => undefined);
      throw new ApiError('PITR_FAILED', `Failed to create PITR Job: ${(err as Error).message}`, 500);
    }

    reply.code(202);
    return success({
      status: 'started',
      clusterNamespace: body.clusterNamespace,
      clusterName: body.clusterName,
      snapshotName: body.snapshotName,
      recoveryTargetTime: body.recoveryTargetTime ?? null,
      jobName: job.jobName,
      jobNamespace: job.namespace,
      pollUrl: '/api/v1/admin/postgres-restore/status',
      message: `PITR Job ${job.jobName} created in namespace ${job.namespace}. Orchestration runs in a dedicated pod (~5-10 min). Poll status for progress; tail logs via: kubectl logs -n ${job.namespace} job/${job.jobName} -f.`,
    });
  });
}
