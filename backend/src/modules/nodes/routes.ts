import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole, requirePanel } from '../../middleware/auth.js';
import { updateClusterNodeSchema, drainNodeRequestSchema } from '@k8s-hosting/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { listNodes, getNode, updateNode, buildDrainImpact, drainNode, deleteNode } from './service.js';

// RFC-1123 DNS subdomain label with dots — matches k8s' own node-name
// validation. We reject anything else at the route boundary so a path
// like "../../etc/passwd" never reaches the k8s client or DB.
const NODE_NAME_REGEX = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

function validateNodeName(name: string): void {
  if (!NODE_NAME_REGEX.test(name)) {
    throw new ApiError('INVALID_FIELD_VALUE', 'Invalid node name', 400, { field: 'name' });
  }
}

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  // Admin-only — node management is infra-level. Defence in depth:
  // authenticate → requirePanel (refuse client-panel tokens even if
  // they somehow carry an admin role claim) → requireRole.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/nodes
  app.get('/admin/nodes', {
    schema: {
      tags: ['Nodes'],
      summary: 'List cluster nodes (server + worker)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const rows = await listNodes(app.db);
    return success(rows);
  });

  // GET /api/v1/admin/nodes/:name
  app.get('/admin/nodes/:name', {
    schema: {
      tags: ['Nodes'],
      summary: 'Get a single cluster node',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { name } = request.params as { name: string };
    validateNodeName(name);
    const row = await getNode(app.db, name);
    if (!row) throw new ApiError('NODE_NOT_FOUND', `Node '${name}' not found`, 404, { node_name: name });
    return success(row);
  });

  // PATCH /api/v1/admin/nodes/:name
  //
  // Body: { role?, canHostClientWorkloads?, notes?, force? }
  //
  // k8s labels are written first (authoritative); DB is refreshed
  // from k8s state. If the target is a server→worker demotion and
  // the node hosts system pods, the request is rejected with
  // NODE_DEMOTION_BLOCKED unless force=true.
  app.patch('/admin/nodes/:name', {
    schema: {
      tags: ['Nodes'],
      summary: 'Update node role / host-client-workloads / notes',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { name } = request.params as { name: string };
    validateNodeName(name);
    const parsed = updateClusterNodeSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const user = request.user;
    const updated = await updateNode(app.db, k8s, name, parsed.data, user
      ? { userId: user.sub, role: user.role }
      : undefined);
    return success(updated);
  });

  // GET /api/v1/admin/nodes/:name/drain-impact
  // Preview which pods (by namespace/name + clientId when tagged) the
  // drain would evict, plus any Longhorn last-replica risks. UI uses
  // this to populate the confirmation modal.
  app.get('/admin/nodes/:name/drain-impact', {
    schema: {
      tags: ['Nodes'],
      summary: 'Preview drain impact for a node',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { name } = request.params as { name: string };
    validateNodeName(name);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const impact = await buildDrainImpact(k8s, app.db, name);
    return success(impact);
  });

  // POST /api/v1/admin/nodes/:name/drain
  // Cordon the node and evict every non-system pod. Refuses by default
  // when this node holds the last running Longhorn replica for any
  // volume — pass forceLastReplica=true to override.
  app.post('/admin/nodes/:name/drain', {
    schema: {
      tags: ['Nodes'],
      summary: 'Cordon and drain a cluster node',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { name } = request.params as { name: string };
    validateNodeName(name);
    const parsed = drainNodeRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await drainNode(k8s, app.db, name, parsed.data);
    // Audit — include the operator's force-flag decision so
    // last-replica overrides are attributable, mirroring the
    // pattern used by force_demote in updateNode.
    try {
      const { auditLogs } = await import('../../db/schema.js');
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: request.user?.sub ?? 'system',
        actorType: 'user',
        actionType: 'node.drain',
        resourceType: 'cluster_node',
        resourceId: name,
        changes: {
          ...result,
          forceLastReplica: parsed.data.forceLastReplica ?? false,
          gracePeriodSeconds: parsed.data.gracePeriodSeconds ?? 60,
        } as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[nodes] drain audit insert failed:', (err as Error).message);
    }
    return success({ nodeName: name, ...result });
  });

  // POST /api/v1/admin/nodes/:name/delete
  // Remove the node from Kubernetes and inventory. Pre-checks: must be
  // cordoned and have zero non-system pods. The host itself is NOT
  // shut down or modified — operator handles that out-of-band.
  app.post('/admin/nodes/:name/delete', {
    schema: {
      tags: ['Nodes'],
      summary: 'Remove a drained node from the cluster + inventory',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { name } = request.params as { name: string };
    validateNodeName(name);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const result = await deleteNode(app.db, k8s, name);
    try {
      const { auditLogs } = await import('../../db/schema.js');
      await app.db.insert(auditLogs).values({
        id: crypto.randomUUID(),
        actorId: request.user?.sub ?? 'system',
        actorType: 'user',
        actionType: 'node.delete',
        resourceType: 'cluster_node',
        resourceId: name,
        changes: result as unknown as Record<string, unknown>,
      });
    } catch (err) {
      console.warn('[nodes] delete audit insert failed:', (err as Error).message);
    }
    return success({ nodeName: name, ...result });
  });
}
