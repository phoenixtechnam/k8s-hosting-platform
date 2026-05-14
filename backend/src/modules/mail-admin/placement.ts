/**
 * Mail placement policy — primary/secondary/tertiary node assignment + DR state.
 *
 * Stores the operator's preferred node assignments in system_settings and
 * provides a candidate-node listing from the cluster.
 *
 * **Node-role policy:** any node with role `server` OR `worker` is a valid
 * candidate. Stalwart can run on either:
 *   - server-role nodes: typically the case (haproxy DS also runs here for
 *     allServerNodes mode, so all mail traffic stays on the same set of
 *     publicly-reachable hosts).
 *   - worker-role nodes: also supported. Stalwart pod lands on the worker;
 *     in thisNodeOnly mode the worker's hostPorts serve mail directly;
 *     in allServerNodes mode haproxy on the 3 server nodes forwards via
 *     ClusterIP+PROXY-v2 to the Stalwart pod on the worker. The PROXY-v2
 *     trust list (SystemSettings.proxyTrustedNetworks) is maintained by
 *     the proxy-networks reconciler from server-role node IPs — so the
 *     same trust set works regardless of where Stalwart lives.
 *
 * The DR state machine (failing-over / failed-over / failing-back) is
 * advanced by Phase 5's failover scheduler; this module is read/write only
 * for the placement policy itself.
 *
 * GET  /admin/mail/placement  → MailPlacementResponse
 * PATCH /admin/mail/placement → 204
 */

import { eq } from 'drizzle-orm';
import { ApiError } from '../../shared/errors.js';
import { systemSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  type MailPlacementResponse,
  type NodeCandidate,
  mailPlacementResponseSchema,
} from '@k8s-hosting/api-contracts';

const SETTINGS_ID = 'system';
const MAIL_NAMESPACE = 'mail';
const NODE_ROLE_LABEL_KEY = 'platform.phoenix-host.net/node-role';
const ELIGIBLE_NODE_ROLES = new Set(['server', 'worker']);

export interface PlacementOptions {
  readonly kubeconfigPath: string | undefined;
}

interface K8sCoreBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
}

async function loadK8sCoreClient(kubeconfigPath: string | undefined): Promise<K8sCoreBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return { core: kc.makeApiClient(k8s.CoreV1Api) };
}

// Parse K8s memory quantity strings like "16296Mi", "2Gi", "1024Ki" to bytes.
function parseMemQuantity(q: string): number {
  const m = q.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2] ?? '';
  const multiplier: Record<string, number> = {
    Ki: 1024,
    Mi: 1048576,
    Gi: 1073741824,
    Ti: 1099511627776,
    K: 1000,
    M: 1000000,
    G: 1000000000,
    T: 1000000000000,
  };
  return Math.round(n * (multiplier[unit] ?? 1));
}

/**
 * Read the current placement policy from system_settings and list
 * candidate server-role nodes from the cluster.
 */
export async function getMailPlacement(
  db: Database,
  opts: PlacementOptions,
): Promise<MailPlacementResponse> {
  const { core } = await loadK8sCoreClient(opts.kubeconfigPath);

  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.id, SETTINGS_ID));

  // Gather candidate nodes — fetch all and filter to server-role in code
  // (listNode labelSelector is not stable across SDK versions).
  type NodeShape = {
    metadata?: { labels?: Record<string, string>; name?: string };
    status?: {
      conditions?: Array<{ type: string; status: string }>;
      allocatable?: Record<string, string>;
      capacity?: Record<string, string>;
    };
  };
  let candidates: NodeCandidate[] = [];
  try {
    const nodeList = await core.listNode({}) as { items?: NodeShape[] };
    candidates = (nodeList.items ?? [])
      .map((n) => {
        const role = n.metadata?.labels?.[NODE_ROLE_LABEL_KEY] ?? '';
        if (!ELIGIBLE_NODE_ROLES.has(role)) return null;
        const hostname =
          n.metadata?.labels?.['kubernetes.io/hostname'] ??
          n.metadata?.name ??
          '';
        if (!hostname) return null;
        const readyCondition = n.status?.conditions?.find((c) => c.type === 'Ready');
        const ready = readyCondition?.status === 'True';
        const memStr = n.status?.allocatable?.['memory'] ?? '0';
        const freeMemoryBytes = parseMemQuantity(memStr);
        // Use ephemeral-storage as the disk-capacity proxy. The kubelet
        // reports allocatable.ephemeral-storage = total minus reserved-
        // for-system pods — which is the headroom available to schedule
        // new workloads (incl. a relocated Stalwart). It's a static
        // capacity-level number (not "live free bytes used right now")
        // but matches operator intent for "can this node host
        // Stalwart?" better than the previous hardcoded 0. Falls back
        // to capacity.ephemeral-storage if allocatable isn't set.
        const diskStr =
          n.status?.allocatable?.['ephemeral-storage']
          ?? n.status?.capacity?.['ephemeral-storage']
          ?? '0';
        const freeDiskBytes = parseMemQuantity(diskStr);
        return { hostname, freeMemoryBytes, freeDiskBytes, role, ready };
      })
      .filter((c): c is NodeCandidate => c !== null);
  } catch {
    // Best-effort — a missing or unreachable k8s API just returns
    // an empty candidate list. The operator still sees the stored policy.
  }

  return mailPlacementResponseSchema.parse({
    primaryNode: row?.mailPrimaryNode ?? null,
    secondaryNode: row?.mailSecondaryNode ?? null,
    tertiaryNode: row?.mailTertiaryNode ?? null,
    activeNode: row?.mailActiveNode ?? null,
    drState: row?.mailDrState ?? 'healthy',
    autoFailoverEnabled: row?.mailAutoFailoverEnabled ?? false,
    failoverThresholdSeconds: row?.mailFailoverThresholdSeconds ?? 300,
    lastFailoverAt: row?.mailLastFailoverAt?.toISOString() ?? null,
    portExposureMode: row?.mailPortExposureMode ?? 'thisNodeOnly',
    candidateNodes: candidates,
  });
}

