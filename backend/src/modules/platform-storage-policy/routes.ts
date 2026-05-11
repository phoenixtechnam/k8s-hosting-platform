import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { authenticate, requireRole, requirePanel, type JwtPayload } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { updatePlatformStoragePolicySchema } from '@k8s-hosting/api-contracts';
import { auditLogs, notifications, users, platformStorageApplyRuns } from '../../db/schema.js';
import { inArray, eq, and, desc } from 'drizzle-orm';
import { getPolicy, setPolicy, readClusterState, applyPolicy } from './service.js';
import { readClusterCapacity } from './capacity-reconciler.js';
import { getClusterFailoverHeadroom } from './failover-headroom.js';
import { startRun, recordPatchOutcome, watchConvergence, type RunStatus } from './runs.js';
import * as tasks from '../tasks/service.js';
import { toSafeText } from '@k8s-hosting/api-contracts';

export async function platformStoragePolicyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requirePanel('admin'));
  // GET requires admin or super_admin — read-only state.
  // PATCH narrows to super_admin ONLY (per-handler check below); the
  // mutation drops/adds Longhorn replicas which is irreversible for
  // the data on the removed-replica nodes.
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // GET /api/v1/admin/platform-storage-policy
  // GET /api/v1/admin/platform-storage-policy/history
  // Recent Apply HA / Apply Local runs with their step-by-step
  // outcomes — drives the "Recent applies" history list on the
  // Storage Settings page. Operator can see WHEN a tier change
  // happened, WHO did it, and which resources patched / failed
  // (the same per-resource breakdown the bell-icon notification
  // surfaces, but durable + queryable).
  app.get('/admin/platform-storage-policy/history', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Recent Apply HA/Local outcomes for the operator history list',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const q = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), 100);
    const rows = await app.db.select({
      id: auditLogs.id,
      actorId: auditLogs.actorId,
      changes: auditLogs.changes,
      createdAt: auditLogs.createdAt,
      httpStatus: auditLogs.httpStatus,
    }).from(auditLogs)
      .where(and(eq(auditLogs.resourceType, 'platform_storage_policy'), eq(auditLogs.resourceId, 'singleton')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return success(rows.map((r) => {
      const changes = r.changes as null | { before?: { systemTier?: string }; after?: { systemTier?: string }; volumes?: Array<{ ok?: boolean }>; deployments?: Array<{ ok?: boolean }>; cnpgClusters?: Array<{ ok?: boolean }> };
      const volsOk = changes?.volumes?.filter((v) => v.ok).length ?? 0;
      const volsTotal = changes?.volumes?.length ?? 0;
      const depsOk = changes?.deployments?.filter((d) => d.ok).length ?? 0;
      const depsTotal = changes?.deployments?.length ?? 0;
      const cnpgOk = changes?.cnpgClusters?.filter((c) => c.ok).length ?? 0;
      const cnpgTotal = changes?.cnpgClusters?.length ?? 0;
      return {
        id: r.id,
        actorId: r.actorId,
        createdAt: r.createdAt?.toISOString() ?? null,
        before: changes?.before?.systemTier ?? null,
        after: changes?.after?.systemTier ?? null,
        summary: { volumes: { ok: volsOk, total: volsTotal }, deployments: { ok: depsOk, total: depsTotal }, cnpgClusters: { ok: cnpgOk, total: cnpgTotal } },
        changes,
      };
    }));
  });

  // GET /api/v1/admin/stuck-deprovisions
  // Lists tenant namespaces stuck in `Terminating` phase for >1 h.
  // The lifecycle-DELETE cascade normally finishes within minutes,
  // so anything past 1 h indicates a finalizer / orphan PV / Longhorn
  // volume blocking termination. Operator-actionable: each row links
  // to the namespace name + the time it's been Terminating; the
  // existing /admin/clients/:id/storage/clear-failed route can clear
  // stuck client storage state, but namespace-finalizer rescue is
  // manual today (kubectl patch ns ... -p '{"spec":{"finalizers":[]}}').
  // A future destructive force-delete route should land here.
  app.get('/admin/stuck-deprovisions', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'List tenant namespaces stuck in Terminating phase >1h',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    interface NsItem {
      metadata?: { name?: string; deletionTimestamp?: string; finalizers?: string[]; labels?: Record<string, string> };
      status?: { phase?: string };
    }
    const nsList = await k8s.core.listNamespace().catch(() => ({ items: [] as NsItem[] }));
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const stuck = ((nsList.items ?? []) as NsItem[])
      .filter((ns) => ns.status?.phase === 'Terminating')
      .filter((ns) => {
        const t = ns.metadata?.deletionTimestamp;
        return t ? new Date(t).getTime() < oneHourAgo : false;
      })
      .map((ns) => ({
        name: ns.metadata?.name ?? '',
        deletionTimestamp: ns.metadata?.deletionTimestamp ?? null,
        finalizers: ns.metadata?.finalizers ?? [],
        clientId: ns.metadata?.labels?.client ?? null,
        stuckForMs: ns.metadata?.deletionTimestamp ? Date.now() - new Date(ns.metadata.deletionTimestamp).getTime() : 0,
      }))
      .sort((a, b) => b.stuckForMs - a.stuckForMs);
    return success(stuck);
  });

  // GET /api/v1/admin/cluster-capacity
  // Per-node Longhorn commitPct + cluster aggregate. Drives the
  // top-of-page capacity banner in admin panel ("Storage at 92% —
  // provisioning may fail"). Same data the capacity-reconciler tick
  // uses to decide warning/critical notifications.
  app.get('/admin/cluster-capacity', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Per-node Longhorn capacity (storageScheduled vs effective max) for the operator banner',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await readClusterCapacity(k8s));
  });

  // GET /api/v1/admin/cluster-failover-headroom
  //
  // Failover-aware tenant scheduling budget. Computed live as:
  //   tenant_available = sum(server.allocatable)
  //                    − sum(system_pod.requests)
  //                    − max(server.allocatable)         // one-server reserve
  //
  // Drives the future provisioning gate that prevents an operator from
  // over-packing servers to the point where a single-server loss leaves
  // tenant pods Pending on the survivors. Per the 2026-05-11 architecture
  // intent — see failover-headroom.ts.
  app.get('/admin/cluster-failover-headroom', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Failover-aware tenant-scheduling headroom (CPU + memory)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    return success(await getClusterFailoverHeadroom(k8s));
  });

  // Returns the current policy + observed cluster state
  // (server count, recommended tier, per-volume replica facts).
  app.get('/admin/platform-storage-policy', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Current platform-storage policy + cluster state',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    const policy = await getPolicy(app.db);
    const clusterState = await readClusterState(k8s, app.db);
    return success({
      policy: {
        systemTier: policy.systemTier,
        pinnedByAdmin: policy.pinnedByAdmin,
        lastAppliedAt: policy.lastAppliedAt?.toISOString() ?? null,
        lastAppliedBy: policy.lastAppliedBy ?? null,
        updatedAt: policy.updatedAt.toISOString(),
      },
      clusterState,
    });
  });

  // PATCH /api/v1/admin/platform-storage-policy
  // Operator confirms the new tier and the reconciler immediately
  // patches Longhorn Volume CRs. Replica add/remove happens
  // asynchronously inside Longhorn after the patch returns.
  app.patch('/admin/platform-storage-policy', {
    onRequest: requireRole('super_admin'),  // narrower than the plugin-wide hook
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Set platform-storage tier + apply Longhorn replica changes',
      security: [{ bearerAuth: [] }],
    },
  }, async (req: FastifyRequest) => {
    const input = updatePlatformStoragePolicySchema.parse(req.body);
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    // JWT payload exposes the subject (user UUID) on `sub`, not `id` —
    // earlier code read `id` and silently fell through to null, so
    // `last_applied_by` was always NULL. The audit_logs row has its own
    // actor_id column populated below; this fixes the row-level field.
    const user = req.user as JwtPayload | undefined;
    const actorId = user?.sub ?? null;
    const before = await getPolicy(app.db);
    const updated = await setPolicy(app.db, input.systemTier, input.pinnedByAdmin ?? true, actorId);
    // Insert the run row BEFORE applyPolicy so a route-handler crash
    // mid-patch still leaves an auditable record of the attempt.
    const runId = await startRun(app.db, input.systemTier, actorId);

    // Register a task-center entry the operator's chip can show + click
    // to re-open the progress modal. Only when we have an actor (the
    // task-center contract requires user_id for non-system scopes).
    // Failure to register is non-fatal — the apply continues, just
    // without the chip entry; the progress modal opened inline by the
    // operator still works since it polls /runs/:id directly.
    if (actorId) {
      await tasks.start(app.db, {
        kind: 'storage.tier-flip',
        refId: runId,
        scope: 'admin',
        userId: actorId,
        label: toSafeText(`Apply ${input.systemTier === 'ha' ? 'High Availability' : 'Local'} platform storage`),
        target: {
          type: 'modal',
          modal: 'platform-storage-apply',
          modalProps: { runId },
        },
      }).catch((err) => app.log.warn({ err, runId }, 'task-center registration failed'));
    }

    const startedAtMs = Date.now();
    const outcome = await applyPolicy(k8s, app.db);
    await recordPatchOutcome(app.db, runId, outcome).catch((err) => app.log.warn({ err }, 'recordPatchOutcome failed'));

    // Status precedence: any non-capacity error is a hard failure
    // and must be visible to the operator EVEN when CNPG also hit
    // INSUFFICIENT_STORAGE in the same apply. Only when capacity is
    // the SOLE failure mode do we report capacity_blocked.
    const capacityBlocked = outcome.cnpgClusters.some((c) => c.error?.startsWith('INSUFFICIENT_STORAGE'));
    const anyNonCapacityFailure = [
      ...outcome.volumes.filter((v) => v.error),
      ...outcome.deployments.filter((d) => d.error),
      ...outcome.cnpgClusters.filter((c) => c.error && !c.error.startsWith('INSUFFICIENT_STORAGE')),
    ].length > 0;
    const initialStatus: RunStatus = anyNonCapacityFailure
      ? 'failed'
      : capacityBlocked ? 'capacity_blocked' : 'running';

    // Detach the convergence watcher — runs in background up to 10 min,
    // updating convergence_json on the run row every 5 s. The route
    // returns immediately; the operator's modal polls /runs/:id.
    void watchConvergence(k8s, app.db, runId, startedAtMs, initialStatus, app.log).catch((err) => {
      app.log.error({ err, runId }, 'convergence watcher crashed');
    });

    // Audit trail: lastAppliedBy on the row is reset on every change,
    // so push a permanent record into audit_logs that includes the
    // before/after tiers and the per-resource patch outcomes.
    await app.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId,
      actorType: 'user',
      actionType: 'update',
      resourceType: 'platform_storage_policy',
      resourceId: 'singleton',
      changes: {
        before: { systemTier: before.systemTier, pinnedByAdmin: before.pinnedByAdmin },
        after: { systemTier: updated.systemTier, pinnedByAdmin: updated.pinnedByAdmin },
        volumes: outcome.volumes.map((p) => ({ volume: p.volumeName, prev: p.previousReplicas, next: p.newReplicas, ok: p.patched })),
        deployments: outcome.deployments.map((d) => ({ name: d.name, prev: d.previousReplicas, next: d.newReplicas, ok: d.patched })),
        cnpgClusters: outcome.cnpgClusters.map((c) => ({ name: c.name, prev: c.previousInstances, next: c.newInstances, ok: c.patched })),
      },
      httpMethod: 'PATCH',
      httpPath: '/api/v1/admin/platform-storage-policy',
      httpStatus: 200,
    } as typeof auditLogs.$inferInsert).catch((err) => {
      // Don't fail the operator's request because audit insert failed —
      // log so it surfaces in observability and move on.
      app.log.warn({ err }, 'platform-storage-policy: audit log insert failed');
    });

    // Admin-notification fan-out so Apply HA outcomes show up in the
    // bell icon (durable history of every storage-policy change). The
    // operator's UI shows the in-flight result; the notification is
    // for OTHER admins + post-hoc audit. Failures here are non-fatal.
    try {
      const failed = [
        ...outcome.volumes.filter((v) => !v.patched && v.error),
        ...outcome.deployments.filter((d) => !d.patched && d.error),
        ...outcome.cnpgClusters.filter((c) => !c.patched && c.error),
      ];
      const isInsufficientStorage = outcome.cnpgClusters.some((c) => c.error?.startsWith('INSUFFICIENT_STORAGE'));
      const title = failed.length === 0
        ? `Platform storage tier set to ${updated.systemTier}`
        : isInsufficientStorage
          ? `Platform storage Apply ${updated.systemTier} blocked — insufficient capacity`
          : `Platform storage Apply ${updated.systemTier} completed with ${failed.length} failure(s)`;
      const lines: string[] = [];
      lines.push(`Volumes: ${outcome.volumes.filter((v) => v.patched).length} patched, ${outcome.volumes.filter((v) => !v.patched && !v.error).length} no-op, ${outcome.volumes.filter((v) => v.error).length} failed.`);
      lines.push(`Deployments: ${outcome.deployments.filter((d) => d.patched).length} patched, ${outcome.deployments.filter((d) => !d.patched && !d.error).length} no-op, ${outcome.deployments.filter((d) => d.error).length} failed.`);
      lines.push(`CNPG clusters: ${outcome.cnpgClusters.filter((c) => c.patched).length} patched, ${outcome.cnpgClusters.filter((c) => !c.patched && !c.error).length} no-op, ${outcome.cnpgClusters.filter((c) => c.error).length} failed.`);
      for (const f of failed.slice(0, 5)) {
        if ('volumeName' in f) lines.push(`  ✗ vol ${f.volumeName}: ${f.error}`);
        else if ('previousInstances' in f) lines.push(`  ✗ cluster ${f.namespace}/${f.name}: ${f.error}`);
        else lines.push(`  ✗ deploy ${f.namespace}/${f.name}: ${f.error}`);
      }
      const adminRows = await app.db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
      for (const a of adminRows) {
        await app.db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: a.id,
          type: failed.length === 0 ? 'info' : (isInsufficientStorage ? 'error' : 'warning'),
          title,
          message: lines.join(' '),
          resourceType: 'platform_storage_policy',
          resourceId: 'singleton',
        }).catch(() => undefined);
      }
    } catch (err) {
      app.log.warn({ err }, 'platform-storage-policy: notification fan-out failed');
    }

    return success({
      policy: {
        systemTier: updated.systemTier,
        pinnedByAdmin: updated.pinnedByAdmin,
        lastAppliedAt: updated.lastAppliedAt?.toISOString() ?? null,
        lastAppliedBy: updated.lastAppliedBy ?? null,
        updatedAt: updated.updatedAt.toISOString(),
      },
      // Field name preserved (frontend expects "patches") — contains
      // Longhorn volume patch results. New sibling fields surface
      // the additional patch outcomes for stateless Deployments and
      // the CNPG Cluster.
      patches: outcome.volumes,
      deployments: outcome.deployments,
      cnpgClusters: outcome.cnpgClusters,
      // runId so the operator's modal can poll /runs/:id for the
      // post-patch convergence progress (Longhorn rebuild + CNPG join).
      runId,
      runStatus: initialStatus,
    });
  });

  // GET /api/v1/admin/platform-storage-policy/runs/:id
  app.get('/admin/platform-storage-policy/runs/:id', {
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Get one Apply HA run by id (live convergence progress)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const [row] = await app.db.select().from(platformStorageApplyRuns)
      .where(eq(platformStorageApplyRuns.id, id))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', 'run not found', 404);
    return success({
      id: row.id,
      tier: row.tier,
      status: row.status,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      actorUserId: row.actorUserId,
      patchOutcome: row.patchOutcomeJson ?? null,
      convergence: row.convergenceJson ?? null,
    });
  });

  // POST /api/v1/admin/stuck-deprovisions/:namespace/force-clear
  // Phase 5 destructive surface. super_admin only. Confirmation
  // required by retyping the namespace name. Tenant-only.
  app.post('/admin/stuck-deprovisions/:namespace/force-clear', {
    onRequest: requireRole('super_admin'),
    schema: {
      tags: ['PlatformStoragePolicy'],
      summary: 'Force-clear a stuck Terminating tenant namespace (destructive; super_admin only)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['namespace'], properties: { namespace: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['confirmName'],
        properties: { confirmName: { type: 'string' } },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { namespace } = request.params as { namespace: string };
    const body = request.body as { confirmName: string };
    if (body.confirmName !== namespace) {
      throw new ApiError('CONFIRMATION_MISMATCH', `confirmName must match the namespace exactly (expected '${namespace}')`, 400);
    }
    // Tightened regex: must start with `client-`, end with an
    // alphanumeric, no double hyphens, no trailing hyphen. Matches
    // auto-generated tenant slugs like `client-abc123`,
    // `client-foo-bar-1234`. Rejects `client-`, `client--a`,
    // `client-a-`. Last code-level guard on a destructive endpoint —
    // any leak past this is super_admin + Terminating + 60min gate.
    if (!/^client-[a-z0-9]+([a-z0-9-]*[a-z0-9])?$/.test(namespace) || namespace.includes('--')) {
      throw new ApiError('INVALID_FIELD_VALUE', `force-clear is only valid on client-* tenant namespaces`, 400);
    }
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8s = createK8sClients(kubeconfigPath);
    interface NsObj {
      metadata?: { name?: string; deletionTimestamp?: string; finalizers?: string[] };
      status?: { phase?: string };
    }
    const ns = await k8s.core.readNamespace({ name: namespace } as Parameters<typeof k8s.core.readNamespace>[0])
      .catch(() => null) as NsObj | null;
    if (!ns) throw new ApiError('NOT_FOUND', `namespace '${namespace}' not found`, 404);
    if (ns.status?.phase !== 'Terminating') {
      throw new ApiError('PRECONDITION_FAILED', `namespace '${namespace}' is in phase '${ns.status?.phase}', not Terminating — refusing to force-clear`, 409);
    }
    const ageMs = ns.metadata?.deletionTimestamp ? Date.now() - new Date(ns.metadata.deletionTimestamp).getTime() : 0;
    if (ageMs < 60 * 60 * 1000) {
      throw new ApiError('PRECONDITION_FAILED', `namespace '${namespace}' has been Terminating for ${Math.round(ageMs / 60_000)} min — refusing to force-clear before 60 min (let the cascade finish)`, 409);
    }

    const actor = (request as unknown as { user?: JwtPayload }).user;
    const actorId = actor?.sub ?? null;
    const opLog: string[] = [];

    // 1. Patch ns finalizers=[] via the /finalize subresource — the
    // ONLY path k8s honors once deletionTimestamp is set.
    try {
      await (k8s.core as unknown as {
        replaceNamespaceFinalize: (a: { name: string; body: unknown }) => Promise<unknown>;
      }).replaceNamespaceFinalize({
        name: namespace,
        body: {
          apiVersion: 'v1', kind: 'Namespace',
          metadata: { name: namespace, finalizers: [] },
          spec: { finalizers: [] },
        },
      });
      opLog.push('cleared namespace finalizers');
    } catch (err) {
      opLog.push(`finalize patch failed: ${(err as Error).message}`);
    }

    // 2. Force-delete PVs whose claimRef.namespace == ns. For each
    // PV that is Longhorn-provisioned, also delete the matching
    // Longhorn volume CR (PV name == volume CR name in Longhorn's
    // CSI). Non-Longhorn PVs (local-path, hostPath, manually-
    // created) are deleted at the K8s layer only — without the
    // storageClassName/csi.driver guard, a PV name accidentally
    // colliding with an unrelated Longhorn volume in another
    // namespace would silently delete that volume.
    try {
      const pvs = await (k8s.core as unknown as {
        listPersistentVolume: () => Promise<{ items?: ReadonlyArray<{ metadata?: { name?: string }; spec?: { claimRef?: { namespace?: string }; storageClassName?: string; csi?: { driver?: string } } }> }>;
      }).listPersistentVolume();
      let pvCount = 0;
      let lhCount = 0;
      for (const pv of pvs.items ?? []) {
        if (pv.spec?.claimRef?.namespace !== namespace) continue;
        const pvName = pv.metadata?.name;
        if (!pvName) continue;
        await (k8s.core as unknown as {
          deletePersistentVolume: (a: { name: string }) => Promise<unknown>;
        }).deletePersistentVolume({ name: pvName }).catch(() => undefined);
        pvCount++;
        const isLonghorn = (pv.spec?.csi?.driver === 'driver.longhorn.io')
          || (pv.spec?.storageClassName ?? '').startsWith('longhorn');
        if (isLonghorn) {
          await k8s.custom.deleteNamespacedCustomObject({
            group: 'longhorn.io', version: 'v1beta2',
            namespace: 'longhorn-system', plural: 'volumes', name: pvName,
          } as unknown as Parameters<typeof k8s.custom.deleteNamespacedCustomObject>[0]).catch(() => undefined);
          lhCount++;
        }
      }
      opLog.push(`deleted ${pvCount} orphan PV(s) + ${lhCount} Longhorn volume(s)`);
    } catch (err) {
      opLog.push(`PV cleanup failed: ${(err as Error).message}`);
    }

    // 3. Sticky admin notification + audit
    try {
      const adminRows = await app.db.select({ id: users.id }).from(users).where(inArray(users.roleName, ['super_admin', 'admin']));
      for (const a of adminRows) {
        await app.db.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: a.id,
          type: 'warning',
          title: `Stuck namespace force-cleared: ${namespace}`,
          message: `super_admin force-cleared a Terminating namespace stuck for ${Math.round(ageMs / 60_000)} min. Steps: ${opLog.join(' / ')}.`,
          resourceType: 'stuck_deprovision',
          resourceId: namespace,
        }).catch(() => undefined);
      }
    } catch { /* best effort */ }

    await app.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId,
      actorType: 'user',
      actionType: 'force_clear_namespace',
      resourceType: 'stuck_deprovision',
      resourceId: namespace,
      changes: { namespace, ageMs, ops: opLog },
      httpMethod: 'POST',
      httpPath: `/api/v1/admin/stuck-deprovisions/${namespace}/force-clear`,
      httpStatus: 200,
    } as typeof auditLogs.$inferInsert).catch((err) => app.log.warn({ err }, 'force-clear audit insert failed'));

    return success({ namespace, ageMs, ops: opLog });
  });
}
