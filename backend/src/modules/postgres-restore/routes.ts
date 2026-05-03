import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  promotePostgresFromSnapshot,
  isPostgresRestoreInProgress,
  type PitrStep,
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
    return success(isPostgresRestoreInProgress());
  });

  // POST /api/v1/admin/postgres-restore
  // Body: { clusterNamespace, clusterName, snapshotName, recoveryTargetTime? }
  // Sync (~5–10 min). Returns step trace + downtime stats.
  app.post('/admin/postgres-restore', {
    schema: {
      tags: ['PostgresRestore'],
      summary: 'PITR restore: bootstrap from a Longhorn snapshot, optionally with WAL replay, then auto-promote (replace source cluster)',
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
  }, async (request) => {
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

    try {
      const result = await promotePostgresFromSnapshot(
        { k8s, db: app.db, kubeconfigPath: kc },
        {
          clusterNamespace: body.clusterNamespace,
          clusterName: body.clusterName,
          snapshotName: body.snapshotName,
          recoveryTargetTime: body.recoveryTargetTime ?? null,
          actorUserId: actor?.sub ?? null,
        },
      );
      return success(result);
    } catch (err) {
      const code = (err as { code?: number }).code;
      const stepsTrace = (err as { steps?: readonly PitrStep[] }).steps ?? [];
      if (code === 404) throw new ApiError('SNAPSHOT_NOT_FOUND', (err as Error).message, 404, { steps: stepsTrace });
      if (code === 409) throw new ApiError('PITR_PRECONDITION_FAILED', (err as Error).message, 409, { steps: stepsTrace });
      if (code === 422) throw new ApiError('PITR_REQUEST_INVALID', (err as Error).message, 422, { steps: stepsTrace });
      throw new ApiError('PITR_FAILED', (err as Error).message, 500, { steps: stepsTrace });
    }
  });
}
