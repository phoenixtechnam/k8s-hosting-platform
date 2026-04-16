import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  createAiProviderSchema,
  updateAiProviderSchema,
  createAiModelSchema,
  updateAiModelSchema,
  aiEditRequestSchema,
  aiTestConnectionSchema,
} from '@k8s-hosting/api-contracts';
import * as service from './service.js';
import type { AiProvider, AiModel } from '../../db/schema.js';

function formatProvider(p: AiProvider) {
  return {
    id: p.id,
    type: p.type,
    displayName: p.displayName,
    baseUrl: p.baseUrl,
    apiKeySet: Boolean(p.apiKeyEnc),
    enabled: p.enabled,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function formatModel(m: AiModel) {
  return {
    id: m.id,
    providerId: m.providerId,
    modelName: m.modelName,
    displayName: m.displayName,
    costPer1mInputTokens: Number(m.costPer1mInputTokens ?? 0),
    costPer1mOutputTokens: Number(m.costPer1mOutputTokens ?? 0),
    maxOutputTokens: m.maxOutputTokens,
    enabled: m.enabled,
    createdAt: m.createdAt.toISOString(),
  };
}

export async function aiEditorRoutes(app: FastifyInstance): Promise<void> {

  // ─── Admin: Provider CRUD ──────────────────────────────────────────────

  app.get('/admin/ai/providers', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => {
    const providers = await service.listProviders(app.db);
    return success(providers.map(formatProvider));
  });

  app.post('/admin/ai/providers', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const parsed = createAiProviderSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);

    const existing = await service.getProvider(app.db, parsed.data.id);
    if (existing) throw new ApiError('DUPLICATE', `Provider "${parsed.data.id}" already exists`, 409);

    const provider = await service.createProvider(app.db, {
      id: parsed.data.id,
      type: parsed.data.type,
      displayName: parsed.data.display_name,
      baseUrl: parsed.data.base_url,
      apiKey: parsed.data.api_key,
    });
    return success(formatProvider(provider));
  });

  app.patch('/admin/ai/providers/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateAiProviderSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);

    const provider = await service.updateProvider(app.db, id, {
      displayName: parsed.data.display_name,
      baseUrl: parsed.data.base_url,
      apiKey: parsed.data.api_key,
      enabled: parsed.data.enabled,
    });
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found', 404);
    return success(formatProvider(provider));
  });

  app.delete('/admin/ai/providers/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteProvider(app.db, id);
    return reply.status(204).send();
  });

  // ─── Admin: Model CRUD ─────────────────────────────────────────────────

  app.get('/admin/ai/models', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async () => {
    const models = await service.listModels(app.db);
    return success(models.map(formatModel));
  });

  app.post('/admin/ai/models', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const parsed = createAiModelSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);

    const provider = await service.getProvider(app.db, parsed.data.provider_id);
    if (!provider) throw new ApiError('NOT_FOUND', `Provider "${parsed.data.provider_id}" not found`, 404);

    const existing = await service.getModel(app.db, parsed.data.id);
    if (existing) throw new ApiError('DUPLICATE', `Model "${parsed.data.id}" already exists`, 409);

    const model = await service.createModel(app.db, {
      id: parsed.data.id,
      providerId: parsed.data.provider_id,
      modelName: parsed.data.model_name,
      displayName: parsed.data.display_name,
      costPer1mInputTokens: parsed.data.cost_per_1m_input_tokens,
      costPer1mOutputTokens: parsed.data.cost_per_1m_output_tokens,
      maxOutputTokens: parsed.data.max_output_tokens,
    });
    return success(formatModel(model));
  });

  app.patch('/admin/ai/models/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateAiModelSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);

    const model = await service.updateModel(app.db, id, {
      displayName: parsed.data.display_name,
      costPer1mInputTokens: parsed.data.cost_per_1m_input_tokens,
      costPer1mOutputTokens: parsed.data.cost_per_1m_output_tokens,
      maxOutputTokens: parsed.data.max_output_tokens,
      enabled: parsed.data.enabled,
    });
    if (!model) throw new ApiError('NOT_FOUND', 'Model not found', 404);
    return success(formatModel(model));
  });

  app.delete('/admin/ai/models/:id', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await service.deleteModel(app.db, id);
    return reply.status(204).send();
  });

  // ─── Test Connection ───────────────────────────────────────────────────

  app.post('/admin/ai/test-connection', {
    onRequest: [authenticate, requireRole('super_admin', 'admin')],
  }, async (request) => {
    const parsed = aiTestConnectionSchema.safeParse(request.body);
    if (!parsed.success) throw new ApiError('VALIDATION_ERROR', parsed.error.errors[0].message, 400);

    const result = await service.testProviderConnection(
      app.db,
      parsed.data.provider_id,
      parsed.data.model_id,
    );
    return success(result);
  });

  // ─── AI Edit ───────────────────────────────────────────────────────────

  app.post('/clients/:clientId/ai/edit', {
    onRequest: [authenticate],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = aiEditRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError('VALIDATION_ERROR', `${firstError.message} (${firstError.path.join('.')})`, 400);
    }

    const isAdmin = ['super_admin', 'admin'].includes(request.user.role);

    if (!parsed.data.model_id) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'model_id is required', 400);
    }

    if (parsed.data.mode === 'file') {
      if (!parsed.data.file_path || parsed.data.file_content === undefined) {
        throw new ApiError('MISSING_REQUIRED_FIELD', 'file_path and file_content required for file mode', 400);
      }

      const result = await service.editFile(app.db, {
        filePath: parsed.data.file_path,
        fileContent: parsed.data.file_content ?? '',
        instruction: parsed.data.instruction,
        modelId: parsed.data.model_id,
        clientId,
        deploymentId: parsed.data.deployment_id ?? null,
        isAdmin,
      });

      return success({
        changes: result.changes,
        tokensUsed: result.tokensUsed,
      });
    }

    if (parsed.data.mode === 'folder') {
      throw new ApiError('NOT_IMPLEMENTED', 'Folder mode requires file-manager integration (use the client panel)', 501);
    }

    if (parsed.data.mode === 'website') {
      throw new ApiError('NOT_IMPLEMENTED', 'Website editor mode is not yet available', 501);
    }

    throw new ApiError('VALIDATION_ERROR', `Unsupported mode: ${parsed.data.mode}`, 400);
  });
}
