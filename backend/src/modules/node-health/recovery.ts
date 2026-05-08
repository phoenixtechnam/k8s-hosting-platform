/**
 * UI-actionable recovery procedures for the conditions surfaced by
 * the node-health monitor.
 *
 * Operator clicks "Recover…" on a non-normal node row → confirmation
 * modal (type-the-node-name) → POST to one of these endpoints. Each
 * action:
 *
 *   - Refuses to touch tenant pods (namespace `client-*`) and CNPG
 *     cluster instances (label `cnpg.io/instance` set). Tenant data
 *     and stateful primaries should never get force-deleted from a
 *     button — those have their own lifecycle paths.
 *   - Audit-logs the action with the operator's user id + reason.
 *   - Is idempotent — running twice on a recovered node returns
 *     `{ recovered: 0 }` not an error.
 *
 * Allow-list of safe system namespaces below. Adding a new namespace
 * is a deliberate decision; the default-deny stance prevents the
 * "operator clicked a button and bricked a tenant" failure mode.
 */

import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { auditLogs } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import crypto from 'node:crypto';

/**
 * Namespaces whose pods may be force-deleted by recovery actions.
 * Anything outside this set is treated as user-data and refused.
 *
 * Note `cnpg-system` is on the list — but the per-pod guard below
 * still refuses pods carrying `cnpg.io/instance` (those are Postgres
 * instance pods, not the operator). Only the cnpg operator
 * Deployment pod itself is recyclable.
 */
const SAFE_NAMESPACES: ReadonlySet<string> = new Set([
  'calico-system',
  'longhorn-system',
  'ingress-nginx',
  'kube-system',
  'cnpg-system',
  'cert-manager',
  'flux-system',
  'platform-system',
  'tigera-operator',
]);

interface RawPod {
  readonly metadata?: {
    readonly name?: string;
    readonly namespace?: string;
    readonly labels?: Record<string, string>;
  };
  readonly spec?: { readonly nodeName?: string };
  readonly status?: {
    readonly phase?: string;
    readonly reason?: string;
    readonly containerStatuses?: ReadonlyArray<{
      readonly state?: { readonly unknown?: unknown; readonly waiting?: { readonly reason?: string } };
    }>;
  };
}

function isStatefulCnpgInstance(pod: RawPod): boolean {
  const labels = pod.metadata?.labels ?? {};
  // Set on every CNPG-managed Postgres instance pod (system-db-1 etc).
  // Force-deleting one of these mid-flight could corrupt the cluster
  // — refuse from a button. Operators who really need to restart a
  // primary use the CNPG operator's failover endpoints instead.
  return Boolean(labels['cnpg.io/instance']);
}

function ensureSafeNamespace(namespace: string): void {
  if (namespace.startsWith('client-')) {
    throw new ApiError(
      'RECOVERY_FORBIDDEN_NAMESPACE',
      `Refusing to operate on tenant namespace '${namespace}'. Recovery actions are limited to platform-system namespaces.`,
      403,
      { namespace },
    );
  }
  if (!SAFE_NAMESPACES.has(namespace)) {
    throw new ApiError(
      'RECOVERY_FORBIDDEN_NAMESPACE',
      `Namespace '${namespace}' is not on the recovery-action allow-list. See node-health/recovery.ts SAFE_NAMESPACES.`,
      403,
      { namespace },
    );
  }
}

async function audit(
  db: Database,
  actorUserId: string,
  actionType: string,
  node: string,
  details: Record<string, unknown>,
): Promise<void> {
  // resource_id column is varchar(36) — too short for ns/pod paths.
  // Store node as resourceId; full path goes in `changes` for the
  // audit-trail search.
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: actorUserId,
    actorType: 'user',
    actionType,
    resourceType: 'node_health_recovery',
    resourceId: node,
    changes: details,
  }).catch((err) => {
    console.error('[node-health-recovery] audit insert failed:', (err as Error).message);
  });
}

/**
 * Delete one specific pod on a node. The pod's controlling
 * Deployment/DaemonSet/StatefulSet will reschedule it; meanwhile,
 * containerd GCs the pod's writable overlay layer (the recovery
 * mechanism that fixed the 2026-05-08 worker incident).
 *
 * Refuses tenant namespaces + CNPG instance pods. Verifies the pod
 * is actually on the claimed node (typo-protection).
 */
