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

/**
 * Check if a parsed image is in use by any pod.
 * Pods may reference images by different names (tag vs digest), so we check
 * all known names for an image against the in-use set.
 */
function isImageInUse(parsed: ParsedImage, inUseSet: ReadonlySet<string>, allNames: readonly string[]): boolean {
  if (inUseSet.has(parsed.name)) return true;
  for (const name of allNames) {
    if (inUseSet.has(name)) return true;
    // Normalize for comparison
    const normalized = name.replace(/^docker\.io\/library\//, '');
    if (inUseSet.has(normalized)) return true;
  }
  return false;
}

export async function getImageInventory(k8s: K8sClients): Promise<ImageInventoryResponse> {
  let nodeImages: readonly { names?: readonly string[] | null; sizeBytes?: number }[] = [];
  try {
    const nodeList = await k8s.core.listNode();
    const nodes = (nodeList as { items?: readonly { status?: { images?: readonly { names?: readonly string[] | null; sizeBytes?: number }[] } }[] }).items ?? [];
    if (nodes.length > 0) {
      nodeImages = nodes[0].status?.images ?? [];
    }
  } catch {
    // No access to node status
  }

  const parsed = parseNodeImages(nodeImages);
  const inUseSet = await getInUseImages(k8s);

  const images: ImageEntry[] = parsed.map((img, idx) => {
    const allNames = nodeImages[idx]?.names ?? [];
    const isProtected = classifyImage(img.name).protected;
    const inUse = isImageInUse(img, inUseSet, allNames);
    return {
      name: formatImageName(img.name),
      sizeBytes: img.sizeBytes,
      inUse,
      protected: isProtected,
    };
  });

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

/**
 * Purge unused, non-protected images from the k3s node.
 *
 * Approach: Create a one-shot privileged pod with crictl + containerd socket mounted.
 * The pod runs `crictl rmi` for each purgeable image, then exits.
 *
 * In dry-run mode, returns the list of images that WOULD be removed without acting.
 */
export async function purgeUnusedImages(
  k8s: K8sClients,
  dryRun: boolean,
): Promise<PurgeImagesResponse> {
  const inventory = await getImageInventory(k8s);
  const purgeable = filterPurgeableImages(inventory.images);

  if (dryRun) {
    return {
      dryRun: true,
      removedImages: purgeable.map(i => i.name),
      freedBytes: purgeable.reduce((sum, i) => sum + i.sizeBytes, 0),
      errors: [],
    };
  }

  if (purgeable.length === 0) {
    return { dryRun: false, removedImages: [], freedBytes: 0, errors: [] };
  }

  // Look up the original (full) image names from node status — crictl needs
  // the full containerd reference (e.g. docker.io/library/mysql:9.0, not mysql:9.0).
  let nodeImages: readonly { names?: readonly string[] | null }[] = [];
  try {
    const nodeList = await k8s.core.listNode();
    const nodes = (nodeList as { items?: readonly { status?: { images?: readonly { names?: readonly string[] | null }[] } }[] }).items ?? [];
    if (nodes.length > 0) {
      nodeImages = nodes[0].status?.images ?? [];
    }
  } catch {
    // No access — will fall back to formatted names
  }

  // Map formatted name → all possible full names
  const nameToFullNames = new Map<string, readonly string[]>();
  for (const img of nodeImages) {
    const names = img.names ?? [];
    if (names.length === 0) continue;
    const tagName = names.find(n => n.includes(':') && !n.includes('@sha256')) ?? names[0];
    const formatted = formatImageName(tagName);
    nameToFullNames.set(formatted, names);
  }

  const errors: string[] = [];
  const removedImages: string[] = [];
  let freedBytes = 0;

  // Create a one-shot privileged pod that runs crictl rmi
  const podName = `image-purge-${Date.now()}`;
  const namespace = 'kube-system';
  // Use the first (usually the tag-format) full name for crictl.
  // If no full name is available, fall back to the formatted name.
  const imageNamesForCrictl = purgeable
    .map(i => {
      const fullNames = nameToFullNames.get(i.name);
      // Pick the one with a tag (not a digest)
      const tagName = fullNames?.find(n => n.includes(':') && !n.includes('@sha256'));
      return tagName ?? fullNames?.[0] ?? i.name;
    })
    .join(' ');
  // Keep a mapping from crictl-name back to display-name for reporting
  const crictlToDisplay = new Map<string, { display: string; sizeBytes: number }>();
  for (const img of purgeable) {
    const fullNames = nameToFullNames.get(img.name);
    const tagName = fullNames?.find(n => n.includes(':') && !n.includes('@sha256')) ?? fullNames?.[0] ?? img.name;
    crictlToDisplay.set(tagName, { display: img.name, sizeBytes: img.sizeBytes });
  }
  const imageNames = imageNamesForCrictl;

  try {
    await k8s.core.createNamespacedPod({
      namespace,
      body: {
        metadata: { name: podName, namespace },
        spec: {
          restartPolicy: 'Never',
          hostPID: true,
          nodeSelector: { 'kubernetes.io/os': 'linux' },
          tolerations: [{ operator: 'Exists' }],
          containers: [{
            name: 'purge',
            image: 'rancher/k3s:v1.31.4-k3s1',
            command: ['sh', '-c', `
              for img in ${imageNames}; do
                echo "Removing $img..."
                crictl --runtime-endpoint unix:///run/k3s/containerd/containerd.sock rmi "$img" && echo "REMOVED:$img" || echo "FAILED:$img"
              done
            `],
            volumeMounts: [{
              name: 'containerd-sock',
              mountPath: '/run/k3s/containerd/containerd.sock',
            }],
            securityContext: { privileged: true },
          }],
          volumes: [{
            name: 'containerd-sock',
            hostPath: {
              path: '/run/k3s/containerd/containerd.sock',
              type: 'Socket',
            },
          }],
        },
      },
    });

    // Poll for pod completion (up to 60 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const pod = await k8s.core.readNamespacedPod({ name: podName, namespace });
        const phase = (pod as { status?: { phase?: string } }).status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') {
          // Get logs
          try {
            const logs = await k8s.core.readNamespacedPodLog({ name: podName, namespace });
            const logText = typeof logs === 'string' ? logs : JSON.stringify(logs);
            const lines = logText.split('\n');
            for (const line of lines) {
              if (line.startsWith('REMOVED:')) {
                const name = line.slice('REMOVED:'.length).trim();
                const entry = crictlToDisplay.get(name);
                const displayName = entry?.display ?? name;
                removedImages.push(displayName);
                if (entry) freedBytes += entry.sizeBytes;
              } else if (line.startsWith('FAILED:')) {
                const name = line.slice('FAILED:'.length).trim();
                const entry = crictlToDisplay.get(name);
                errors.push(entry?.display ?? name);
              }
            }
          } catch (err) {
            errors.push(`Failed to read purge pod logs: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
      } catch {
        // Keep polling
      }
    }
  } catch (err) {
    errors.push(`Failed to run purge pod: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Best-effort cleanup
    try {
      await k8s.core.deleteNamespacedPod({ name: podName, namespace });
    } catch {
      // Pod may already be gone
    }
  }

  return {
    dryRun: false,
    removedImages,
    freedBytes,
    errors,
  };
}
