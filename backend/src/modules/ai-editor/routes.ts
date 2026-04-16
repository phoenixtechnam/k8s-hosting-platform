import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { fileManagerRequest } from '../file-manager/service.js';
import * as deploymentService from '../deployments/service.js';
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
    adminOnly: m.adminOnly,
    isDefault: m.isDefault,
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

  // ─── Client-facing: list enabled models (any authenticated user) ────

  app.get('/ai/models', {
    onRequest: [authenticate],
  }, async (request) => {
    const allModels = await service.listModels(app.db);
    const allProviders = await service.listProviders(app.db);
    const enabledProviderIds = new Set(allProviders.filter((p) => p.enabled && p.apiKeyEnc).map((p) => p.id));
    const isAdmin = ['super_admin', 'admin'].includes(request.user.role);
    const enabledModels = allModels.filter((m) =>
      m.enabled && enabledProviderIds.has(m.providerId) && (isAdmin || !m.adminOnly)
    );

    // Include provider name for display
    const providerMap = new Map(allProviders.map((p) => [p.id, p.displayName]));
    return success(enabledModels.map((m) => ({
      ...formatModel(m),
      providerName: providerMap.get(m.providerId) ?? m.providerId,
    })));
  });

  // ─── Token budget status ────────────────────────────────────────────────

  app.get('/clients/:clientId/ai/budget', {
    onRequest: [authenticate],
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    const budget = await service.getTokenBudget(app.db, clientId);
    return success(budget);
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
    const isImpersonating = Boolean(request.user.impersonatedBy);

    // Check token budget (skip for admins and impersonated sessions)
    if (!isAdmin && !isImpersonating) {
      const budget = await service.getTokenBudget(app.db, clientId);
      if (budget.exhausted) {
        throw new ApiError('BUDGET_EXHAUSTED', `Weekly AI token budget exhausted (${budget.percentUsed}% used). Resets ${budget.weekStart}.`, 429);
      }
    }

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

    if (parsed.data.mode === 'folder-plan' || parsed.data.mode === 'folder') {
      if (!parsed.data.folder_path) {
        throw new ApiError('MISSING_REQUIRED_FIELD', 'folder_path required for folder mode', 400);
      }

      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sClients = (() => { try { return createK8sClients(kubeconfigPath); } catch { return undefined; } })();
      if (!k8sClients) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

      const namespace = await deploymentService.getClientNamespace(app.db, clientId);
      const FM_IMAGE = 'file-manager-sidecar:latest';

      // List files recursively via sidecar
      const lsResult = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/ls', {
        query: { path: parsed.data.folder_path, recursive: 'true' },
      });
      if (lsResult.status !== 200) throw new ApiError('FILE_MANAGER_ERROR', 'Failed to list directory', 500);
      const entries = JSON.parse(lsResult.body).entries as Array<{ name: string; size: number; type: string }>;

      let planResult;
      try {
        planResult = await service.planFolderEdit(app.db, {
          folderPath: parsed.data.folder_path,
          fileList: entries,
          instruction: parsed.data.instruction,
          modelId: parsed.data.model_id,
        });
      } catch (err) {
        throw new ApiError('AI_PLAN_ERROR', err instanceof Error ? err.message : 'AI planning failed', 422);
      }

      if (parsed.data.mode === 'folder-plan') {
        return success(planResult);
      }

      // Combined folder mode — plan + execute in one call
      const readFileFn = async (filePath: string) => {
        const readResult = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/read', {
          query: { path: filePath },
        });
        if (readResult.status !== 200) throw new Error(`Failed to read ${filePath}`);
        return JSON.parse(readResult.body).content as string;
      };

      const result = await service.executeFolderEdit(app.db, {
        folderPath: parsed.data.folder_path,
        operations: planResult.operations,
        plan: planResult.plan,
        instruction: parsed.data.instruction,
        modelId: parsed.data.model_id,
        clientId,
        deploymentId: parsed.data.deployment_id ?? null,
        isAdmin,
        readFile: readFileFn,
      });

      return success({
        changes: result.changes,
        tokensUsed: {
          input: planResult.tokensUsed.input + result.tokensUsed.input,
          output: planResult.tokensUsed.output + result.tokensUsed.output,
        },
        planSummary: planResult.plan,
      });
    }

    if (parsed.data.mode === 'folder-execute') {
      if (!parsed.data.folder_path) {
        throw new ApiError('MISSING_REQUIRED_FIELD', 'folder_path required', 400);
      }

      const body = request.body as Record<string, unknown>;
      const operations = body.operations as service.FolderOp[] | undefined;
      const plan = body.plan as string | undefined;
      if (!operations?.length || !plan) {
        throw new ApiError('MISSING_REQUIRED_FIELD', 'operations and plan required for folder-execute', 400);
      }

      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sClients = (() => { try { return createK8sClients(kubeconfigPath); } catch { return undefined; } })();
      if (!k8sClients) throw new ApiError('K8S_UNAVAILABLE', 'Kubernetes cluster is not available', 503);

      const namespace = await deploymentService.getClientNamespace(app.db, clientId);
      const FM_IMAGE = 'file-manager-sidecar:latest';

      const result = await service.executeFolderEdit(app.db, {
        folderPath: parsed.data.folder_path,
        operations,
        plan,
        instruction: parsed.data.instruction,
        modelId: parsed.data.model_id,
        clientId,
        deploymentId: parsed.data.deployment_id ?? null,
        isAdmin,
        readFile: async (filePath: string) => {
          const readResult = await fileManagerRequest(k8sClients, kubeconfigPath, namespace, FM_IMAGE, '/read', {
            query: { path: filePath },
          });
          if (readResult.status !== 200) throw new Error(`Failed to read ${filePath}`);
          return JSON.parse(readResult.body).content as string;
        },
      });

      return success({
        changes: result.changes,
        tokensUsed: result.tokensUsed,
      });
    }

    if (parsed.data.mode === 'website') {
      throw new ApiError('NOT_IMPLEMENTED', 'Website editor mode is not yet available', 501);
    }

    throw new ApiError('VALIDATION_ERROR', `Unsupported mode: ${parsed.data.mode}`, 400);
  });
}