export async function recyclePod(input: {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly actorUserId: string;
  readonly node: string;
  readonly namespace: string;
  readonly podName: string;
  readonly reason: string;
}): Promise<{ readonly recovered: 0 | 1 }> {
  ensureSafeNamespace(input.namespace);

  let pod: RawPod;
  try {
    pod = (await input.k8s.core.readNamespacedPod({
      namespace: input.namespace,
      name: input.podName,
    })) as unknown as RawPod;
  } catch (err: unknown) {
    const status = (err as { statusCode?: number; code?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (status === 404) {
      // Already gone — idempotent success.
      await audit(input.db, input.actorUserId, 'node_health.recycle_pod.noop',
        input.node,
        { reason: input.reason, namespace: input.namespace, podName: input.podName, status: 'pod-not-found' });
      return { recovered: 0 };
    }
    throw err;
  }

  if (pod.spec?.nodeName !== input.node) {
    throw new ApiError(
      'RECOVERY_NODE_MISMATCH',
      `Pod '${input.namespace}/${input.podName}' is on node '${pod.spec?.nodeName}', not '${input.node}'.`,
      409,
      { expected: input.node, actual: pod.spec?.nodeName ?? null },
    );
  }

  if (isStatefulCnpgInstance(pod)) {
    throw new ApiError(
      'RECOVERY_REFUSED_CNPG_INSTANCE',
      `Refusing to delete CNPG instance pod '${input.namespace}/${input.podName}'. Use the CNPG failover flow instead.`,
      403,
      { pod: input.podName, instance: pod.metadata?.labels?.['cnpg.io/instance'] ?? null },
    );
  }

  await input.k8s.core.deleteNamespacedPod({
    namespace: input.namespace,
    name: input.podName,
    gracePeriodSeconds: 10,
  } as unknown as Parameters<typeof input.k8s.core.deleteNamespacedPod>[0]);

  await audit(input.db, input.actorUserId, 'node_health.recycle_pod',
    input.node,
    { reason: input.reason, namespace: input.namespace, podName: input.podName });

  return { recovered: 1 };
}

/**
 * Bulk-delete every pod on this node whose phase is Failed/Evicted/
 * ContainerStatusUnknown — the stale records that pile up after a
 * DiskPressure-driven eviction storm. Refuses to touch any pod
 * carrying `cnpg.io/instance` even if it's in a Failed state
 * (CNPG operator handles failover).
 */
export async function cleanStalePodsOnNode(input: {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly actorUserId: string;
  readonly node: string;
  readonly reason: string;
}): Promise<{ readonly recovered: number; readonly deleted: ReadonlyArray<string> }> {
  const list = (await input.k8s.core.listPodForAllNamespaces({
    fieldSelector: `spec.nodeName=${input.node}`,
  } as Parameters<typeof input.k8s.core.listPodForAllNamespaces>[0])) as unknown as {
    items?: ReadonlyArray<RawPod>;
  };

  const targets: Array<{ ns: string; name: string }> = [];
  for (const pod of list.items ?? []) {
    const ns = pod.metadata?.namespace ?? '';
    const name = pod.metadata?.name ?? '';
    if (!ns || !name) continue;
    if (ns.startsWith('client-')) continue;
    if (!SAFE_NAMESPACES.has(ns)) continue;
    if (isStatefulCnpgInstance(pod)) continue;

    const phase = pod.status?.phase ?? '';
    const reasonStr = pod.status?.reason ?? '';
    const hasUnknownState = (pod.status?.containerStatuses ?? []).some(
      (cs) => cs.state?.unknown !== undefined,
    );
    const isStale = phase === 'Failed' || reasonStr === 'Evicted' || hasUnknownState;
    if (!isStale) continue;

    targets.push({ ns, name });
  }

  const deleted: string[] = [];
  for (const t of targets) {
    try {
      await input.k8s.core.deleteNamespacedPod({
        namespace: t.ns,
        name: t.name,
        gracePeriodSeconds: 0,
      } as unknown as Parameters<typeof input.k8s.core.deleteNamespacedPod>[0]);
      deleted.push(`${t.ns}/${t.name}`);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status === 404) continue; // race — already gone
      console.error(
        `[node-health-recovery] delete failed for ${t.ns}/${t.name}:`,
        (err as Error).message,
      );
    }
  }

  await audit(input.db, input.actorUserId, 'node_health.clean_stale_pods', input.node, {
    reason: input.reason,
    deleted,
  });

  return { recovered: deleted.length, deleted };
}

/**
 * Delete the longhorn-csi-plugin pod on this node so its DaemonSet
 * replaces it; the new pod re-registers driver.longhorn.io with the
 * kubelet (CSINode). Use when the node-health monitor reports
 * `csiDriversMissing` includes `driver.longhorn.io`.
 */
export async function restartCsiPluginOnNode(input: {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly actorUserId: string;
  readonly node: string;
  readonly reason: string;
}): Promise<{ readonly recovered: 0 | 1; readonly podName: string | null }> {
  const list = (await input.k8s.core.listNamespacedPod({
    namespace: 'longhorn-system',
    labelSelector: 'app=longhorn-csi-plugin',
  } as Parameters<typeof input.k8s.core.listNamespacedPod>[0])) as unknown as {
    items?: ReadonlyArray<RawPod>;
  };

  const target = (list.items ?? []).find((p) => p.spec?.nodeName === input.node);
  if (!target) {
    await audit(input.db, input.actorUserId, 'node_health.restart_csi.noop', input.node, {
      reason: input.reason, status: 'pod-not-found',
    });
    return { recovered: 0, podName: null };
  }

  const podName = target.metadata?.name ?? '';
  if (!podName) return { recovered: 0, podName: null };

  await input.k8s.core.deleteNamespacedPod({
    namespace: 'longhorn-system',
    name: podName,
    gracePeriodSeconds: 5,
  } as unknown as Parameters<typeof input.k8s.core.deleteNamespacedPod>[0]);

  await audit(input.db, input.actorUserId, 'node_health.restart_csi', input.node, {
    reason: input.reason, podName,
  });

  return { recovered: 1, podName };
}

/**
 * Suppress the unused-import warning for sql/and/eq — they're kept
 * available for future recovery actions that need DB queries beyond
 * the simple insert above.
 */
export const _internalsForFutureUse = { sql, and, eq };
