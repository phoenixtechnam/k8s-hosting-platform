/**
 * ClusterTrustedRange CRUD service.
 *
 * Wraps CustomObjectsApi against the CTR CRD for list / get / create /
 * patch-description / delete. Translates cluster-error shapes into
 * ApiError with stable codes the UI can pattern-match. The reconciler
 * does authoritative IP/CIDR validation; this service only enforces the
 * api-contracts schema before write.
 *
 * Design notes:
 *  - cidr is IMMUTABLE post-create — the operator deletes + recreates
 *    if they want a different range. The CRD schema does not enforce
 *    this; the service does at the patch path.
 *  - The "addedBy" field is set from req.user.sub on POST; clients
 *    can't override.
 *  - status is reconciler-owned, never written by this service.
 */

import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  type TrustedRange,
  type CreateTrustedRangeRequest,
  type UpdateTrustedRangeRequest,
  trustedRangeSchema,
} from '@k8s-hosting/api-contracts';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
  CRD_GROUP,
  CRD_VERSION,
  CTR_PLURAL,
} from './k8s-client.js';

interface CrShape {
  readonly metadata?: {
    readonly name?: string;
    readonly creationTimestamp?: string;
  };
  readonly spec?: {
    readonly cidr?: string;
    readonly description?: string;
    readonly addedBy?: string;
  };
  readonly status?: {
    readonly normalizedCidr?: string;
    readonly family?: 'v4' | 'v6';
    readonly lastSyncedAt?: string;
    readonly conditions?: ReadonlyArray<{
      readonly type?: string;
      readonly status?: string;
      readonly reason?: string;
      readonly message?: string;
    }>;
  };
}

interface CrListShape {
  readonly items?: readonly CrShape[];
}

function toTrustedRange(cr: CrShape): TrustedRange {
  const ready = cr.status?.conditions?.find((c) => c.type === 'Ready');
  return trustedRangeSchema.parse({
    name: cr.metadata?.name ?? '',
    cidr: cr.spec?.cidr ?? '',
    description: cr.spec?.description ?? '',
    addedBy: cr.spec?.addedBy ?? '',
    normalizedCidr: cr.status?.normalizedCidr ?? null,
    family: cr.status?.family ?? null,
    lastSyncedAt: cr.status?.lastSyncedAt ?? null,
    ready: (ready?.status === 'True' || ready?.status === 'False' || ready?.status === 'Unknown')
      ? ready.status
      : 'Unknown',
    readyReason: ready?.reason ?? null,
    readyMessage: ready?.message ?? null,
    createdAt: cr.metadata?.creationTimestamp ?? new Date().toISOString(),
  });
}

export async function listTrustedRanges(
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<TrustedRange[]> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    const resp = (await c.custom.listClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CTR_PLURAL,
    } as unknown as Parameters<typeof c.custom.listClusterCustomObject>[0])) as CrListShape;
    return (resp.items ?? []).map(toTrustedRange);
  } catch (err) {
    throw mapK8sError(err, 'list ClusterTrustedRange');
  }
}

export async function createTrustedRange(
  req: CreateTrustedRangeRequest,
  addedBy: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<TrustedRange> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  const body = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: 'ClusterTrustedRange',
    metadata: { name: req.name },
    spec: {
      cidr: req.cidr,
      description: req.description ?? '',
      addedBy,
    },
  };
  try {
    const resp = (await c.custom.createClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CTR_PLURAL,
      body,
    } as unknown as Parameters<typeof c.custom.createClusterCustomObject>[0])) as CrShape;
    return toTrustedRange(resp);
  } catch (err) {
    if (statusOf(err) === 409) {
      throw new ApiError(
        'TRUSTED_RANGE_EXISTS',
        `ClusterTrustedRange "${req.name}" already exists. Pick a different name or delete the existing entry first.`,
        409,
      );
    }
    if (statusOf(err) === 422 || statusOf(err) === 400) {
      throw new ApiError(
        'TRUSTED_RANGE_INVALID',
        `ClusterTrustedRange validation failed at the CRD layer: ${msgOf(err)}`,
        400,
      );
    }
    throw mapK8sError(err, 'create ClusterTrustedRange');
  }
}

export async function updateTrustedRangeDescription(
  name: string,
  req: UpdateTrustedRangeRequest,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<TrustedRange> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  const patch = { spec: { description: req.description } };
  try {
    const resp = (await c.custom.patchClusterCustomObject(
      {
        group: CRD_GROUP,
        version: CRD_VERSION,
        plural: CTR_PLURAL,
        name,
        body: patch,
      } as unknown as Parameters<typeof c.custom.patchClusterCustomObject>[0],
      MERGE_PATCH,
    )) as CrShape;
    return toTrustedRange(resp);
  } catch (err) {
    if (statusOf(err) === 404) {
      throw new ApiError(
        'TRUSTED_RANGE_NOT_FOUND',
        `ClusterTrustedRange "${name}" not found`,
        404,
      );
    }
    throw mapK8sError(err, 'patch ClusterTrustedRange');
  }
}

export async function deleteTrustedRange(
  name: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<void> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  try {
    await c.custom.deleteClusterCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      plural: CTR_PLURAL,
      name,
    } as unknown as Parameters<typeof c.custom.deleteClusterCustomObject>[0]);
  } catch (err) {
    if (statusOf(err) === 404) {
      throw new ApiError(
        'TRUSTED_RANGE_NOT_FOUND',
        `ClusterTrustedRange "${name}" not found`,
        404,
      );
    }
    throw mapK8sError(err, 'delete ClusterTrustedRange');
  }
}

// ─── error helpers ────────────────────────────────────────────────────────

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
      `kube-API rejected ${op} (status ${status}). Verify platform-api ClusterRole has rights on networking.platform.phoenix-host.net resources.`,
      503,
    );
  }
  return new ApiError(
    'CLUSTER_NETWORK_K8S_ERROR',
    `${op} failed: ${msgOf(err)}`,
    503,
  );
}
