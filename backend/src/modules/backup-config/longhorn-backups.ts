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
 * recurring-job group. Creates a Snapshot CR per volume — Longhorn's
 * controller then watches for the recurring-job-trigger label and
 * uploads the snapshot via the active BackupTarget.
 *
 * Returns the names of the volumes that were triggered; an empty list
 * means no volumes carry the opt-in label yet (operator needs to run
 * `kubectl label pvc … recurring-job-group.longhorn.io/default=enabled`).
 */
export async function triggerBackupNow(
  clients: LonghornReadClients & { core?: k8s.CoreV1Api },
): Promise<{ triggered: string[]; message: string }> {
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
  for (const volumeName of volumes) {
    // Create a one-shot Backup CR. Longhorn's controller takes a
    // snapshot first, then uploads it to the active BackupTarget.
    // Name is deterministic-with-timestamp so repeated triggers don't
    // collide and the admin-panel can correlate by timestamp.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `manual-${volumeName}-${ts}`.toLowerCase().slice(0, 63);
    try {
      await clients.custom.createNamespacedCustomObject({
        group: LONGHORN_GROUP,
        version: LONGHORN_VERSION,
        namespace: LONGHORN_NS,
        plural: 'backups',
        body: {
          apiVersion: `${LONGHORN_GROUP}/${LONGHORN_VERSION}`,
          kind: 'Backup',
          metadata: {
            name: backupName,
            labels: {
              'longhornvolume': volumeName,
              'app.kubernetes.io/managed-by': 'platform-api',
              'platform.phoenix-host.net/backup-trigger': 'manual',
            },
          },
          spec: {
            // Empty snapshotName tells Longhorn to take a fresh
            // snapshot and back it up in one go.
            snapshotName: '',
            labels: {
              'platform.phoenix-host.net/trigger': 'manual',
            },
          },
        },
      } as Parameters<typeof clients.custom.createNamespacedCustomObject>[0]);
      triggered.push(volumeName);
    } catch (err) {
      // Already-exists (409) is fine — a prior click produced the
      // same name (second-resolution collision). Anything else
      // surfaces as a partial-success warning.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 409) {
        triggered.push(volumeName);
        continue;
      }
      throw new Error(
        `Failed to trigger backup for volume ${volumeName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    triggered,
    message: `Triggered backup on ${triggered.length} volume${triggered.length === 1 ? '' : 's'}.`,
  };
}
