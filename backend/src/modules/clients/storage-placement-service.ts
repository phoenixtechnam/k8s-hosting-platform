/**
 * Live tenant storage tier + worker placement.
 *
 * - Tier change (local ↔ ha) patches Volume.spec.numberOfReplicas on
 *   the tenant's Longhorn Volume CR. Same pattern the platform uses
 *   for the system tier (M13). PVC.storageClassName is immutable, so
 *   we cannot change tier by swapping SCs — the platform now uses ONE
 *   tenant SC (longhorn-tenant) and treats tier as a per-volume setting.
 *
 * - Worker pin auto-pick: if the operator selects "Auto" at provisioning
 *   for a Local-tier client, we pick the host-client-workloads node
 *   with the most free Longhorn capacity and persist that choice. HA
 *   tier may stay null (= scheduler picks freely).
 *
 * - The workload's nodeAffinity is updated in-step with tier changes
 *   (hard nodeSelector → soft preferred when going local→ha; the
 *   reverse going ha→local). Required so HA pods can fail over and
 *   Local pods stay co-located with their single replica.
 */

import { eq, sql } from 'drizzle-orm';
import { clients, deployments, clusterNodes, hostingPlans } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { patchTenantVolumeReplicas } from '../k8s-provisioner/service.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

const HA_REPLICAS = 2;
const LOCAL_REPLICAS = 1;

export interface NodeCapacityForPick {
  readonly name: string;
  /** bytes free across allowScheduling=true disks on this node */
  readonly freeBytes: number;
  /** can this node host client workloads? */
  readonly tenantCapable: boolean;
}

interface DiskStatus {
  storageMaximum?: number;
  storageScheduled?: number;
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

/**
 * Auto-pick a worker node for a Local-tier client at provisioning.
 * Strategy: among host-client-workloads nodes, pick the one with the
 * MOST free Longhorn-schedulable bytes. Tie-break alphabetically for
 * determinism. Returns null if Longhorn is unavailable or no eligible
 * node exists — caller falls back to leaving workerNodeName null
 * (scheduler picks freely).
 */
export async function autoPickWorkerNode(
  db: Database,
  k8s: K8sClients,
): Promise<string | null> {
  let nodes: NodeCapacityForPick[] = [];
  try {
    const lhResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]);
    const items = ((lhResp as { items?: LhNode[] }).items ?? []);
    const platformNodes = await db.select().from(clusterNodes);
    const tenantCapable = new Map(platformNodes.map((n) => [n.name, n.canHostClientWorkloads]));

    for (const lh of items) {
      const name = lh.metadata?.name;
      if (!name) continue;
      if (lh.spec?.allowScheduling === false) continue;
      if (tenantCapable.size > 0 && tenantCapable.get(name) !== true) continue;
      let free = 0;
      for (const [diskKey, diskSpec] of Object.entries(lh.spec?.disks ?? {})) {
        if (diskSpec.allowScheduling === false) continue;
        const stat = lh.status?.diskStatus?.[diskKey] ?? {};
        free += Math.max(0, (stat.storageMaximum ?? 0) - (stat.storageScheduled ?? 0) - (diskSpec.storageReserved ?? 0));
      }
      nodes.push({ name, freeBytes: free, tenantCapable: true });
    }
  } catch {
    return null;
  }
  nodes = nodes.sort((a, b) => b.freeBytes - a.freeBytes || a.name.localeCompare(b.name));
  return nodes[0]?.name ?? null;
}

export interface ApplyTierResult {
  readonly clientId: string;
  readonly previousTier: 'local' | 'ha';
  readonly newTier: 'local' | 'ha';
  readonly volumeReplicasPatched: boolean;
  readonly deploymentsAffinityPatched: number;
}

/**
 * Apply a tenant storage tier change LIVE.
 *   1. Patch the tenant Volume CR's numberOfReplicas (Longhorn rebuilds
 *      replicas async in the background — no IO interruption).
 *   2. Flip every tenant Deployment's nodeAffinity:
 *        local → hard nodeSelector
 *        ha    → soft preferred affinity
 *      So HA pods can actually fail over when the pin node dies.
 *   3. Persist clients.storage_tier.
 *
 * Idempotent: invoking with the same tier flips nothing. Throws
 * ApiError on bad inputs (unknown client, invalid tier).
 */
