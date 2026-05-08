/**
 * ClusterPendingPeer CRUD service.
 *
 * Pre-authorise a node about to bootstrap. The reconciler unions
 * spec.ip with kube-API Node InternalIPs into cluster_peers_v{4,6}
 * nft sets on every existing node, opening the cluster-internal
 * control-plane ports so the new node's k3s join handshake reaches
 * :6443. Once the new node registers, the reconciler sets
 * status.claimedAt and deletes the CR after a 5-minute grace.
 *
 * The TTL (spec.ttlSeconds, default 1800, max 86400) is the operator's
 * estimate of how long bootstrap will take; the reconciler enforces it
 * by deleting unclaimed CRs whose creationTimestamp + ttl < now.
 */

import { ApiError } from '../../shared/errors.js';
import {
  type PendingPeer,
  type CreatePendingPeerRequest,
  pendingPeerSchema,
} from '@k8s-hosting/api-contracts';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
  CRD_GROUP,
  CRD_VERSION,
  CPP_PLURAL,
} from './k8s-client.js';

interface CppShape {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
  };
  readonly spec?: {
    readonly ip?: string;
    readonly hostname?: string;
    readonly role?: 'server' | 'worker';
    readonly ttlSeconds?: number;
    readonly addedBy?: string;
  };
  readonly status?: {
    readonly normalizedIp?: string;
    readonly family?: 'v4' | 'v6';
    readonly expiresAt?: string;
    readonly claimedAt?: string;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly reason?: string;
      readonly message?: string;
    }>;
  };
}

interface CppListShape {
  readonly items?: readonly CppShape[];
}

function toPendingPeer(cr: CppShape): PendingPeer {
  // status.conditions surfaces both Ready (Pending) and Claimed; the UI
  // wants the most-recent transition. Prefer Claimed if present, else
  // Ready, else Unknown.
  const conds = cr.status?.conditions ?? [];
  const claimed = conds.find((c) => c.type === 'Claimed');
  const ready = conds.find((c) => c.type === 'Ready');
  const surface = claimed ?? ready;

  return pendingPeerSchema.parse({
    name: cr.metadata?.name ?? '',
    ip: cr.spec?.ip ?? '',
    hostname: cr.spec?.hostname ?? '',
    role: cr.spec?.role ?? 'worker',
    ttlSeconds: cr.spec?.ttlSeconds ?? 1800,
    addedBy: cr.spec?.addedBy ?? '',
    normalizedIp: cr.status?.normalizedIp ?? null,
    family: cr.status?.family ?? null,
    expiresAt: cr.status?.expiresAt ?? null,
    claimedAt: cr.status?.claimedAt ?? null,
    ready: (surface?.status === 'True' || surface?.status === 'False' || surface?.status === 'Unknown')
      ? surface.status
      : 'Unknown',
    readyReason: surface?.reason ?? null,
    readyMessage: surface?.message ?? null,
    createdAt: cr.metadata?.creationTimestamp ?? new Date().toISOString(),
  });
}

export async function listPendingPeers(
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<PendingPeer[]> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    const resp = (await c.custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CPP_PLURAL,
    } as unknown as Parameters<typeof c.custom.listClusterCustomObject>[0])) as CppListShape;
    return (resp.items ?? []).map(toPendingPeer);
  } catch (err) {
    throw mapK8sError(err, 'list ClusterPendingPeer');
  }
}

export async function getPendingPeer(
  name: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<PendingPeer> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    const resp = (await c.custom.getClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CPP_PLURAL,
      name,
    } as unknown as Parameters<typeof c.custom.getClusterCustomObject>[0])) as CppShape;
    return toPendingPeer(resp);
  } catch (err) {
    if (statusOf(err) === 404) {
      throw new ApiError(
        'PENDING_PEER_NOT_FOUND',
        `ClusterPendingPeer "${name}" not found`,
        404,
      );
    }
    throw mapK8sError(err, 'get ClusterPendingPeer');
  }
}

export async function createPendingPeer(
  req: CreatePendingPeerRequest,
  addedBy: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<PendingPeer> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  const body = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'ClusterPendingPeer',
    metadata: { name: req.name },
    spec: {
      ip: req.ip,
      hostname: req.hostname ?? '',
      role: req.role,
      ttlSeconds: req.ttlSeconds,
      addedBy,
    },
  };
  try {
    const resp = (await c.custom.createClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CPP_PLURAL,
      body,
    } as unknown as Parameters<typeof c.custom.createClusterCustomObject>[0])) as CppShape;
    return toPendingPeer(resp);
  } catch (err) {
    if (statusOf(err) === 409) {
      throw new ApiError(
        'PENDING_PEER_EXISTS',
        `ClusterPendingPeer "${req.name}" already exists. Wait for TTL or delete the existing entry.`,
        409,
      );
    }
    if (statusOf(err) === 422 || statusOf(err) === 400) {
      throw new ApiError(
        'PENDING_PEER_INVALID',
        `ClusterPendingPeer validation failed at the CRD layer: ${msgOf(err)}`,
        400,
      );
    }
    throw mapK8sError(err, 'create ClusterPendingPeer');
  }
}

export async function deletePendingPeer(
  name: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<void> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    await c.custom.deleteClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CPP_PLURAL,
      name,
    } as unknown as Parameters<typeof c.custom.deleteClusterCustomObject>[0]);
  } catch (err) {
    if (statusOf(err) === 404) {
      throw new ApiError(
        'PENDING_PEER_NOT_FOUND',
        `ClusterPendingPeer "${name}" not found`,
        404,
      );
    }
    throw mapK8sError(err, 'delete ClusterPendingPeer');
  }
}

// ─── error helpers (duplicated from cluster-trusted-ranges to keep
// the modules independent; consolidating into a shared util adds
// import-cycle pressure for negligible payoff) ────────────────────────

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode
    ?? (err as { code?: number }).code;
}

function msgOf(err: unknown): string {
  return (err as { message?: string }).message ?? String(err);
}

function mapK8sError(err: unknown, op: string): ApiError {
  if (err instanceof ApiError) return err;
  const status = statusOf(err);
  if (status === 401 || status === 403) {
    return new ApiError(
      'CLUSTER_NETWORK_FORBIDDEN',
      `kube-API rejected ${op} (status ${status})`,
      503,
    );
  }
  return new ApiError(
    'CLUSTER_NETWORK_K8S_ERROR',
    `${op} failed: ${msgOf(err)}`,
    503,
  );
}
