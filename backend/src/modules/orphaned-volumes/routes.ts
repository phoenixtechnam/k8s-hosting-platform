import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { detectOrphans, snapshotOrphan, deleteOrphan, findOrphan, purgeAllOrphans } from './service.js';

const PV_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAME_LEN = 253;

function validateK8sName(name: string, kind: 'pv' | 'volume' | 'namespace'): void {
  if (!name || name.length > MAX_NAME_LEN || !PV_NAME_PATTERN.test(name)) {
    const field = kind === 'pv' ? 'pvName' : kind === 'namespace' ? 'namespace' : 'volumeName';
    throw new ApiError(
      'INVALID_FIELD_VALUE',
      `Invalid ${kind} name`,
      400,
      { field },
    );
  }
}

export async function orphanedVolumesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/orphaned-volumes
  app.get('/admin/orphaned-volumes', {
    schema: {
      tags: ['OrphanedVolumes'],
      summary: 'List orphaned PVs / Longhorn volumes (cluster-wide)',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          stalePvThresholdDays: { type: 'integer', minimum: 1, maximum: 365 },
        },
      },
    },
  }, async (request) => {
    const { stalePvThresholdDays } = request.query as { stalePvThresholdDays?: number };
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const report = await detectOrphans(app.db, k8s, { stalePvThresholdDays });
    return success(report);
  });

  // POST /api/v1/admin/orphaned-volumes/:volumeName/snapshot
  // Take a Longhorn snapshot for recovery before delete. Acts on the
  // Longhorn volume name (which is identical to the PV name when the
  // volume came from a CSI provisioner — the only case where snapshots
  // make sense).
  app.post('/admin/orphaned-volumes/:volumeName/snapshot', {
    schema: {
      tags: ['OrphanedVolumes'],
      summary: 'Take a Longhorn snapshot before deleting an orphan',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['volumeName'], properties: { volumeName: { type: 'string' } } },
    },
  }, async (request) => {
    const { volumeName } = request.params as { volumeName: string };
    validateK8sName(volumeName, 'volume');
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    // Membership check: reject snapshot requests for any volume that
    // isn't currently classified as orphaned. Without this an admin
    // could trigger snapshots on live tenant volumes (data-integrity
    // risk: snapshot retention quotas, freeze I/O).
    const orphan = await findOrphan(app.db, k8s, { volumeName });
    if (!orphan) {
      throw new ApiError('NOT_AN_ORPHAN', `Volume '${volumeName}' is not currently orphaned — refusing to act`, 409, { field: 'volumeName' });
    }
    if (!orphan.longhornVolumeName) {
      throw new ApiError('NO_LONGHORN_VOLUME', `Orphan '${volumeName}' has no Longhorn backing — snapshot not possible`, 409, { field: 'volumeName' });
    }
    try {
      const result = await snapshotOrphan(k8s, orphan.longhornVolumeName);
      return success(result);
    } catch (err) {
      const status = (err as { code?: number; statusCode?: number }).code
        ?? (err as { statusCode?: number }).statusCode;
      if (status === 404) {
        throw new ApiError('VOLUME_NOT_FOUND', `Longhorn volume '${volumeName}' not found`, 404, { field: 'volumeName' });
      }
      throw err;
    }
  });

  // DELETE /api/v1/admin/orphaned-volumes/:volumeName
  // Cascade delete: PV (if present) + Longhorn volume CR. Reuses the
  // pattern from k8s-provisioner/service.ts deprovisionRunCleanup.
  app.delete('/admin/orphaned-volumes/:volumeName', {
    schema: {
      tags: ['OrphanedVolumes'],
      summary: 'Delete an orphaned PV + its Longhorn volume',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['volumeName'], properties: { volumeName: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          pvName: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { volumeName } = request.params as { volumeName: string };
    const { pvName } = request.query as { pvName?: string };
    validateK8sName(volumeName, 'volume');
    if (pvName) validateK8sName(pvName, 'pv');
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    // Membership check: refuse delete unless the (volumeName, pvName)
    // pair currently shows up as an orphan. Without this an authenticated
    // admin could delete any live PV by guessing its name.
    const orphan = await findOrphan(app.db, k8s, { volumeName });
    if (!orphan) {
      throw new ApiError('NOT_AN_ORPHAN', `Volume '${volumeName}' is not currently orphaned — refusing to delete`, 409, { field: 'volumeName' });
    }
    if (pvName && orphan.pvName !== pvName) {
      throw new ApiError('PV_NAME_MISMATCH', `Caller-supplied pvName '${pvName}' does not match the orphan record's PV '${orphan.pvName ?? '(none)'}'`, 409, { field: 'pvName' });
    }
    const result = await deleteOrphan(k8s, {
      pvName: orphan.pvName,
      longhornVolumeName: orphan.longhornVolumeName ?? volumeName,
      namespace: orphan.namespace,
      cascadeNamespace: orphan.reason === 'namespace_orphaned',
    });
    return success(result);
  });

  // DELETE /api/v1/admin/orphaned-volumes/by-namespace/:namespace
  // Cascade delete a `namespace_orphaned` row — there is no PV /
  // Longhorn volume to act on, so the volume-name path is unusable.
  // Membership check refuses anything that isn't currently classified
  // as an orphan, same guard as the volume route.
  //
  // ROUTE ORDERING NOTE: Fastify resolves static segments before
  // parameterised ones, so `/orphaned-volumes/by-namespace/:namespace`
  // wins over `/orphaned-volumes/:volumeName` even though `by-namespace`
  // is a syntactically valid PV name. If the routing semantics change
  // in a future Fastify upgrade, swap to `/ns/:namespace` to remove the
  // potential collision entirely.
  app.delete('/admin/orphaned-volumes/by-namespace/:namespace', {
    schema: {
      tags: ['OrphanedVolumes'],
      summary: 'Delete an orphaned namespace (no backing PV)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['namespace'], properties: { namespace: { type: 'string' } } },
    },
  }, async (request) => {
    const { namespace } = request.params as { namespace: string };
    validateK8sName(namespace, 'namespace');
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const orphan = await findOrphan(app.db, k8s, { namespace });
    if (!orphan || orphan.reason !== 'namespace_orphaned') {
      throw new ApiError('NOT_AN_ORPHAN', `Namespace '${namespace}' is not currently a namespace orphan — refusing to delete`, 409, { field: 'namespace' });
    }
    const result = await deleteOrphan(k8s, {
      pvName: null,
      longhornVolumeName: null,
      namespace,
      cascadeNamespace: true,
    });
    return success(result);
  });

  // POST /api/v1/admin/orphaned-volumes/purge-all
  // Iterate every orphan in the latest scan and run the same cascade
  // each row's individual Delete button would run. Per-row failures
  // are aggregated rather than aborting the whole purge, because a
  // single permission glitch on one Longhorn volume shouldn't block
  // reclaiming the rest.
  app.post('/admin/orphaned-volumes/purge-all', {
    schema: {
      tags: ['OrphanedVolumes'],
      summary: 'Cascade-delete every currently-orphaned volume + namespace',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          stalePvThresholdDays: { type: 'integer', minimum: 1, maximum: 365 },
        },
      },
    },
  }, async (request) => {
    const { stalePvThresholdDays } = request.query as { stalePvThresholdDays?: number };
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await purgeAllOrphans(app.db, k8s, { stalePvThresholdDays });
    return success(result);
  });
}
