import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { sql } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import { getRedis } from '../../shared/redis.js';
import type {
  StorageOverviewResponse,
  ImageInventoryResponse,
  ImageEntry,
  PurgeImagesResponse,
} from '@k8s-hosting/api-contracts';

// ─── Image Classification ────────────────────────────────────────────────────

/**
 * Prefixes for images that are part of platform infrastructure.
 * These images MUST NEVER be purged — removing them would break the platform.
 */
const PROTECTED_PREFIXES: readonly string[] = [
  'hosting-platform-',
  'k8s-hosting-platform-',
  'file-manager-sidecar',
  'rancher/',
  'registry.k8s.io/',
  'ghcr.io/dexidp/',
  'docker.io/rancher/',
  'docker.io/library/busybox', // Used by init containers
  'docker.io/library/file-manager-sidecar',
];

export interface ClassifiedImage {
  readonly protected: boolean;
}

/**
 * Determine whether an image name matches any protected prefix.
 */
export function classifyImage(name: string): ClassifiedImage {
  // Normalize: strip docker.io/library/ prefix if present for matching
  const normalized = name.replace(/^docker\.io\/library\//, '');

  const isProtected = PROTECTED_PREFIXES.some(prefix => {
    // Match against both the normalized name and the original
    return normalized.startsWith(prefix) || name.startsWith(prefix);
  });

  return { protected: isProtected };
}

// ─── Image Name Formatting ───────────────────────────────────────────────────

/**
 * Format an image name for display — strip docker.io/library/ prefix for cleaner UI.
 */
export function formatImageName(name: string): string {
  return name.replace(/^docker\.io\/library\//, '');
}

// ─── Node Images Parsing ─────────────────────────────────────────────────────

interface RawNodeImage {
  readonly names?: readonly string[] | null;
  readonly sizeBytes?: number;
}

interface ParsedImage {
  readonly name: string;
  readonly sizeBytes: number;
}

/**
 * Parse K8s node.status.images into normalized entries.
 * Prefers human-readable tags over digest-only names.
 */
export function parseNodeImages(nodeImages: readonly RawNodeImage[]): readonly ParsedImage[] {
  const result: ParsedImage[] = [];

  for (const img of nodeImages) {
    const names = img.names ?? [];
    if (names.length === 0) continue;

    // Prefer a name with ':' (tag) over a digest-only name ('@sha256:')
    const tagName = names.find(n => n.includes(':') && !n.includes('@sha256'));
    const name = tagName ?? names[0];

    result.push({
      name,
      sizeBytes: img.sizeBytes ?? 0,
    });
  }

  return result;
}

// ─── Purge Filtering ─────────────────────────────────────────────────────────

/**
 * Filter images to only those that are safe to purge:
 * - Not protected (not a platform/system image)
 * - Not currently in use by any pod
 */
export function filterPurgeableImages(images: readonly ImageEntry[]): readonly ImageEntry[] {
  return images.filter(img => !img.protected && !img.inUse);
}

// ─── Node Storage Stats ──────────────────────────────────────────────────────

interface NodeStats {
  readonly name: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
}

async function getNodeStats(k8s: K8sClients): Promise<NodeStats> {
  try {
    const nodeList = await k8s.core.listNode();
    const nodes = (nodeList as { items?: readonly { metadata?: { name?: string }; status?: { capacity?: Record<string, string>; allocatable?: Record<string, string> } }[] }).items ?? [];
    if (nodes.length === 0) {
      return { name: 'unknown', totalBytes: 0, usedBytes: 0, availableBytes: 0 };
    }
    const node = nodes[0];
    const capacity = node.status?.capacity ?? {};
    const totalStorage = parseK8sStorage(capacity['ephemeral-storage'] ?? '0');
    // Without metrics-server node stats, we can't get exact used bytes
    return {
      name: node.metadata?.name ?? 'unknown',
      totalBytes: totalStorage,
      usedBytes: 0,
      availableBytes: totalStorage,
    };
  } catch {
    return { name: 'unknown', totalBytes: 0, usedBytes: 0, availableBytes: 0 };
  }
}

function parseK8sStorage(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) return parseInt(value, 10) || 0;
  const num = parseFloat(match[1]);
  const unit = match[2] ?? '';
  const multipliers: Record<string, number> = {
    '': 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return Math.round(num * (multipliers[unit] ?? 1));
}

// ─── Redis Memory ────────────────────────────────────────────────────────────

async function getRedisUsedBytes(): Promise<number> {
  try {
    const redis = getRedis();
    // ioredis supports the info() method; fall back gracefully
    type RedisWithInfo = { info?: (section?: string) => Promise<string> };
    const redisWithInfo = redis as RedisWithInfo;
    if (typeof redisWithInfo.info !== 'function') return 0;
    const info = await redisWithInfo.info('memory');
    const match = info.match(/used_memory:(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

// ─── PostgreSQL Database Size ────────────────────────────────────────────────

async function getPlatformDbUsedBytes(db: Database): Promise<number> {
  try {
    const result = await db.execute(sql`SELECT pg_database_size(current_database()) AS size`);
    const rows = (result as unknown as { rows?: Array<{ size: string | number }> }).rows
      ?? (result as unknown as Array<{ size: string | number }>);
    if (rows && rows.length > 0) {
      const size = rows[0].size;
      return typeof size === 'string' ? parseInt(size, 10) : size;
    }
    return 0;
  } catch {
    return 0;
  }
}

// ─── Per-Client Storage Usage ────────────────────────────────────────────────

async function getClientStorageUsage(
  db: Database,
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
): Promise<StorageOverviewResponse['clients']> {
  const allClients = await db.select().from(clients);
  const results: StorageOverviewResponse['clients'] = [];

  for (const c of allClients) {
    if (!c.kubernetesNamespace || c.provisioningStatus !== 'provisioned') continue;

    let usedBytes = 0;
    try {
      const { proxyToFileManager } = await import('../file-manager/service.js');
      const result = await proxyToFileManager(kubeconfigPath, c.kubernetesNamespace, '/disk-usage');
      if (result.status === 200) {
        const data = JSON.parse(result.body) as { usedBytes?: number };
        usedBytes = data.usedBytes ?? 0;
      }
    } catch {
      // File manager not running — leave at 0
    }

    results.push({
      clientId: c.id,
      companyName: c.companyName,
      namespace: c.kubernetesNamespace,
      usedBytes,
    });
  }

  // Avoid unused import warning if k8s isn't referenced directly
  void k8s;

  return results;
}

// ─── Docker Images Summary (from Node Status) ────────────────────────────────

async function getNodeImagesSummary(k8s: K8sClients): Promise<{ totalBytes: number; count: number }> {
  try {
    const nodeList = await k8s.core.listNode();
    const nodes = (nodeList as { items?: readonly { status?: { images?: readonly RawNodeImage[] } }[] }).items ?? [];
    let total = 0;
    let count = 0;
    for (const node of nodes) {
      const images = node.status?.images ?? [];
      count += images.length;
      for (const img of images) {
        total += img.sizeBytes ?? 0;
      }
    }
    return { totalBytes: total, count };
  } catch {
    return { totalBytes: 0, count: 0 };
  }
}

// ─── Main Overview Function ──────────────────────────────────────────────────

export async function getStorageOverview(
  db: Database,
  k8s: K8sClients,
  kubeconfigPath: string | undefined,
): Promise<StorageOverviewResponse> {
  const [node, platformDbBytes, redisBytes, imagesSummary, clientUsage] = await Promise.all([
    getNodeStats(k8s),
    getPlatformDbUsedBytes(db),
    getRedisUsedBytes(),
    getNodeImagesSummary(k8s),
    getClientStorageUsage(db, k8s, kubeconfigPath),
  ]);

  const systemBytes = platformDbBytes + redisBytes + imagesSummary.totalBytes;
  const clientBytes = clientUsage.reduce((sum, c) => sum + c.usedBytes, 0);

  return {
    node,
    system: {
      platformDatabase: { usedBytes: platformDbBytes },
      redis: { usedBytes: redisBytes },
      dockerImages: { totalBytes: imagesSummary.totalBytes, count: imagesSummary.count },
    },
    clients: clientUsage,
    total: { systemBytes, clientBytes },
  };
}

// ─── Image Inventory ─────────────────────────────────────────────────────────

async function getInUseImages(k8s: K8sClients): Promise<Set<string>> {
  const inUse = new Set<string>();
  try {
    const podList = await k8s.core.listPodForAllNamespaces();
    type PodContainer = { readonly image?: string };
    type Pod = {
      readonly spec?: {
        readonly containers?: readonly PodContainer[];
        readonly initContainers?: readonly PodContainer[];
      };
      readonly status?: {
        readonly containerStatuses?: readonly { readonly image?: string; readonly imageID?: string }[];
        readonly initContainerStatuses?: readonly { readonly image?: string; readonly imageID?: string }[];
      };
    };
    const pods = (podList as { items?: readonly Pod[] }).items ?? [];
    for (const pod of pods) {
      for (const c of pod.spec?.containers ?? []) {
        if (c.image) inUse.add(c.image);
      }
      for (const c of pod.spec?.initContainers ?? []) {
        if (c.image) inUse.add(c.image);
      }
      for (const s of pod.status?.containerStatuses ?? []) {
        if (s.image) inUse.add(s.image);
      }
      for (const s of pod.status?.initContainerStatuses ?? []) {
        if (s.image) inUse.add(s.image);
      }
    }
  } catch {
    // Return empty set on error — all images will be shown as not-in-use
  }
  return inUse;
}

function isAnyNameInUse(allNames: readonly string[], inUseSet: ReadonlySet<string>): boolean {
  for (const name of allNames) {
    if (inUseSet.has(name)) return true;
    const normalized = name.replace(/^docker\.io\/library\//, '');
    if (inUseSet.has(normalized)) return true;
  }
  return false;
}

interface NodeImagePresence {
  readonly node: string;
  readonly crictlName: string; // tag-preferred full name (or digest fallback) for crictl rmi
  readonly sizeBytes: number;  // bytes on this specific node
  readonly allNames: readonly string[]; // every name reported for the image on this node
}

interface AggregatedImage {
  readonly displayName: string;       // formatted, deduped key
  readonly perNode: readonly NodeImagePresence[];
  readonly totalSizeBytes: number;    // sum of per-node sizeBytes (cluster-wide cache footprint)
  readonly inUse: boolean;
  readonly protected: boolean;
}

type RawImage = { names?: readonly string[] | null; sizeBytes?: number };

async function aggregateImagesAcrossNodes(k8s: K8sClients): Promise<readonly AggregatedImage[]> {
  let nodes: readonly { metadata?: { name?: string }; status?: { images?: readonly RawImage[] } }[] = [];
  try {
    const nodeList = await k8s.core.listNode();
    nodes = (nodeList as { items?: typeof nodes }).items ?? [];
  } catch {
    return [];
  }

  const inUseSet = await getInUseImages(k8s);
  const byDisplay = new Map<string, { displayName: string; perNode: NodeImagePresence[]; allNames: Set<string> }>();

  for (const node of nodes) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const images = node.status?.images ?? [];
    for (const img of images) {
      const names = img.names ?? [];
      if (names.length === 0) continue;
      const tagName = names.find(n => n.includes(':') && !n.includes('@sha256')) ?? names[0];
      const displayName = formatImageName(tagName);

      let entry = byDisplay.get(displayName);
      if (!entry) {
        entry = { displayName, perNode: [], allNames: new Set<string>() };
        byDisplay.set(displayName, entry);
      }
      entry.perNode.push({
        node: nodeName,
        crictlName: tagName,
        sizeBytes: img.sizeBytes ?? 0,
        allNames: names,
      });
      for (const n of names) entry.allNames.add(n);
    }
  }

  const result: AggregatedImage[] = [];
  for (const entry of byDisplay.values()) {
    const totalSizeBytes = entry.perNode.reduce((s, p) => s + p.sizeBytes, 0);
    const isProtected = classifyImage(entry.displayName).protected;
    const inUse = isAnyNameInUse([...entry.allNames, entry.displayName], inUseSet);
    result.push({
      displayName: entry.displayName,
      perNode: entry.perNode,
      totalSizeBytes,
      inUse,
      protected: isProtected,
    });
  }
  return result;
}

export async function getImageInventory(k8s: K8sClients): Promise<ImageInventoryResponse> {
  const aggregated = await aggregateImagesAcrossNodes(k8s);

  const images: ImageEntry[] = aggregated.map(a => ({
    name: a.displayName,
    sizeBytes: a.totalSizeBytes,
    inUse: a.inUse,
    protected: a.protected,
  }));

  const totalBytes = images.reduce((sum, img) => sum + img.sizeBytes, 0);
  const purgeable = filterPurgeableImages(images);
  const purgeableBytes = purgeable.reduce((sum, img) => sum + img.sizeBytes, 0);

  return {
    images,
    totalBytes,
    purgeableBytes,
    purgeableCount: purgeable.length,
  };
}

// ─── Image Purge via Privileged Pod ──────────────────────────────────────────

const PURGE_NAMESPACE = 'kube-system';
const PURGE_TIMEOUT_MS = 180_000;
const PURGE_POLL_MS = 2_000;
// k3s places its containerd socket at /run/k3s/containerd/containerd.sock.
// We do not (yet) support upstream containerd installations.
const CONTAINERD_SOCKET_PATH = '/run/k3s/containerd/containerd.sock';

interface PerNodePurgeResult {
  readonly node: string;
  readonly removedDisplayNames: readonly string[];
  readonly failedDisplayNames: readonly string[];
  readonly freedBytes: number;
  readonly podError?: string;
}

async function runPurgeOnNode(
  k8s: K8sClients,
  node: string,
  targets: readonly { crictlName: string; displayName: string; sizeBytes: number }[],
): Promise<PerNodePurgeResult> {
  const podName = `image-purge-${node.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40)}-${Date.now()}`;
  const crictlByName = new Map(targets.map(t => [t.crictlName, t]));
  const removedDisplayNames: string[] = [];
  const failedDisplayNames: string[] = [];
  let freedBytes = 0;

  const imageList = targets.map(t => `'${t.crictlName.replace(/'/g, "'\\''")}'`).join(' ');
  // crictl in the rancher/k3s image fatals on missing config even when
  // --runtime-endpoint is supplied on the command line. It searches
  // /var/lib/rancher/k3s/agent/etc/crictl.yaml first — write a minimal
  // config there before invoking it.
  const script = `
set -u
if [ ! -S "${CONTAINERD_SOCKET_PATH}" ]; then
  echo "NOSOCKET"
  exit 0
fi
mkdir -p /var/lib/rancher/k3s/agent/etc
cat > /var/lib/rancher/k3s/agent/etc/crictl.yaml <<EOF
runtime-endpoint: unix://${CONTAINERD_SOCKET_PATH}
image-endpoint: unix://${CONTAINERD_SOCKET_PATH}
timeout: 30
EOF
for img in ${imageList}; do
  if crictl rmi "$img" >/tmp/out 2>&1; then
    echo "REMOVED:$img"
  else
    echo "FAILED:$img cause=$(tr '\\n' ' ' < /tmp/out | head -c 200)"
  fi
done
`;

  try {
    await k8s.core.createNamespacedPod({
      namespace: PURGE_NAMESPACE,
      body: {
        metadata: { name: podName, namespace: PURGE_NAMESPACE, labels: { app: 'image-purge', node } },
        spec: {
          restartPolicy: 'Never',
          hostPID: true,
          nodeName: node,
          tolerations: [{ operator: 'Exists' }],
          containers: [{
            name: 'purge',
            image: 'rancher/k3s:v1.33.10-k3s1',
            command: ['sh', '-c', script],
            volumeMounts: [{
              name: 'containerd-sock',
              mountPath: CONTAINERD_SOCKET_PATH,
            }],
            securityContext: { privileged: true },
          }],
          volumes: [{
            name: 'containerd-sock',
            hostPath: { path: CONTAINERD_SOCKET_PATH, type: 'Socket' as const },
          }],
        },
      },
    });
  } catch (err) {
    return {
      node,
      removedDisplayNames: [],
      failedDisplayNames: targets.map(t => t.displayName),
      freedBytes: 0,
      podError: `create pod on ${node}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let podError: string | undefined;
  const start = Date.now();
  let logs = '';
  while (Date.now() - start < PURGE_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, PURGE_POLL_MS));
    try {
      const pod = await k8s.core.readNamespacedPod({ name: podName, namespace: PURGE_NAMESPACE });
      const phase = (pod as { status?: { phase?: string } }).status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') {
        try {
          const raw = await k8s.core.readNamespacedPodLog({ name: podName, namespace: PURGE_NAMESPACE });
          logs = typeof raw === 'string' ? raw : JSON.stringify(raw);
        } catch (err) {
          podError = `read logs on ${node}: ${err instanceof Error ? err.message : String(err)}`;
        }
        break;
      }
    } catch {
      // pod may not yet be visible — keep polling
    }
  }

  if (logs.includes('NOSOCKET')) {
    podError = `containerd socket not found on ${node}`;
  }
  if (logs) {
    for (const line of logs.split('\n')) {
      if (line.startsWith('REMOVED:')) {
        const crictlName = line.slice('REMOVED:'.length).trim();
        const t = crictlByName.get(crictlName);
        if (t) {
          removedDisplayNames.push(t.displayName);
          freedBytes += t.sizeBytes;
        } else {
          removedDisplayNames.push(crictlName);
        }
      } else if (line.startsWith('FAILED:')) {
        // Format: "FAILED:<crictlName> cause=<short-error>" — split on first space
        const rest = line.slice('FAILED:'.length).trim();
        const sepIdx = rest.indexOf(' cause=');
        const crictlName = sepIdx >= 0 ? rest.slice(0, sepIdx) : rest;
        const t = crictlByName.get(crictlName);
        failedDisplayNames.push(t?.displayName ?? crictlName);
      }
    }
  } else if (!podError) {
    podError = `purge pod on ${node} did not finish within ${PURGE_TIMEOUT_MS / 1000}s`;
  }

  // Best-effort cleanup
  try {
    await k8s.core.deleteNamespacedPod({ name: podName, namespace: PURGE_NAMESPACE });
  } catch {
    // pod may already be gone
  }

  return { node, removedDisplayNames, failedDisplayNames, freedBytes, podError };
}

/**
 * Purge unused, non-protected images from every k3s node that has a copy.
 *
 * Each node's containerd is independent: removing an image on node A does not
 * remove it from node B. We therefore fan out one privileged pod per node that
 * holds at least one purgeable image, run `crictl rmi` against that node's
 * containerd socket, and aggregate the results.
 *
 * In dry-run mode, returns the list of images that WOULD be removed without acting.
 */
export async function purgeUnusedImages(
  k8s: K8sClients,
  dryRun: boolean,
): Promise<PurgeImagesResponse> {
  const aggregated = await aggregateImagesAcrossNodes(k8s);
  const purgeable = aggregated.filter(a => !a.protected && !a.inUse);

  if (dryRun) {
    return {
      dryRun: true,
      removedImages: purgeable.map(i => i.displayName),
      freedBytes: purgeable.reduce((sum, i) => sum + i.totalSizeBytes, 0),
      errors: [],
    };
  }

  if (purgeable.length === 0) {
    return { dryRun: false, removedImages: [], freedBytes: 0, errors: [] };
  }

  // Group purgeable presences by the node that holds them.
  const byNode = new Map<string, { crictlName: string; displayName: string; sizeBytes: number }[]>();
  for (const img of purgeable) {
    for (const presence of img.perNode) {
      let bucket = byNode.get(presence.node);
      if (!bucket) {
        bucket = [];
        byNode.set(presence.node, bucket);
      }
      bucket.push({
        crictlName: presence.crictlName,
        displayName: img.displayName,
        sizeBytes: presence.sizeBytes,
      });
    }
  }

  const perNodeResults = await Promise.all(
    Array.from(byNode.entries()).map(([node, targets]) => runPurgeOnNode(k8s, node, targets)),
  );

  const errors: string[] = [];
  const removedSet = new Set<string>();
  const failedSet = new Set<string>();
  let freedBytes = 0;

  for (const r of perNodeResults) {
    for (const name of r.removedDisplayNames) removedSet.add(name);
    for (const name of r.failedDisplayNames) failedSet.add(name);
    freedBytes += r.freedBytes;
    if (r.podError) errors.push(r.podError);
  }

  // Surface per-image failures only when the image was not also removed elsewhere
  for (const name of failedSet) {
    if (!removedSet.has(name)) errors.push(`failed to remove ${name}`);
  }

  return {
    dryRun: false,
    removedImages: Array.from(removedSet),
    freedBytes,
    errors,
  };
}
