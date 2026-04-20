import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { resolveSnapshotStore } from './snapshot-store.js';
import { expireSnapshots, storageAuditReport } from './service.js';

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
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

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

  expiryTimer = setTimeout(runExpiry, INITIAL_DELAY_MS);
  auditTimer = setTimeout(runAudit, INITIAL_DELAY_MS + 30_000);

  return {
    stop: () => {
      stopped = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (auditTimer) clearTimeout(auditTimer);
    },
  };
}
