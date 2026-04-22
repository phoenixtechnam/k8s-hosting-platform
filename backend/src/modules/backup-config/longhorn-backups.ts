import * as k8s from '@kubernetes/client-node';

/**
 * List Longhorn Backup CRs in longhorn-system and trigger manual
 * backups across all PVCs opted into the default recurring-job group.
 *
 * Separated from longhorn-reconciler.ts so the read/write split is
 * clear: the reconciler owns BackupTarget + credentials; this file
 * owns Backup + Snapshot CRs (the artifacts produced by Longhorn when
 * a recurring job or manual trigger fires).
 */

const LONGHORN_GROUP = 'longhorn.io';
const LONGHORN_VERSION = 'v1beta2';
const LONGHORN_NS = 'longhorn-system';
const DEFAULT_GROUP_LABEL = 'recurring-job-group.longhorn.io/default';

export interface BackupRecord {
  readonly name: string;
  readonly volumeName: string;
  readonly size: string;
  readonly state: string;
  readonly createdAt: string | null;
  readonly backupTargetUrl: string;
  readonly url: string;
}

interface LonghornBackup {
  metadata?: { name?: string; creationTimestamp?: string; labels?: Record<string, string> };
  spec?: { snapshotName?: string };
  status?: {
    volumeName?: string;
    size?: string;
    state?: string;
    url?: string;
    backupCreatedAt?: string;
    lastSyncedAt?: string;
  };
}

interface LonghornVolume {
  metadata?: { name?: string; labels?: Record<string, string> };
}

interface LonghornListResponse<T> {
  items?: T[];
}

export interface LonghornReadClients {
  readonly custom: k8s.CustomObjectsApi;
}

/**
 * List all Longhorn Backups visible to the cluster. Sorted by creation
 * time descending so the admin-panel can render recent-first.
 */
export async function listBackups(clients: LonghornReadClients): Promise<BackupRecord[]> {
  const resp = await clients.custom.listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NS,
    plural: 'backups',
  } as Parameters<typeof clients.custom.listNamespacedCustomObject>[0]);
  const items = ((resp as LonghornListResponse<LonghornBackup>).items ?? []).map(toRecord);
  items.sort((a, b) => {
    if (!a.createdAt) return 1;
    if (!b.createdAt) return -1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return items;
}

function toRecord(b: LonghornBackup): BackupRecord {
  return {
    name: b.metadata?.name ?? '',
    volumeName: b.status?.volumeName ?? '',
    size: b.status?.size ?? '0',
    state: b.status?.state ?? 'unknown',
    createdAt: b.status?.backupCreatedAt ?? b.metadata?.creationTimestamp ?? null,
    backupTargetUrl: b.status?.url ?? '',
    url: b.status?.url ?? '',
  };
}

/**
 * Trigger an on-demand backup for every volume opted into the `default`
 * recurring-job group. Uses Longhorn's own HTTP REST API (longhorn-
 * backend:9500) rather than k8s Backup CR creation — direct Backup CR
 * creates are rejected by Longhorn's admission webhook because the
 * snapshot-then-upload orchestration is internal to the controller.
 * The REST API's `snapshotBackup` action does both in one call.
 *
 * Returns the names of the volumes that were triggered; an empty list
 * means no volumes carry the opt-in label yet (operator needs to run
 * `kubectl label pvc … recurring-job-group.longhorn.io/default=enabled`).
 */
// Configurable for tests; in-cluster default points at the Longhorn
// manager's REST service (not the UI frontend).
const DEFAULT_LONGHORN_API_BASE = 'http://longhorn-backend.longhorn-system:9500';

export async function triggerBackupNow(
  clients: LonghornReadClients & { core?: k8s.CoreV1Api },
  opts: { apiBase?: string; fetch?: typeof globalThis.fetch } = {},
): Promise<{ triggered: string[]; message: string }> {
  const apiBase = opts.apiBase ?? process.env.LONGHORN_API_BASE ?? DEFAULT_LONGHORN_API_BASE;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  const labeled = await clients.custom.listNamespacedCustomObject({
    group: LONGHORN_GROUP,
    version: LONGHORN_VERSION,
    namespace: LONGHORN_NS,
    plural: 'volumes',
    labelSelector: `${DEFAULT_GROUP_LABEL}=enabled`,
  } as Parameters<typeof clients.custom.listNamespacedCustomObject>[0]);

  const volumes = ((labeled as LonghornListResponse<LonghornVolume>).items ?? [])
    .map((v) => v.metadata?.name)
    .filter((n): n is string => !!n);

  if (volumes.length === 0) {
    return {
      triggered: [],
      message: 'No volumes carry the recurring-job-group.longhorn.io/default=enabled label.',
    };
  }

  const triggered: string[] = [];
  const errors: string[] = [];
  for (const volumeName of volumes) {
    // Longhorn's REST API flow is two-step:
    //   1. POST /v1/volumes/<name>?action=snapshotCreate
    //      body: { name, labels } → creates a snapshot on the volume
    //   2. POST /v1/volumes/<name>?action=snapshotBackup
    //      body: { name } → uploads that snapshot to the active
    //      BackupTarget. Fails with "snapshot <nil> is invalid" if
    //      called without a preceding snapshotCreate.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapName = `manual-${ts}`.toLowerCase().slice(0, 40);
    const volUrl = `${apiBase}/v1/volumes/${encodeURIComponent(volumeName)}`;
    const labels = {
      'platform.phoenix-host.net/trigger': 'manual',
      'app.kubernetes.io/managed-by': 'platform-api',
    };
    try {
      const snapRes = await fetchFn(`${volUrl}?action=snapshotCreate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: snapName, labels }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!snapRes.ok) {
        const text = await snapRes.text().catch(() => '');
        errors.push(`${volumeName} (snapshotCreate): HTTP ${snapRes.status} ${text.slice(0, 200)}`);
        continue;
      }
      const backupRes = await fetchFn(`${volUrl}?action=snapshotBackup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: snapName, labels }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!backupRes.ok) {
        const text = await backupRes.text().catch(() => '');
        errors.push(`${volumeName} (snapshotBackup): HTTP ${backupRes.status} ${text.slice(0, 200)}`);
        continue;
      }
      triggered.push(volumeName);
    } catch (err) {
      errors.push(`${volumeName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (triggered.length === 0 && errors.length > 0) {
    throw new Error(`All backup triggers failed: ${errors.join('; ')}`);
  }

  const parts = [`Triggered backup on ${triggered.length} volume${triggered.length === 1 ? '' : 's'}`];
  if (errors.length > 0) parts.push(`(${errors.length} failed: ${errors.join('; ')})`);
  return { triggered, message: parts.join(' ') };
}
