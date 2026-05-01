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
 *
 * B0.3 change: these prefixes alone are no longer sufficient to protect an
 * image. An image is "protected" only when it matches a prefix AND it is
 * currently in use by a pod. Deprecated/orphaned system images (e.g. old k3s
 * versions after an upgrade) become purgeable once no pod references them.
 *
 * Pass `inUse=true` (the default) to preserve the legacy behaviour for callers
 * that don't track in-use state.
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
  // System-critical images added in B0.3 — protected only when in use
  'docker.io/longhornio/',
  'quay.io/calico/',
  'quay.io/jetstack/cert-manager-',
  'ghcr.io/cloudnative-pg/',
  'ghcr.io/fluxcd/',
  'docker.io/bitnami/sealed-secrets-controller',
  'ghcr.io/phoenixtechnam/hosting-platform/',
];

export interface ClassifiedImage {
  readonly protected: boolean;
}

/**
 * Determine whether an image is protected.
 *
 * @param name - Image reference (tag or digest form)
 * @param inUse - Whether any running pod references this image. Defaults to
 *   `true` so existing callers remain conservative (prefix match → protected).
 *   Pass `false` for images confirmed to be unused; they become purgeable even
 *   if their registry prefix matches a known system prefix.
 */
export function classifyImage(name: string, inUse = true): ClassifiedImage {
  // Normalize: strip docker.io/library/ prefix if present for matching
  const normalized = name.replace(/^docker\.io\/library\//, '');

  const prefixMatches = PROTECTED_PREFIXES.some(prefix => {
    // Match against both the normalized name and the original
    return normalized.startsWith(prefix) || name.startsWith(prefix);
  });

  // B0.3: prefix match alone is insufficient. The image is only truly
  // protected when it is ALSO in use. An orphaned system image (e.g., old
  // k3s version after upgrade) is safe to purge.
  const isProtected = prefixMatches && inUse;

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
 * - Not protected (not a platform/system image that is currently in use)
 * - Not currently in use by any pod
 *
 * B0.3: `img.protected` is now false for system images that are NOT in use,
 * so this filter naturally picks them up as purgeable.
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

export async function getInUseImages(k8s: K8sClients): Promise<Set<string>> {
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

/**
 * Choose the best crictl-compatible reference for an image.
 *
 * B0.1 fix: when the image has no real (non-`<none>`) tag — either because
 * the tag is literally `<none>` (CI rolled a new :latest) or because there is
 * no tag entry at all — fall back to the digest reference (`repo@sha256:…`)
 * or the bare image ID (`sha256:…`). Both are accepted by `crictl rmi`.
 */
function chooseCrictlName(names: readonly string[]): string {
  // 1. Prefer a real tag (has ':' and not '@sha256', and does NOT end with ':<none>')
  const realTag = names.find(n =>
    n.includes(':') &&
    !n.includes('@sha256') &&
    !n.endsWith(':<none>'),
  );
  if (realTag) return realTag;

  // 2. Fall back to the digest form (repo@sha256:...) — unambiguous for crictl
  const digestRef = names.find(n => n.includes('@sha256:'));
  if (digestRef) return digestRef;

  // 3. Last resort: bare sha256 ID or whatever is left
  return names[0];
}

/**
 * Derive a stable dedup key for the byDisplay map.
 *
 * B0.4 fix: multiple distinct dangling images can all produce the display name
 * `repo:<none>`. Use the digest (or bare sha256 ID) as the dedup key when no
 * real tag is available, so each dangling image gets its own entry.
 */
function dedupKey(names: readonly string[]): string {
  // If there is a real tag, that is unique enough
  const realTag = names.find(n =>
    n.includes(':') &&
    !n.includes('@sha256') &&
    !n.endsWith(':<none>'),
  );
  if (realTag) return realTag;

  // Dangling image — use digest or first name as dedup key
  const digestRef = names.find(n => n.includes('@sha256:'));
  return digestRef ?? names[0];
}

/**
 * B0.4: build the UI display name. For dangling images (`:<none>`), append the
 * short image ID so operators can tell them apart.
 */
function buildDisplayName(names: readonly string[]): string {
  const realTag = names.find(n =>
    n.includes(':') &&
    !n.includes('@sha256') &&
    !n.endsWith(':<none>'),
  );
  if (realTag) return formatImageName(realTag);

  // Dangling: show `repo:<none> (<short-id>)` when a digest ref is available
  const noneTag = names.find(n => n.endsWith(':<none>'));
  const digestRef = names.find(n => n.includes('@sha256:'));
  if (digestRef) {
    const shortId = digestRef.split('@sha256:')[1]?.slice(0, 12) ?? '';
    const base = noneTag ? formatImageName(noneTag) : formatImageName(digestRef);
    return shortId ? `${base} (${shortId})` : base;
  }

  return formatImageName(names[0]);
}

async function aggregateImagesAcrossNodes(k8s: K8sClients): Promise<readonly AggregatedImage[]> {
  let nodes: readonly { metadata?: { name?: string }; status?: { images?: readonly RawImage[] } }[] = [];
  try {
    const nodeList = await k8s.core.listNode();
    nodes = (nodeList as { items?: typeof nodes }).items ?? [];
  } catch {
    return [];
  }

  const inUseSet = await getInUseImages(k8s);
  const byKey = new Map<string, { displayName: string; perNode: NodeImagePresence[]; allNames: Set<string> }>();

  for (const node of nodes) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const images = node.status?.images ?? [];
    for (const img of images) {
      const names = img.names ?? [];
      if (names.length === 0) continue;

      const key = dedupKey(names);             // B0.4: stable dedup key per image
      const displayName = buildDisplayName(names); // B0.4: UI-friendly name
      const crictlName = chooseCrictlName(names);  // B0.1: crictl-safe reference

      let entry = byKey.get(key);
      if (!entry) {
        entry = { displayName, perNode: [], allNames: new Set<string>() };
        byKey.set(key, entry);
      }
      entry.perNode.push({
        node: nodeName,
        crictlName,
        sizeBytes: img.sizeBytes ?? 0,
        allNames: names,
      });
      for (const n of names) entry.allNames.add(n);
    }
  }

  const result: AggregatedImage[] = [];
  for (const entry of byKey.values()) {
    const totalSizeBytes = entry.perNode.reduce((s, p) => s + p.sizeBytes, 0);
    const inUse = isAnyNameInUse([...entry.allNames, entry.displayName], inUseSet);
    // B0.3: pass inUse so deprecated system images become purgeable
    const isProtected = classifyImage(entry.displayName, inUse).protected;
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

export interface PerNodePurgeResult {
  readonly node: string;
  readonly removedDisplayNames: readonly string[];
  readonly failedDisplayNames: readonly string[];
  readonly freedBytes: number;
  readonly podError?: string;
}

export async function runPurgeOnNode(
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
  //
  // B0.2: run `crictl rmi --prune` first to remove any dangling blobs/layers
  // that didn't make it into our node.status.images list. Failures are logged
  // (PRUNE_FAILED line) but do not abort the per-image loop. Freed bytes from
  // --prune are counted separately (we don't know exact size, so we output the
  // exit code and skip byte tracking for the prune pass).
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
if crictl rmi --prune >/tmp/prune_out 2>&1; then
  echo "PRUNE_OK"
else
  echo "PRUNE_FAILED:$(tr '\\n' ' ' < /tmp/prune_out | head -c 200)"
fi
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
      // B0.2: PRUNE_FAILED is logged but does not fail the whole purge
      // (the per-image loop still runs). No bytes are tracked for --prune
      // since we don't know exact sizes of orphaned blobs.
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