export async function applyTenantTier(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  newTier: 'local' | 'ha',
): Promise<ApplyTierResult> {
  if (newTier !== 'local' && newTier !== 'ha') {
    throw new ApiError('INVALID_FIELD_VALUE', `tier must be 'local' or 'ha'`, 400);
  }
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client ${clientId} not found`, 404);
  }
  const previousTier = (client.storageTier ?? 'local') as 'local' | 'ha';
  if (!client.kubernetesNamespace) {
    throw new ApiError('CLIENT_NOT_PROVISIONED', `Client ${clientId} has no namespace yet`, 409);
  }

  let volumeReplicasPatched = false;
  if (previousTier !== newTier) {
    const target = newTier === 'ha' ? HA_REPLICAS : LOCAL_REPLICAS;
    try {
      await patchTenantVolumeReplicas(k8s, client.kubernetesNamespace, target);
      volumeReplicasPatched = true;
    } catch (err) {
      // Volume not bound yet (pre-provision) or Longhorn unreachable.
      // Caller can retry; we still flip the DB flag so future
      // provision picks up the new tier.
      console.warn(`[applyTenantTier] volume replica patch failed: ${(err as Error).message}`);
    }
  }

  // Patch every Deployment in the namespace owned by this client. We
  // use a strategic merge that REPLACES the spec.template.spec.affinity
  // and nodeSelector blocks together — going local→ha removes the hard
  // pin AND adds the soft one; going ha→local does the inverse.
  const tenantDeploys = await db.select({ id: deployments.id, name: deployments.name })
    .from(deployments)
    .where(eq(deployments.clientId, clientId));

  let patchedCount = 0;
  if (k8s && tenantDeploys.length > 0 && client.workerNodeName) {
    const ns = client.kubernetesNamespace;
    const nodeSelector = newTier === 'ha' ? null : { 'kubernetes.io/hostname': client.workerNodeName };
    const affinity = newTier === 'ha'
      ? {
        nodeAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [{
            weight: 100,
            preference: {
              matchExpressions: [{
                key: 'kubernetes.io/hostname',
                operator: 'In',
                values: [client.workerNodeName],
              }],
            },
          }],
        },
      }
      : null;

    for (const d of tenantDeploys) {
      try {
        await k8s.apps.patchNamespacedDeployment({
          name: d.name,
          namespace: ns,
          body: {
            spec: {
              template: {
                spec: {
                  // Strategic merge: passing null clears the field.
                  nodeSelector,
                  affinity,
                },
              },
            },
          },
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
          STRATEGIC_MERGE_PATCH);
        patchedCount++;
      } catch (err) {
        // Deployment may not exist in k8s yet (DB row only — workload
        // never deployed). Skip.
        const status = (err as { code?: number; statusCode?: number }).code
          ?? (err as { statusCode?: number }).statusCode;
        if (status !== 404) {
          console.warn(`[applyTenantTier] failed to patch ${ns}/${d.name}: ${(err as Error).message}`);
        }
      }
    }
  }

  await db.update(clients)
    .set({ storageTier: newTier, updatedAt: sql`now()` })
    .where(eq(clients.id, clientId));

  return {
    clientId,
    previousTier,
    newTier,
    volumeReplicasPatched,
    deploymentsAffinityPatched: patchedCount,
  };
}

/**
 * Resolve a "free vs total" capacity summary for every host-client-
 * workloads node. Drives the worker-selector dropdown. Returns absolute
 * numbers in bytes / millicores so the UI can format them with full
 * precision (e.g. "3.25/6 CPUs"). Skips Longhorn lookups when k8s is
 * unavailable; the UI shows "—" in that case.
 */
export interface NodeUsageSummary {
  name: string;
  displayName: string | null;
  cpuMillicoresAllocatable: number | null;
  cpuMillicoresUsed: number | null;
  memoryBytesAllocatable: number | null;
  memoryBytesUsed: number | null;
  diskBytesTotal: number | null;
  diskBytesFree: number | null;
}

export async function listWorkerCandidatesWithUsage(
  db: Database,
  k8s: K8sClients | undefined,
): Promise<NodeUsageSummary[]> {
  const platformNodes = await db.select().from(clusterNodes);
  const candidates = platformNodes.filter((n) => n.canHostClientWorkloads);
  // Build initial view from clusterNodes (cpu / memory metrics already
  // tracked by the node-sync reconciler).
  const result: NodeUsageSummary[] = candidates.map((n) => ({
    name: n.name,
    displayName: n.displayName ?? null,
    cpuMillicoresAllocatable: n.cpuMillicores ?? null,
    cpuMillicoresUsed: n.cpuRequestsMillicores ?? null,
    memoryBytesAllocatable: n.memoryBytes != null ? Number(n.memoryBytes) : null,
    memoryBytesUsed: n.memoryRequestsBytes != null ? Number(n.memoryRequestsBytes) : null,
    diskBytesTotal: null,
    diskBytesFree: null,
  }));

  if (!k8s) return result;

  // Layer in Longhorn disk capacity per node.
  try {
    const lhResp = await k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'nodes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0]);
    const items = ((lhResp as { items?: LhNode[] }).items ?? []);
    const byName = new Map(items.map((n) => [n.metadata?.name ?? '', n]));
    for (const r of result) {
      const lh = byName.get(r.name);
      if (!lh) continue;
      let total = 0;
      let scheduled = 0;
      let reserved = 0;
      for (const [k, diskSpec] of Object.entries(lh.spec?.disks ?? {})) {
        const stat = lh.status?.diskStatus?.[k] ?? {};
        total += stat.storageMaximum ?? 0;
        scheduled += stat.storageScheduled ?? 0;
        reserved += diskSpec.storageReserved ?? 0;
      }
      r.diskBytesTotal = total;
      r.diskBytesFree = Math.max(0, total - scheduled - reserved);
    }
  } catch {
    // Best-effort — leave disk fields null; the UI falls back to "—".
  }

  // For HA preflight UX: also include hostingPlans table size hints so
  // the UI can color a row red when free disk < typical plan size. Not
  // implemented here — that's a UI decision, not a data one. Just
  // return raw numbers.
  void hostingPlans;
  return result;
}
