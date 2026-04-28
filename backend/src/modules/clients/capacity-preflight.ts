/**
 * Capacity preflight for client create.
 *
 * Phase G: before we accept a new client and start provisioning, check
 * whether Longhorn actually has room for their PVCs. The platform was
 * happily accepting clients onto a cluster that couldn't physically
 * fit them; the failure surfaced minutes later as a stuck FM pod with
 * "precheck new replica failed: insufficient storage" — by which point
 * the operator has already told the new client their account is ready.
 *
 * What this checks:
 *   - For storage_tier='local': at least ONE node with
 *     freeToSchedule >= planSize.
 *   - For storage_tier='ha': at least N nodes (numberOfReplicas) each
 *     with freeToSchedule >= planSize. Longhorn places one replica
 *     per node; if there aren't N nodes that can each take a copy,
 *     replica scheduling will fail.
 *
 * What this does NOT check:
 *   - Per-disk vs per-node aggregate (we sum across disks per node).
 *   - System-tagged exclusion: tenant SC has no nodeSelector so all
 *     schedulable nodes count.
 *   - allowScheduling=false on individual disks — those are filtered
 *     out before summing.
 */

import type { Database } from '../../db/index.js';
import { hostingPlans, clusterNodes } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface DiskStatus {
  storageMaximum?: number;
  storageScheduled?: number;
  storageAvailable?: number;
}

interface DiskSpec {
  storageReserved?: number;
  allowScheduling?: boolean;
}

interface LhNode {
  metadata?: { name?: string };
  spec?: { disks?: Record<string, DiskSpec>; allowScheduling?: boolean };
  status?: { diskStatus?: Record<string, DiskStatus> };
}

interface NodeCapacity {
  readonly nodeName: string;
  /** sum of (storageMaximum - storageScheduled - storageReserved) across allowScheduling=true disks, in bytes */
  readonly freeToScheduleBytes: number;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly required: { tier: 'local' | 'ha'; replicaCount: number; planSizeBytes: number };
  readonly nodes: readonly NodeCapacity[];
  readonly fittingNodes: number;
  readonly reason?: string;
}

const GIB = 1024 ** 3;

export async function checkProvisioningCapacity(
  db: Database,
  k8s: K8sClients | undefined,
  planId: string,
  storageTier: 'local' | 'ha',
): Promise<PreflightResult> {
  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, planId));
  if (!plan) {
    return {
      ok: false,
      required: { tier: storageTier, replicaCount: 0, planSizeBytes: 0 },
      nodes: [],
      fittingNodes: 0,
      reason: `plan ${planId} not found`,
    };
  }
  const planSizeGiB = Number(plan.storageLimit);
  if (!Number.isFinite(planSizeGiB) || planSizeGiB <= 0) {
    return {
      ok: false,
      required: { tier: storageTier, replicaCount: 0, planSizeBytes: 0 },
      nodes: [],
      fittingNodes: 0,
      reason: `plan ${planId} has invalid storage_limit ${plan.storageLimit}`,
    };
  }
  const planSizeBytes = Math.ceil(planSizeGiB * GIB);
  const replicaCount = storageTier === 'ha' ? 3 : 1;

  // No K8s client (unit tests, broken kubeconfig) — skip preflight,
  // don't block client creation. The original failure-on-provision
  // behavior remains the fallback.
  if (!k8s) {
    return {
      ok: true,
      required: { tier: storageTier, replicaCount, planSizeBytes },
      nodes: [],
      fittingNodes: 0,
      reason: 'k8s client unavailable; preflight skipped',
    };
  }

  const nodes: NodeCapacity[] = [];
  try {
    const lhResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]);
    const items = ((lhResp as { items?: LhNode[] }).items ?? []);

    // Cross-check against platform's clusterNodes table for
    // canHostClientWorkloads — Longhorn nodes are visible even on
    // server-only nodes that don't accept tenant pods.
    const platformNodes = await db.select().from(clusterNodes);
    const tenantCapable = new Set(
      platformNodes.filter((n) => n.canHostClientWorkloads).map((n) => n.name),
    );

    for (const lhNode of items) {
      const name = lhNode.metadata?.name;
      if (!name) continue;
      // If we have platform info on this node, skip if it's not tenant-capable.
      if (tenantCapable.size > 0 && !tenantCapable.has(name)) continue;
      // Cluster-level scheduling disabled for the node: don't count it.
      if (lhNode.spec?.allowScheduling === false) continue;

      let nodeFree = 0;
      for (const [diskKey, diskSpec] of Object.entries(lhNode.spec?.disks ?? {})) {
        if (diskSpec.allowScheduling === false) continue;
        const diskStat = lhNode.status?.diskStatus?.[diskKey] ?? {};
        const max = diskStat.storageMaximum ?? 0;
        const scheduled = diskStat.storageScheduled ?? 0;
        const reserved = diskSpec.storageReserved ?? 0;
        nodeFree += Math.max(0, max - scheduled - reserved);
      }
      nodes.push({ nodeName: name, freeToScheduleBytes: nodeFree });
    }
  } catch (err) {
    // Longhorn CRD missing (dev cluster), API unreachable, etc.
    // Fail open — let the operator try.
    return {
      ok: true,
      required: { tier: storageTier, replicaCount, planSizeBytes },
      nodes: [],
      fittingNodes: 0,
      reason: `longhorn unavailable: ${(err as Error).message}; preflight skipped`,
    };
  }

  const fittingNodes = nodes.filter((n) => n.freeToScheduleBytes >= planSizeBytes).length;

  if (fittingNodes >= replicaCount) {
    return {
      ok: true,
      required: { tier: storageTier, replicaCount, planSizeBytes },
      nodes,
      fittingNodes,
    };
  }

  return {
    ok: false,
    required: { tier: storageTier, replicaCount, planSizeBytes },
    nodes,
    fittingNodes,
    reason: storageTier === 'ha'
      ? `HA tier needs ${replicaCount} nodes each with ≥${planSizeGiB} GiB free; only ${fittingNodes} qualify`
      : `Local tier needs ≥${planSizeGiB} GiB free on at least one node; none qualify`,
  };
}
