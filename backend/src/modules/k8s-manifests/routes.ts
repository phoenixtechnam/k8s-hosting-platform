import type { FastifyInstance } from 'fastify';
import * as yaml from 'js-yaml';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { generateManifestSchema } from '@k8s-hosting/api-contracts';
import { generateClientManifests } from './generator.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';

export async function k8sManifestRoutes(app: FastifyInstance): Promise<void> {
  // All manifest routes require auth + admin role
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/clients/:clientId/manifests
  app.post('/admin/clients/:clientId/manifests', {
    schema: {
      tags: ['K8s Manifests'],
      summary: 'Generate Kustomize manifests for a client',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['clientId'],
        properties: {
          clientId: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: {
          overrides: {
            type: 'object',
            properties: {
              cpu_limit: { type: 'string' },
              memory_limit: { type: 'string' },
              storage_limit: { type: 'string' },
              replica_count: { type: 'integer', minimum: 1, maximum: 10 },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };

    // Validate body with Zod schema
    const parsed = generateManifestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const manifests = await generateClientManifests(app.db, clientId, parsed.data);

    // Derive namespace from first manifest (namespace.yaml)
    const nsManifest = manifests.find(m => m.filename === 'namespace.yaml');
    const namespace = nsManifest
      ? yaml.load(nsManifest.content) as { metadata: { name: string } }
      : undefined;

    return success({
      clientId,
      namespace: namespace?.metadata?.name ?? clientId,
      manifests: manifests.map(m => ({
        filename: m.filename,
        content: m.content,
      })),
    });
  });
}
