import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { updateClusterNodeSchema } from '@k8s-hosting/api-contracts';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { listNodes, getNode, updateNode } from './service.js';

export async function nodeRoutes(app: FastifyInstance): Promise<void> {
  // Admin-only — node management is infra-level. Client-panel tokens
  // don't need visibility into the cluster topology.
  app.addHook('onRequest', authenticate);
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
    const updated = await updateNode(app.db, k8s, name, parsed.data);
    return success(updated);
  });
}