/**
 * Update the placement policy in system_settings.
 * Validates that named nodes exist in the cluster before persisting.
 */
export async function updateMailPlacement(
  update: {
    primaryNode?: string | null;
    secondaryNode?: string | null;
    tertiaryNode?: string | null;
    autoFailoverEnabled?: boolean;
    failoverThresholdSeconds?: number;
  },
  db: Database,
  opts: PlacementOptions,
): Promise<void> {
  const { core } = await loadK8sCoreClient(opts.kubeconfigPath);

  // Validate that each named node exists in the cluster.
  for (const nodeName of [update.primaryNode, update.secondaryNode, update.tertiaryNode]) {
    if (nodeName) {
      try {
        await core.readNode({ name: nodeName });
      } catch (err) {
        const code =
          (err as { statusCode?: number; code?: number }).statusCode ??
          (err as { code?: number }).code;
        if (code === 404) {
          throw new ApiError(
            'MAIL_NODE_NOT_FOUND',
            `Node '${nodeName}' does not exist in the cluster`,
            404,
          );
        }
        throw new ApiError(
          'MAIL_PLACEMENT_NODE_LOOKUP_FAILED',
          `Could not verify node '${nodeName}': ${(err as Error).message ?? String(err)}`,
          500,
        );
      }
    }
  }

  const patch: Partial<typeof systemSettings.$inferInsert> = {};
  if ('primaryNode' in update) patch.mailPrimaryNode = update.primaryNode ?? null;
  if ('secondaryNode' in update) patch.mailSecondaryNode = update.secondaryNode ?? null;
  if ('tertiaryNode' in update) patch.mailTertiaryNode = update.tertiaryNode ?? null;
  if ('autoFailoverEnabled' in update) patch.mailAutoFailoverEnabled = update.autoFailoverEnabled;
  if ('failoverThresholdSeconds' in update)
    patch.mailFailoverThresholdSeconds = update.failoverThresholdSeconds;

  await db.update(systemSettings).set(patch).where(eq(systemSettings.id, SETTINGS_ID));
}

/**
 * Pick the best available failover target node — highest free memory
 * among ready nodes that are NOT the excluded (currently failing) node.
 * Throws MAIL_PLACEMENT_NO_CANDIDATE when no eligible node is found.
 */
export async function pickBestFailoverNode(
  excludeNode: string | null,
  candidates: NodeCandidate[],
): Promise<string> {
  const eligible = candidates.filter((c) => c.ready && c.hostname !== excludeNode);
  if (eligible.length === 0) {
    throw new ApiError(
      'MAIL_PLACEMENT_NO_CANDIDATE',
      'No eligible failover node available',
      409,
    );
  }
  // Sort by free memory descending — higher memory = more headroom.
  const sorted = [...eligible].sort((a, b) => b.freeMemoryBytes - a.freeMemoryBytes);
  return sorted[0].hostname;
}

// Expose MAIL_NAMESPACE so port-exposure can use the same constant.
export { MAIL_NAMESPACE };
