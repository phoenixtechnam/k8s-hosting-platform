/**
 * Node exposure toggle — flip a Node's
 * `platform.phoenix-host.net/exposure` label between "public" (default,
 * label absent) and "private". The label drives:
 *
 *   1. Scheduler affinity for ingress controllers + cert-manager
 *      solvers — they prefer `exposure!=private` (manifest patches).
 *      A private node can still run them if the cluster is small,
 *      but public nodes are preferred so external traffic terminates
 *      on the public surface.
 *
 *   2. Reconciler firewall chain — Phase 6.5 will add a private-node
 *      drop chain that gates 80/443/mail ports to cluster_peers +
 *      trusted_ranges only. Until then, the label is informational
 *      for scheduling.
 *
 * The endpoint writes the label directly via the kube-API; the
 * existing /admin/nodes service is DB-backed and only mirrors a
 * fixed list of fields, so we don't extend it.
 */

import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import { z } from 'zod';
import {
  loadClusterNetworkClients,
  type ClusterNetworkClients,
  type LoadOptions,
  EXPOSURE_LABEL,
  EXPOSURE_AUDIT_ANNOTATION,
} from './k8s-client.js';

export const setNodeExposureRequestSchema = z.object({
  exposure: z.enum(['public', 'private']),
});
export type SetNodeExposureRequest = z.infer<typeof setNodeExposureRequestSchema>;

export const setNodeExposureResponseSchema = z.object({
  name: z.string(),
  exposure: z.enum(['public', 'private']),
  changedBy: z.string(),
  changedAt: z.string().datetime(),
});
export type SetNodeExposureResponse = z.infer<typeof setNodeExposureResponseSchema>;

export async function setNodeExposure(
  name: string,
  req: SetNodeExposureRequest,
  changedBy: string,
  opts: LoadOptions = {},
  clients?: ClusterNetworkClients,
): Promise<SetNodeExposureResponse> {
  const c = clients ?? (await loadClusterNetworkClients(opts));
  // null on the label key clears it (semantic: public == absent label).
  const labelValue = req.exposure === 'private' ? 'private' : null;
  const changedAt = new Date().toISOString();
  const auditValue = `${changedBy}|${changedAt}|${req.exposure}`;
  const patch = {
    metadata: {
      labels: {
        [EXPOSURE_LABEL]: labelValue,
      },
      annotations: {
        [EXPOSURE_AUDIT_ANNOTATION]: auditValue,
      },
    },
  };
  try {
    await c.core.patchNode({ name, body: patch }, MERGE_PATCH);
    return setNodeExposureResponseSchema.parse({
      name,
      exposure: req.exposure,
      changedBy,
      changedAt,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
      ?? (err as { code?: number }).code;
    if (status === 404) {
      throw new ApiError('NODE_NOT_FOUND', `Node "${name}" not found`, 404);
    }
    if (status === 401 || status === 403) {
      throw new ApiError(
        'CLUSTER_NETWORK_FORBIDDEN',
        `kube-API rejected node patch (status ${status})`,
        503,
      );
    }
    throw new ApiError(
      'CLUSTER_NETWORK_K8S_ERROR',
      `patch Node ${name}: ${(err as Error).message}`,
      503,
    );
  }
}
