import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, platformSettings } from '../../db/schema.js';
import { resolveSnapshotStore } from './snapshot-store.js';
import { expireSnapshots, storageAuditReport, archiveTenant } from './service.js';
import { applyDeleted } from '../tenant-lifecycle/cascades.js';

/**
 * Storage-lifecycle housekeeping scheduler.
 *
 * Runs two periodic jobs:
 *   - snapshot-expiry: every 6 hours, reap any storage_snapshots past
 *     their expires_at timestamp. Frees disk on the snapshot store.
 *   - audit-report: every 7 days, compute provisioned-vs-used stats
 *     for all active tenants and log to stdout (future work:
 *     email operators or surface in the admin UI dashboard).
 *
 * Both jobs are best-effort — a failure in one cycle doesn't stop
 * the next. The scheduler stops cleanly when the returned Timeout
 * is cleared.
 */

const EXPIRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LIFECYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Issue 1 fix: every 30 minutes, sweep all provisioned tenants for missing
// PVC / RQ / NetPol and auto-repair. Cluster rebootstraps and DR restores
// can leave the namespace as a husk that the lifecycle module never fully
// rehydrated. 30 min is a reasonable detection bound — operators can also
// trigger a manual repair from the admin UI.
const INTEGRITY_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

/**
 * Opt-in tenant-lifecycle auto-ops. Both default OFF — operators must
 * explicitly enable them via /admin/settings in production so a
 * mis-configured retention window doesn't destroy a fleet of tenants.
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
    autoArchiveEnabled: get('tenant_lifecycle.auto_archive_enabled') === 'true',
    autoArchiveAfterDays: Number(get('tenant_lifecycle.auto_archive_after_days') ?? 30),
    autoDeleteEnabled: get('tenant_lifecycle.auto_delete_enabled') === 'true',
    autoDeleteAfterDays: Number(get('tenant_lifecycle.auto_delete_after_days') ?? 90),
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
  //
  // `buildCtx` is the legacy/read-only path used by expireSnapshots and
  // storageAuditReport — neither writes a new snapshot row, so the
  // single-active-target fallback is fine for them.
  const buildCtx = async () => ({
    db,
    k8s,
    store: await resolveSnapshotStore(db, config as Record<string, string | undefined>),
    platformNamespace: (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform',
  });

  // Phase 3: per-class ctx for auto-ops that WRITE snapshots (auto-archive).
  // Routes through `backup_target_assignments` and stamps target_id on
  // the resulting storage_snapshots row so Phase 5 restore can look it
  // up. Throws NO_SNAPSHOT_TARGET (409) if the class is unassigned —
  // the caller catches and logs (auto-archive becomes a no-op for that
  // tenant until the operator configures an assignment).
  const buildSnapshotCtx = async (
    snapshotClass: import('@k8s-hosting/api-contracts').SnapshotClass,
  ) => {
    const { resolveSnapshotStoreForClass } = await import('./snapshot-store.js');
    const bundle = await resolveSnapshotStoreForClass(
      db,
      config as Record<string, string | undefined>,
      snapshotClass,
    );
    return {
      db,
      k8s,
      store: bundle.store,
      platformNamespace: (config.PLATFORM_NAMESPACE as string | undefined) ?? 'platform',
      targetId: bundle.targetId,
      snapshotClass,
    };
  };

  let expiryTimer: NodeJS.Timeout | null = null;
  let auditTimer: NodeJS.Timeout | null = null;
  let lifecycleTimer: NodeJS.Timeout | null = null;
  let integrityTimer: NodeJS.Timeout | null = null;
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
      console.log(`[storage-lifecycle-scheduler] Audit: ${report.length} tenants, ${totalWasteGi.toFixed(1)} GiB provisioned-not-used`);
    } catch (err) {
      console.error('[storage-lifecycle-scheduler] audit failed:', (err as Error).message);
    }
    if (!stopped) auditTimer = setTimeout(runAudit, AUDIT_INTERVAL_MS);
  };

  /**
   * Client-lifecycle auto-ops:
   *   - suspended > N days and auto_archive_enabled → call archiveTenant
   *   - archived > N days and auto_delete_enabled → hard-delete via applyDeleted
   * Both thresholds default 30 / 90 days, both flags default false.
   */
  const runLifecycle = async () => {
    if (stopped) return;
    try {
      const settings = await loadLifecycleSettings(db);
      // No legacy ctx needed here — auto-archive builds its own
      // per-class ctx below; auto-delete uses applyDeleted with only
      // db + k8s (no snapshot store needed).

      // Auto-archive: compare against `suspendedAt` (stamped by
      // applySuspended), NOT `updatedAt` — any admin edit bumps
      // updatedAt and would silently reset the archive clock.
      //
      // Phase 3 fix: resolve a per-class ctx for archive so the
      // pre-archive snapshot routes through `backup_target_assignments`
      // and stamps target_id for forensic restore. If no class
      // assignment exists, log + skip the tenant — operator must
      // configure an assignment before auto-archive can run.
      if (settings.autoArchiveEnabled) {
        const threshold = new Date(Date.now() - settings.autoArchiveAfterDays * 24 * 60 * 60 * 1000);
        const rows = await db.select({ id: tenants.id, namespace: tenants.kubernetesNamespace, suspendedAt: tenants.suspendedAt })
          .from(tenants)
          .where(and(eq(tenants.status, 'suspended'), lt(tenants.suspendedAt, threshold)));

        let snapshotCtx: Awaited<ReturnType<typeof buildSnapshotCtx>> | null = null;
        if (rows.length > 0) {
          try {
            snapshotCtx = await buildSnapshotCtx('tenant_snapshot');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[tenant-lifecycle] auto-archive skipped (${rows.length} tenant(s)): ${msg}`);
          }
        }

        if (snapshotCtx) {
          for (const row of rows) {
            try {
              console.log(`[tenant-lifecycle] auto-archiving ${row.id} (suspended since ${row.suspendedAt?.toISOString() ?? 'unknown'})`);
              await archiveTenant(snapshotCtx, row.id, { retentionDays: settings.autoDeleteAfterDays });
            } catch (err) {
              console.warn(`[tenant-lifecycle] auto-archive failed for ${row.id}: ${(err as Error).message}`);
            }
          }
        }
      }

      // Auto-delete: same pattern against `archivedAt`.
      if (settings.autoDeleteEnabled) {
        const threshold = new Date(Date.now() - settings.autoDeleteAfterDays * 24 * 60 * 60 * 1000);
        const rows = await db.select({ id: tenants.id, namespace: tenants.kubernetesNamespace, archivedAt: tenants.archivedAt })
          .from(tenants)
          .where(and(eq(tenants.status, 'archived'), lt(tenants.archivedAt, threshold)));
        for (const row of rows) {
          try {
            console.log(`[tenant-lifecycle] auto-deleting ${row.id} (archived since ${row.archivedAt?.toISOString() ?? 'unknown'})`);
            await applyDeleted({ db, k8s }, row.id, row.namespace);
          } catch (err) {
            console.warn(`[tenant-lifecycle] auto-delete failed for ${row.id}: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error('[tenant-lifecycle] auto-op cycle failed:', (err as Error).message);
    }
    if (!stopped) lifecycleTimer = setTimeout(runLifecycle, LIFECYCLE_INTERVAL_MS);
  };

  // Issue 1 fix: namespace integrity sweep. Repairs missing PVC / RQ /
  // NetPol on provisioned tenants (post-rebootstrap drift). Self-heals
  // without operator action; emits notifications when something is
  // repaired or fails.
  const runIntegrity = async () => {
    if (stopped) return;
    try {
      const { sweepFleetIntegrity } = await import('../namespace-integrity/service.js');
      const result = await sweepFleetIntegrity(db, k8s);
      if (result.repaired > 0 || result.errored > 0) {
        console.log(`[namespace-integrity] sweep: checked=${result.checked} repaired=${result.repaired} errored=${result.errored}`);
      }
    } catch (err) {
      console.error('[namespace-integrity] sweep failed:', (err as Error).message);
    }
    if (!stopped) integrityTimer = setTimeout(runIntegrity, INTEGRITY_INTERVAL_MS);
  };

  expiryTimer = setTimeout(runExpiry, INITIAL_DELAY_MS);
  auditTimer = setTimeout(runAudit, INITIAL_DELAY_MS + 30_000);
  lifecycleTimer = setTimeout(runLifecycle, INITIAL_DELAY_MS + 60_000);
  integrityTimer = setTimeout(runIntegrity, INITIAL_DELAY_MS + 90_000);

  return {
    stop: () => {
      stopped = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (auditTimer) clearTimeout(auditTimer);
      if (lifecycleTimer) clearTimeout(lifecycleTimer);
      if (integrityTimer) clearTimeout(integrityTimer);
    },
  };
}
