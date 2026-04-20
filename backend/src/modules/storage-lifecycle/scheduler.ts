import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients, platformSettings } from '../../db/schema.js';
import { resolveSnapshotStore } from './snapshot-store.js';
import { expireSnapshots, storageAuditReport, archiveClient } from './service.js';
import { applyDeleted } from '../client-lifecycle/cascades.js';

/**
 * Storage-lifecycle housekeeping scheduler.
 *
 * Runs two periodic jobs:
 *   - snapshot-expiry: every 6 hours, reap any storage_snapshots past
 *     their expires_at timestamp. Frees disk on the snapshot store.
 *   - audit-report: every 7 days, compute provisioned-vs-used stats
 *     for all active clients and log to stdout (future work:
 *     email operators or surface in the admin UI dashboard).
 *
 * Both jobs are best-effort — a failure in one cycle doesn't stop
 * the next. The scheduler stops cleanly when the returned Timeout
 * is cleared.
 */

const EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LIFECYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

/**
 * Opt-in client-lifecycle auto-ops. Both default OFF — operators must
 * explicitly enable them via /admin/settings in production so a
 * mis-configured retention window doesn't destroy a fleet of clients.
 */
interface LifecycleSettings {
  readonly autoArchiveEnabled: boolean;
  readonly autoArchiveAfterDays: number;
  readonly autoDeleteEnabled: boolean;
  readonly autoDeleteAfterDays: number;
}

async function loadLifecycleSettings(db: Database): Promise<LifecycleSettings> {
  const rows = await db.select().from(platformSettings);
  const get = (key: string) => rows.find((r) => r.key === key)?.value;
  return {
    autoArchiveEnabled: get('client_lifecycle.auto_archive_enabled') === 'true',
    autoArchiveAfterDays: Number(get('client_lifecycle.auto_archive_after_days') ?? 30),
    autoDeleteEnabled: get('client_lifecycle.auto_delete_enabled') === 'true',
    autoDeleteAfterDays: Number(get('client_lifecycle.auto_delete_after_days') ?? 90),
  };
}

export function startStorageLifecycleScheduler(
  db: Database,
  k8s: K8sClients,
  config: Record<string, unknown>,
): { stop: () => void } {
  console.log('[storage-lifecycle-scheduler] Starting (snapshot expiry + audit reports)');

  // Re-resolve the store each tick so an operator rotating S3 keys /
  // swapping backends in the admin UI picks up on the next cycle
  // without a backend restart. `loadStorageLifecycleSettings` already
  // caches at the DB layer (60s TTL) so this is cheap.
  const buildCtx = async () => ({
    db,
    k8s,
    store: await resolveSnapshotStore(db, config as Record<string, string | undefined>),
    platformNamespace: (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform',
  });

  let expiryTimer: NodeJS.Timeout | null = null;
  let auditTimer: NodeJS.Timeout | null = null;
  let lifecycleTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const runExpiry = async () => {
    if (stopped) return;
    try {
      const reaped = await expireSnapshots(await buildCtx());
      if (reaped > 0) console.log(`[storage-lifecycle-scheduler] Reaped ${reaped} expired snapshot(s)`);
    } catch (err) {
      console.error('[storage-lifecycle-scheduler] expireSnapshots failed:', (err as Error).message);
    }
    if (!stopped) expiryTimer = setTimeout(runExpiry, EXPIRY_INTERVAL_MS);
  };

  const runAudit = async () => {
    if (stopped) return;
    try {
      const report = await storageAuditReport(await buildCtx());
      const totalWasteGi = report.reduce((sum, r) => {
        const provisioned = r.provisionedGi * 1024 * 1024 * 1024;
        return sum + Math.max(0, (provisioned - r.usedBytes) / (1024 ** 3));
      }, 0);
      console.log(`[storage-lifecycle-scheduler] Audit: ${report.length} clients, ${totalWasteGi.toFixed(1)} GiB provisioned-not-used`);
    } catch (err) {
      console.error('[storage-lifecycle-scheduler] audit failed:', (err as Error).message);
    }
    if (!stopped) auditTimer = setTimeout(runAudit, AUDIT_INTERVAL_MS);
  };

  /**
   * Client-lifecycle auto-ops:
   *   - suspended > N days and auto_archive_enabled → call archiveClient
   *   - archived > N days and auto_delete_enabled → hard-delete via applyDeleted
   * Both thresholds default 30 / 90 days, both flags default false.
   */
  const runLifecycle = async () => {
    if (stopped) return;
    try {
      const settings = await loadLifecycleSettings(db);
      const ctx = await buildCtx();

      // Auto-archive: compare against `suspendedAt` (stamped by
      // applySuspended), NOT `updatedAt` — any admin edit bumps
      // updatedAt and would silently reset the archive clock.
      if (settings.autoArchiveEnabled) {
        const threshold = new Date(Date.now() - settings.autoArchiveAfterDays * 24 * 60 * 60 * 1000);
        const rows = await db.select({ id: clients.id, namespace: clients.kubernetesNamespace, suspendedAt: clients.suspendedAt })
          .from(clients)
          .where(and(eq(clients.status, 'suspended'), lt(clients.suspendedAt, threshold)));
        for (const row of rows) {
          try {
            console.log(`[client-lifecycle] auto-archiving ${row.id} (suspended since ${row.suspendedAt?.toISOString() ?? 'unknown'})`);
            await archiveClient(ctx, row.id, { retentionDays: settings.autoDeleteAfterDays });
          } catch (err) {
            console.warn(`[client-lifecycle] auto-archive failed for ${row.id}: ${(err as Error).message}`);
          }
        }
      }

      // Auto-delete: same pattern against `archivedAt`.
      if (settings.autoDeleteEnabled) {
        const threshold = new Date(Date.now() - settings.autoDeleteAfterDays * 24 * 60 * 60 * 1000);
        const rows = await db.select({ id: clients.id, namespace: clients.kubernetesNamespace, archivedAt: clients.archivedAt })
          .from(clients)
          .where(and(eq(clients.status, 'archived'), lt(clients.archivedAt, threshold)));
        for (const row of rows) {
          try {
            console.log(`[client-lifecycle] auto-deleting ${row.id} (archived since ${row.archivedAt?.toISOString() ?? 'unknown'})`);
            await applyDeleted({ db, k8s }, row.id, row.namespace);
          } catch (err) {
            console.warn(`[client-lifecycle] auto-delete failed for ${row.id}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error('[client-lifecycle] auto-op cycle failed:', (err as Error).message);
    }
    if (!stopped) lifecycleTimer = setTimeout(runLifecycle, LIFECYCLE_INTERVAL_MS);
  };

  expiryTimer = setTimeout(runExpiry, INITIAL_DELAY_MS);
  auditTimer = setTimeout(runAudit, INITIAL_DELAY_MS + 30_000);
  lifecycleTimer = setTimeout(runLifecycle, INITIAL_DELAY_MS + 60_000);

  return {
    stop: () => {
      stopped = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (auditTimer) clearTimeout(auditTimer);
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
    },
  };
}
