// HTTP routes for the Custom Deployments module.
//
// PR-2 scope: simple-mode CRUD + validation + update-check batch
// + PAT attach/revoke + one-click tag upgrade. The compose-mode
// endpoints are reserved here (POST /clients/:cid/custom-deployments
// with mode='compose' returns 405) and will be wired up in PR-3.
//
// Auth: every route requires authentication + the tenant-access
// hook (clients can only touch their own deployments) +
// `requireClientRoleByMethod` (read for any client role, writes only
// for client_admin + staff). Admin-only fields (`allowRoot`) are
// gated inside the validator at the service layer — the routes are
// agnostic to that.

import type { FastifyInstance } from 'fastify';
import {
  authenticate,
  requireClientAccess,
  requireClientRoleByMethod,
} from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import * as service from './service.js';
import {
  createCustomDeploymentSchema,
  updateCustomDeploymentSchema,
  submitPullCredentialSchema,
  checkUpdatesBatchSchema,
} from './schema.js';
import { checkForUpdate } from './update-checker.js';
import { loadDecryptedToken } from './pat-store.js';
import type { CallerRole } from './role-types.js';

export async function customDeploymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireClientRoleByMethod());
  app.addHook('onRequest', requireClientAccess());

  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  const requireK8s = (): ReturnType<typeof createK8sClients> => {
    const k8s = getK8s();
    if (!k8s) {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes cluster is not available; cannot apply deployment.',
        503,
      );
    }
    return k8s;
  };

  // ─── List / Get ──────────────────────────────────────────────────────────

  app.get('/clients/:clientId/custom-deployments', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const rows = await service.listCustomDeployments(app.db, clientId);
    return success(rows);
  });

  app.get('/clients/:clientId/custom-deployments/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const row = await service.getCustomDeployment(app.db, clientId, id);
    return success(row);
  });

  // ─── Validate (preview) ──────────────────────────────────────────────────

  app.post('/clients/:clientId/custom-deployments/validate', async (request) => {
    // clientId on the path is used only by the auth hook
    // (requireClientAccess); validation itself is tenant-agnostic.
    const parsed = createCustomDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      // Zod-level errors surface as a single issue list. The UI
      // editor renders the issues without throwing.
      return success({
        ok: false,
        issues: parsed.error.issues.map((e) => ({
          severity: 'error' as const,
          code: 'ZOD_VALIDATION_ERROR',
          path: e.path.join('.'),
          message: e.message,
        })),
        spec: null,
        rendered: [],
      });
    }
    const result = parsed.data.mode === 'compose'
      ? await service.validateComposeSpec(
        app.db,
        {
          composeYaml: parsed.data.compose_yaml,
          envFiles: parsed.data.env_files,
          name: parsed.data.name,
        },
        { role: roleOf(request) },
      )
      : await service.validateSimpleSpec(app.db, parsed.data, {
        role: roleOf(request),
      });
    return success({
      ok: result.ok,
      issues: result.issues,
      spec: result.ok ? result.spec : null,
      rendered: [],
    });
  });

  // ─── Compose JSON Schema (served to monaco-yaml in the editor) ──────────
  // Public-ish — the schema is the contract of accepted compose
  // fields, not sensitive. We still keep it behind the auth hook
  // because the contract evolves with platform version and we don't
  // want unauthenticated discovery of the parser surface.
  app.get('/custom-deployments/compose-schema', async () => {
    const { getComposeJsonSchema } = await import('./compose-schema-export.js');
    return success(getComposeJsonSchema());
  });

  // ─── Create ──────────────────────────────────────────────────────────────

  app.post('/clients/:clientId/custom-deployments', async (request, reply) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = createCustomDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const k8s = requireK8s();
    const row = parsed.data.mode === 'compose'
      ? await service.createComposeDeployment(
        app.db,
        k8s,
        clientId,
        parsed.data,
        { role: roleOf(request) },
      )
      : await service.createSimpleDeployment(
        app.db,
        k8s,
        clientId,
        parsed.data,
        { role: roleOf(request) },
      );
    reply.status(201).send(success(row));
  });

  // ─── Update ──────────────────────────────────────────────────────────────

  app.patch('/clients/:clientId/custom-deployments/:id', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const parsed = updateCustomDeploymentSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const k8s = requireK8s();
    const row = await service.updateCustomDeployment(
      app.db,
      k8s,
      clientId,
      id,
      parsed.data,
    );
    return success(row);
  });

  app.put('/clients/:clientId/custom-deployments/:id/upgrade-tag', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const body = request.body as { image?: unknown };
    // Mirror the 500-char cap on `image` enforced by
    // createCustomDeploymentSimpleSchema. Without this the bare
    // PUT bypasses Zod and a multi-megabyte image string lands in
    // customSpec / k8s — the API server rejects it eventually but
    // the resulting `lastError` message is unwieldy.
    if (typeof body?.image !== 'string' || body.image.length === 0 || body.image.length > 500) {
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        'image must be a non-empty string (max 500 chars)',
        400,
        { field: 'image' },
      );
    }
    const k8s = requireK8s();
    const row = await service.upgradeTag(app.db, k8s, clientId, id, body.image);
    return success(row);
  });

  // ─── Delete ──────────────────────────────────────────────────────────────

  app.delete('/clients/:clientId/custom-deployments/:id', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const k8s = requireK8s();
    await service.deleteCustomDeploymentRow(app.db, k8s, clientId, id);
    reply.status(204).send();
  });

  // ─── Update checker (batch) ──────────────────────────────────────────────

  app.post('/clients/:clientId/custom-deployments/check-updates-batch', async (request) => {
    const { clientId } = request.params as { clientId: string };
    const parsed = checkUpdatesBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('INVALID_FIELD_VALUE', 'deployment_ids must be an array of UUIDs', 400);
    }
    // Bounded-concurrency fan-out. Each per-id probe makes up to two
    // registry HTTP calls (tags/list + optional token exchange) with
    // an 8s timeout each. A serial loop over 100 ids would burn up
    // to 1600s — well past Fastify's 30s default. CONCURRENCY=8 caps
    // the worst case to ~200s while keeping outbound load on each
    // registry reasonable (Docker Hub anon throttles at 100/6h per IP).
    const CONCURRENCY = 8;
    const ids = parsed.data.deployment_ids;
    const results: Record<string, unknown> = {};
    const probe = async (id: string): Promise<void> => {
      try {
        const dep = await service.getCustomDeployment(app.db, clientId, id);
        const serviceName = Object.keys(dep.customSpec.services)[0];
        const image = dep.customSpec.services[serviceName]?.image;
        if (!image) {
          results[id] = { status: 'unknown', current: null, latest: null, reason: 'no service image', checkedAt: new Date().toISOString() };
          return;
        }
        const cred = dep.customSpec.pullCredentialId
          ? await loadPatForUpdateCheck(app, id)
          : undefined;
        const r = await checkForUpdate({
          db: app.db,
          image,
          ...(cred ? { authCreds: cred } : {}),
        });
        results[id] = {
          status: r.status,
          current: r.current,
          latest: r.latest,
          reason: r.reason,
          checkedAt: r.checkedAt.toISOString(),
        };
      } catch (err) {
        // A single deployment lookup failure must NOT take down the
        // batch — that's the whole point of the batch endpoint.
        results[id] = {
          status: 'unknown',
          current: null,
          latest: null,
          reason: err instanceof Error ? err.message : 'lookup failed',
          checkedAt: new Date().toISOString(),
        };
      }
    };
    // Worker-pool pattern: spawn CONCURRENCY workers that pull from
    // the id list. Maintains a stable concurrency cap regardless of
    // batch size; awaits all workers before responding.
    let nextIdx = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++;
        if (i >= ids.length) return;
        await probe(ids[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker()),
    );
    return success({ results });
  });

  // ─── Pull credentials (PAT) ──────────────────────────────────────────────

  app.get('/clients/:clientId/custom-deployments/:id/pull-credentials', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const rec = await service.readPullCredentialPublic(app.db, clientId, id);
    if (!rec) return success(null);
    return success({
      id: rec.id,
      deploymentId: rec.deploymentId,
      registryHost: rec.registryHost,
      username: rec.username,
      tokenLastFour: rec.tokenLastFour,
      createdAt: rec.createdAt.toISOString(),
      rotatedAt: rec.rotatedAt ? rec.rotatedAt.toISOString() : null,
    });
  });

  app.put('/clients/:clientId/custom-deployments/:id/pull-credentials', async (request) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const parsed = submitPullCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }
    const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '';
    if (!encryptionKey) {
      throw new ApiError(
        'ENCRYPTION_KEY_MISSING',
        'Platform is not configured for credential storage.',
        500,
      );
    }
    const k8s = requireK8s();
    const rec = await service.attachPullCredential(
      app.db,
      k8s,
      clientId,
      id,
      {
        registryHost: parsed.data.registry_host,
        username: parsed.data.username,
        token: parsed.data.token,
      },
      encryptionKey,
    );
    return success({
      id: rec.id,
      deploymentId: rec.deploymentId,
      registryHost: rec.registryHost,
      username: rec.username,
      tokenLastFour: rec.tokenLastFour,
      createdAt: rec.createdAt.toISOString(),
      rotatedAt: rec.rotatedAt ? rec.rotatedAt.toISOString() : null,
    });
  });

  app.delete('/clients/:clientId/custom-deployments/:id/pull-credentials', async (request, reply) => {
    const { clientId, id } = request.params as { clientId: string; id: string };
    const k8s = requireK8s();
    await service.revokePullCredential(app.db, k8s, clientId, id);
    reply.status(204).send();
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function roleOf(request: { user: { role?: string } }): CallerRole {
  const raw = request.user?.role;
  if (raw === 'super_admin' || raw === 'admin') return raw;
  if (raw === 'client_admin' || raw === 'client_user') return raw;
  // Catalog routes are reachable by other roles too (billing, support
  // etc.) — for our purposes treat anything else as the most-restricted
  // tenant role.
  return 'client_user';
}

/**
 * Resolve the decrypted PAT for use in an update-check call against
 * a private registry. Ownership is verified by the caller via
 * `getCustomDeployment(db, clientId, id)` before this helper runs;
 * we don't re-check here. The decrypted cleartext exists only for
 * the duration of one HTTP call to the registry.
 */
async function loadPatForUpdateCheck(
  app: FastifyInstance,
  deploymentId: string,
): Promise<{ username: string; password: string } | undefined> {
  const key = process.env.OIDC_ENCRYPTION_KEY;
  if (!key) return undefined;
  const decrypted = await loadDecryptedToken(app.db, deploymentId, key);
  if (!decrypted) return undefined;
  return { username: decrypted.username, password: decrypted.token };
}
