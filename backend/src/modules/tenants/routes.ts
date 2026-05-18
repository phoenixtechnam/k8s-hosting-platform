import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import {
  createSubUserSchema,
  updateSubUserSchema,
  resetSubUserPasswordSchema,
} from '@k8s-hosting/api-contracts';
import { authenticate, requireRole, requireTenantAccess } from '../../middleware/auth.js';
import { users } from '../../db/schema.js';
import { createTenantSchema, updateTenantSchema } from './schema.js';
import * as service from './service.js';
import {
  listSubUsers,
  createSubUser,
  updateSubUser,
  resetSubUserPassword,
  deleteSubUser,
  makeDrizzleSubUsersDb,
  getEffectiveMaxSubUsers,
} from './sub-users-service.js';
import { bulkUpdateTenantStatus, bulkDeleteTenants } from './bulk.js';
import { success, paginated } from '../../shared/response.js';
import { parsePaginationParams } from '../../shared/pagination.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { provisioningTasks } from '../../db/schema.js';
import { runProvisionNamespace, PROVISION_STEPS, buildStepsLog } from '../k8s-provisioner/service.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // Lazy-init K8s tenants (undefined if no kubeconfig available)
  const getK8s = () => {
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      return createK8sClients(kubeconfigPath);
    } catch {
      return undefined;
    }
  };

  // Phase 1: the previous version applied
  // `requireRole('super_admin','admin')` as a plugin-wide hook
  // which short-circuited the permissive per-route hooks on the
  // sub-user routes (GET /tenants/:tenantId/users and friends).
  // That produced the "Failed to load users" 403 in the tenant
  // panel. We now install only `authenticate` plugin-wide, and
  // each route declares its own role list in `onRequest`.
  app.addHook('onRequest', authenticate);

  // POST /api/v1/tenants
  app.post('/tenants', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Tenants'],
      summary: 'Create a new tenant',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        // contact_name + phone_e164 + billing_address are optional at the
        // API layer — admin-panel CreateTenantModal enforces them via
        // HTML required, service-to-service callers (integration tests)
        // can omit and backfill later. DB columns are nullable.
        required: ['name', 'primary_email', 'plan_id'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 255 },
          contact_name: { type: 'string', minLength: 1, maxLength: 255 },
          primary_email: { type: 'string', format: 'email' },
          secondary_email: { type: 'string', format: 'email' },
          phone_e164: { type: 'string', pattern: '^\\+[1-9]\\d{1,14}$' },
          billing_address: {
            type: 'object',
            required: ['street_address', 'postal_address', 'city', 'country'],
            properties: {
              street_address: { type: 'string', minLength: 1, maxLength: 500 },
              postal_address: { type: 'string', minLength: 1, maxLength: 500 },
              city: { type: 'string', minLength: 1, maxLength: 200 },
              country: { type: 'string', minLength: 2, maxLength: 100 },
            },
          },
          plan_id: { type: 'string', format: 'uuid' },
          region_id: { type: 'string', format: 'uuid' },
          node_name: { type: 'string', minLength: 1, maxLength: 253 },
          storage_tier: { type: 'string', enum: ['local', 'ha'] },
          subscription_expires_at: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                contactName: { type: ['string', 'null'] },
                primaryEmail: { type: 'string' },
                secondaryEmail: { type: ['string', 'null'] },
                phoneE164: { type: ['string', 'null'] },
                billingAddress: {
                  type: ['object', 'null'],
                  properties: {
                    streetAddress: { type: 'string' },
                    postalAddress: { type: 'string' },
                    city: { type: 'string' },
                    country: { type: 'string' },
                  },
                },
                kubernetesNamespace: { type: 'string' },
                planId: { type: 'string' },
                regionId: { type: 'string' },
                status: { type: 'string' },
                storageTier: { type: 'string' },
                nodeName: { type: ['string', 'null'] },
                isSystem: { type: 'boolean' },
                createdAt: { type: 'string' },
                // The auto-created tenant_admin user surfaces here on
                // create (and only here — never on subsequent reads)
                // so the operator can hand the one-shot password to
                // the tenant. Fastify's response-schema stripping
                // would silently drop these without an explicit decl.
                tenantUser: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    email: { type: 'string' },
                    generatedPassword: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const parsed = createTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // Phase G: capacity preflight. Reject the create request UP-FRONT if
    // the cluster physically cannot fit the new tenant's PVCs at their
    // selected storage tier. The original behaviour (accept, fail
    // minutes later with a stuck FM) was operator-hostile — by the time
    // the failure surfaced the operator had already told the new tenant
    // their account was ready. Now they see "no node has 20 GiB free"
    // before they hit Submit.
    try {
      const { checkProvisioningCapacity, assertHaTierFeasible } = await import('./capacity-preflight.js');
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      let preflightK8s: ReturnType<typeof createK8sClients> | undefined;
      try { preflightK8s = createK8sClients(kubeconfigPath); } catch { /* skip preflight */ }
      const tier = (parsed.data.storage_tier ?? 'local') as 'local' | 'ha';
      // HA-tier feasibility comes BEFORE the disk-capacity check: if the
      // cluster fundamentally can't host HA, surface the cluster-shape
      // error directly instead of "fittingNodes=0" which reads as a
      // capacity problem.
      if (tier === 'ha') {
        await assertHaTierFeasible(app.db);
      }
      const preflight = await checkProvisioningCapacity(app.db, preflightK8s, parsed.data.plan_id, tier);
      if (!preflight.ok && preflight.reason && preflight.fittingNodes < preflight.required.replicaCount) {
        const planSizeGiB = preflight.required.planSizeBytes / (1024 ** 3);
        const fmtBytes = (n: number): string => `${(n / (1024 ** 3)).toFixed(1)} GiB`;
        const nodeBreakdown = preflight.nodes
          .map((n) => `${n.nodeName}: ${fmtBytes(n.freeToScheduleBytes)} free`)
          .join('; ');
        throw new ApiError(
          'PROVISION_OVER_CAPACITY',
          preflight.reason,
          409,
          {
            operatorError: {
              code: 'PROVISION_OVER_CAPACITY',
              title: 'Cluster cannot fit this tenant',
              detail: `Plan needs ${planSizeGiB.toFixed(1)} GiB of storage on ${preflight.required.replicaCount} ${tier === 'ha' ? 'distinct nodes' : 'node'}, but only ${preflight.fittingNodes} node(s) qualify. ${preflight.reason}`,
              remediation: [
                'Open Nodes & Storage → Cluster Nodes and check Longhorn disk capacity per node.',
                'Lower storageReserved on a node with headroom, OR add more storage / a new worker node.',
                'Switch the tenant to a smaller hosting plan if HA is not required.',
                tier === 'ha' ? 'Apply HA needs ≥3 nodes each with the plan size free; consider Local tier (1 replica).' : '',
              ].filter(Boolean),
              retryable: false,
              diagnostics: { nodeBreakdown, fittingNodes: preflight.fittingNodes, requiredReplicas: preflight.required.replicaCount },
            },
          },
          'Free up disk on a node, add a worker, or pick a smaller plan.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Preflight infra issue (longhorn CRD missing, etc.) — log and
      // proceed; the original failure path still applies if a real
      // provision can't happen.
      console.warn(`[tenants.create] capacity preflight skipped: ${(err as Error).message}`);
    }

    const result = await service.createTenant(app.db, parsed.data, request.user.sub);
    const { _generatedPassword, _clientUserId, ...tenant } = result;

    // Auto-provision: trigger namespace provisioning in the background
    try {
      const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
      const k8sTenants = createK8sClients(kubeconfigPath);
      if (k8sTenants) {
        const taskId = crypto.randomUUID();
        await app.db.insert(provisioningTasks).values({
          id: taskId,
          tenantId: tenant.id,
          type: 'provision_namespace',
          status: 'pending',
          totalSteps: PROVISION_STEPS.length,
          completedSteps: 0,
          stepsLog: buildStepsLog(PROVISION_STEPS),
          startedBy: request.user!.sub,
        });
        // Mirror to chip immediately so the operator sees a "running"
        // task right after clicking Create — without this, the chip
        // only lights up once `runProvisionNamespace` updates state to
        // 'running' which is several seconds later. Best-effort.
        const { mirrorProvisioningToTaskTracker } = await import('../k8s-provisioner/service.js');
        await mirrorProvisioningToTaskTracker(app.db, taskId).catch((err) => {
          app.log.warn({ err, taskId }, 'task tracker enroll failed (non-fatal)');
        });
        runProvisionNamespace(app.db, k8sTenants, taskId, tenant.id, {}).catch((err) => {
          app.log.error({ err, taskId, tenantId: tenant.id }, 'Auto-provisioning failed');
        });
      }
    } catch {
      // K8s not available — skip auto-provisioning
    }
    reply.status(201).send(success({
      ...tenant,
      tenantUser: {
        id: _clientUserId,
        email: parsed.data.primary_email,
        generatedPassword: _generatedPassword,
      },
    }));
  });

  // GET /api/v1/tenants
  app.get('/tenants', {
    onRequest: [requireRole('super_admin', 'admin')],
    schema: {
      tags: ['Clients'],
      summary: 'List tenants with cursor-based pagination',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'string', description: 'Opaque pagination cursor' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string', description: 'Search by company name or email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  primaryEmail: { type: 'string' },
                  secondaryEmail: { type: ['string', 'null'] },
                  kubernetesNamespace: { type: 'string' },
                  planId: { type: 'string' },
                  regionId: { type: 'string' },
                  status: { type: 'string' },
                  storageLifecycleState: { type: 'string' },
                  isSystem: { type: 'boolean' },
                  createdBy: { type: ['string', 'null'] },
                  subscriptionExpiresAt: { type: ['string', 'null'] },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                total_count: { type: 'integer' },
                cursor: { type: ['string', 'null'] },
                has_more: { type: 'boolean' },
                page_size: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const query = request.query as Record<string, unknown>;
    const paginationParams = parsePaginationParams(query);
    const search = typeof query.search === 'string' ? query.search : undefined;

    const result = await service.listTenants(app.db, { ...paginationParams, search });
    return paginated(result.data, result.pagination);
  });

  // GET /api/v1/tenants/:id
  app.get('/tenants/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const tenant = await service.getTenantById(app.db, id);
    return success(tenant);
  });

  // GET /api/v1/tenants/:id/storage-placement
  //
  // Returns which cluster nodes hold the tenant's PVC(s) and their
  // Longhorn volume state. Read by the Storage Lifecycle card on the
  // tenant detail page so the operator sees physical placement at a
  // glance ("running on staging1, replicated to staging2 + worker"
  // vs. the more abstract "tier=ha"). Best-effort: a Longhorn API
  // hiccup returns an empty replicas list rather than failing the
  // whole call.
  app.get('/tenants/:id/storage-placement', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const k8s = getK8s();
    if (!k8s) {
      // Dev/test environment without kubeconfig — return empty rather
      // than 500 so the UI degrades gracefully.
      return success({ pvcs: [] });
    }
    const placement = await service.getTenantStoragePlacement(app.db, id, k8s);
    return success(placement);
  });

  // PATCH /api/v1/tenants/:id
  app.patch('/tenants/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = updateTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const userId = ((request.user as { id?: string; sub?: string } | undefined)?.id)
      ?? ((request.user as { sub?: string } | undefined)?.sub) ?? null;
    const updated = await service.updateTenant(app.db, id, parsed.data, { triggeredByUserId: userId });
    return success(updated);
  });

  // DELETE /api/v1/tenants/:id
  // Returns 200 with { transitionId } so the UI can open the
  // progress modal immediately by id (no polling-by-since race).
  app.delete('/tenants/:id', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await service.deleteTenant(app.db, id, getK8s());
    return success({ transitionId: result.transitionId });
  });

  // ─── Impersonation ──────────────────────────────────────────────────────────

  // POST /api/v1/admin/impersonate/:tenantId
  app.post('/admin/impersonate/:tenantId', {
    onRequest: [requireRole('super_admin', 'admin', 'support')],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };

    // Verify tenant exists
    await service.getTenantById(app.db, tenantId);

    // Find the tenant_admin user for this tenant
    const [tenantUser] = await app.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          eq(users.roleName, 'tenant_admin'),
          eq(users.status, 'active'),
        ),
      )
      .limit(1);

    if (!tenantUser) {
      throw new ApiError('NO_CLIENT_USER', 'No active tenant_admin user found for this tenant', 404);
    }

    // Issue a short-lived impersonation JWT
    const token = app.jwt.sign({
      sub: tenantUser.id,
      role: 'tenant_admin',
      panel: 'tenant',
      tenantId,
      impersonatedBy: request.user.sub,
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      iat: Math.floor(Date.now() / 1000),
      jti: crypto.randomUUID(),
    });

    return success({
      token,
      user: {
        id: tenantUser.id,
        email: tenantUser.email,
        fullName: tenantUser.fullName,
        role: 'tenant_admin',
        panel: 'tenant',
        tenantId,
      },
      impersonatedBy: request.user.sub,
      expiresIn: 3600,
    });
  });

  // ─── Client Sub-Users ───────────────────────────────────────────────────────

  // GET /api/v1/tenants/:tenantId/users — readable by the tenant themselves
  // (tenant_admin + tenant_user) plus staff roles. Scoped via
  // requireTenantAccess() so tenant-panel tokens can only see their
  // own team.
  app.get('/tenants/:tenantId/users', {
    onRequest: [
      requireRole('super_admin', 'admin', 'support', 'tenant_admin', 'tenant_user'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    const tenantUsers = await listSubUsers(makeDrizzleSubUsersDb(app.db), tenantId);
    return success(tenantUsers);
  });

  // POST /api/v1/tenants/:tenantId/users — create a sub-user.
  // Only tenant_admin + staff can mutate the team.
  //
  // Phase 2 promotion rule: by design, a `tenant_admin` caller
  // CAN create another `tenant_admin` for their own tenant. This
  // is intentional peer-promotion within a single tenant — cross-
  // tenant escalation is still blocked by `requireTenantAccess()`,
  // and the Zod enum rejects any staff-level role (admin, support,
  // etc.) in the body.
  app.post('/tenants/:tenantId/users', {
    onRequest: [
      requireRole('super_admin', 'admin', 'tenant_admin'),
      requireTenantAccess(),
    ],
  }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };

    const parsed = createSubUserSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        firstError.path.length > 0 ? 'INVALID_FIELD_VALUE' : 'MISSING_REQUIRED_FIELD',
        `Validation error: ${firstError.message}${firstError.path.length > 0 ? ` (${firstError.path.join('.')})` : ''}`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // Verify tenant exists (preserves CLIENT_NOT_FOUND behavior)
    await service.getTenantById(app.db, tenantId);

    const maxSubUsers = await getEffectiveMaxSubUsers(app.db, tenantId);
    const created = await createSubUser(
      makeDrizzleSubUsersDb(app.db),
      tenantId,
      parsed.data,
      { maxSubUsers },
    );

    reply.status(201).send(success(created));
  });

  // PATCH /api/v1/tenants/:tenantId/users/:userId — edit a sub-user.
  // Phase 3: allows tenant_admin + staff to update full_name, role,
  // or status. Password changes go through the Phase 4 endpoint.
  app.patch('/tenants/:tenantId/users/:userId', {
    onRequest: [
      requireRole('super_admin', 'admin', 'tenant_admin'),
      requireTenantAccess(),
    ],
  }, async (request) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };

    const parsed = updateSubUserSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message}${firstError.path.length > 0 ? ` (${firstError.path.join('.')})` : ''}`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    const updated = await updateSubUser(
      makeDrizzleSubUsersDb(app.db),
      tenantId,
      userId,
      {
        fullName: parsed.data.full_name,
        roleName: parsed.data.role_name,
        status: parsed.data.status,
      },
    );

    // Phase 3: a disable MUST kill every active refresh token for the
    // sub-user so /auth/refresh stops working immediately. The current
    // access JWT continues to verify until natural expiry (≤30 min).
    if (parsed.data.status === 'disabled') {
      const { revokeAllUserRefreshTokens } = await import('../auth/refresh-token-service.js');
      await revokeAllUserRefreshTokens(app.db, userId, 'admin_revoke');
    }

    return success(updated);
  });

  // POST /api/v1/tenants/:tenantId/users/:userId/reset-password — admin-
  // assisted password reset. Phase 4: tenant_admin + staff can set a new
  // password for a sub-user. The caller is responsible for communicating
  // the new password to the user out-of-band (no email is sent). JWTs
  // issued before the reset are NOT invalidated — that's blocked on the
  // deferred session-management epic.
  app.post('/tenants/:tenantId/users/:userId/reset-password', {
    onRequest: [
      requireRole('super_admin', 'admin', 'tenant_admin'),
      requireTenantAccess(),
    ],
  }, async (request, reply) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };

    const parsed = resetSubUserPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message}${firstError.path.length > 0 ? ` (${firstError.path.join('.')})` : ''}`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    await resetSubUserPassword(
      makeDrizzleSubUsersDb(app.db),
      tenantId,
      userId,
      parsed.data.new_password,
    );

    // Phase 3: invalidate every active refresh token so the user
    // can't keep rotating with a token issued before the password
    // changed.
    const { revokeAllUserRefreshTokens } = await import('../auth/refresh-token-service.js');
    await revokeAllUserRefreshTokens(app.db, userId, 'password_change');

    reply.status(204).send();
  });

  // DELETE /api/v1/tenants/:tenantId/users/:userId
  app.delete('/tenants/:tenantId/users/:userId', {
    onRequest: [
      requireRole('super_admin', 'admin', 'tenant_admin'),
      requireTenantAccess(),
    ],
  }, async (request, reply) => {
    const { tenantId, userId } = request.params as { tenantId: string; userId: string };
    await deleteSubUser(makeDrizzleSubUsersDb(app.db), tenantId, userId);
    reply.status(204).send();
  });

  // ─── Bulk Operations ────────────────────────────────────────────────────────

  // POST /api/v1/admin/tenants/bulk
  app.post('/admin/tenants/bulk', {
    onRequest: [requireRole('super_admin', 'admin')],
  }, async (request) => {
    const body = request.body as { tenant_ids?: string[]; action?: string };

    if (!Array.isArray(body.tenant_ids) || !body.action) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'tenant_ids (array) and action are required', 400);
    }

    if (body.action !== 'suspend' && body.action !== 'reactivate') {
      throw new ApiError('INVALID_FIELD_VALUE', "action must be 'suspend' or 'reactivate'", 400, { field: 'action' });
    }

    const userId = (request.user as { sub?: string } | undefined)?.sub ?? null;
    const result = await bulkUpdateTenantStatus(app.db, body.tenant_ids, body.action, getK8s(), userId);
    return success(result);
  });

  // DELETE /api/v1/admin/tenants/bulk
  app.delete('/admin/tenants/bulk', {
    onRequest: [requireRole('super_admin')],
  }, async (request, reply) => {
    const body = request.body as { tenant_ids?: string[] };

    if (!Array.isArray(body.tenant_ids) || body.tenant_ids.length === 0) {
      throw new ApiError('MISSING_REQUIRED_FIELD', 'tenant_ids (non-empty array) is required', 400);
    }

    const userId = (request.user as { sub?: string } | undefined)?.sub ?? null;
    const result = await bulkDeleteTenants(app.db, body.tenant_ids, getK8s(), userId);
    return success(result);
  });
}
