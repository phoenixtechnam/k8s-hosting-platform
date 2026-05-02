import { eq } from 'drizzle-orm';
import { backupJobs } from '../../../db/schema.js';
import {
  registerLifecycleHook,
  type HookCtx,
  type HookResult,
  type LifecycleHook,
} from '../registry/index.js';
import { resolveBackupStore, ResolveStoreError } from '../../backups-v2/resolve-store.js';
import { isHookAuthoritative } from '../registry/feature-flags.js';

let _envKeyMissingLogged = false;
function resolveEncryptionKey(): string {
  const k = process.env.OIDC_ENCRYPTION_KEY;
  if (!k) {
    if (!_envKeyMissingLogged) {
      console.warn(
        '[backups-v2-bundle-cleanup] OIDC_ENCRYPTION_KEY not set — falling back to zero key. Backup target credentials will likely fail to decrypt; check the platform deployment.',
      );
      _envKeyMissingLogged = true;
    }
    return '0'.repeat(64);
  }
  return k;
}

/**
 * backups-v2-bundle-cleanup hook.
 *
 * Deletes every off-cluster backup bundle owned by the client being
 * deleted. The `backup_jobs` table cascades on `clients.id` deletion
 * (FK ON DELETE CASCADE), but the actual bundle bytes on S3 / SSH
 * are NEVER cleaned up by anything in the existing codebase. The
 * routes.ts DELETE /admin/backups/bundles/:id endpoint is the only
 * caller of `store.delete()` — and the operator never invokes it on
 * client delete.
 *
 * This hook closes that gap. It runs BEFORE the FK cascade nukes
 * the backup_jobs rows, so we can still see every bundle's
 * targetConfigId + id at this point.
 *
 * Ordering / blocking:
 *   - order=410 — runs after dns-zone-cleanup (400). Bundles can be
 *     large + slow to delete (S3 list+delete-many); we'd rather DNS
 *     finish first since DNS providers are usually fast.
 *   - blocking=continue — an S3 5xx must not abort the delete; the
 *     orphan bundle is surfaced via OperatorError envelope and can
 *     be cleaned up via the existing DELETE /admin/backups/bundles/:id.
 *
 * Cost note: we fan out one resolveBackupStore call per distinct
 * targetConfigId. Most clients use 1-2 targets, so the cost is
 * bounded. Per-bundle delete is one S3 ListObjectsV2 + one
 * DeleteObjects call (or one SSH rm -rf), so latency is dominated
 * by the bundle count, not the target count.
 */

interface JobLite {
  readonly id: string;
  readonly targetConfigId: string | null;
}

const HOOK_NAME = 'backups-v2-bundle-cleanup';

async function runImpl(ctx: HookCtx): Promise<HookResult> {
  if (ctx.transition !== 'deleted') {
    return { status: 'noop', detail: 'only runs on deleted' };
  }
  if (!isHookAuthoritative(HOOK_NAME)) {
    return { status: 'noop', detail: 'hook disabled by feature flag' };
  }

  const jobs = (await ctx.db.select({
    id: backupJobs.id,
    targetConfigId: backupJobs.targetConfigId,
  })
    .from(backupJobs)
    .where(eq(backupJobs.clientId, ctx.clientId))) as readonly JobLite[];

  // Pre-D-redesign rows can have null targetConfigId — drop those
  // since there's no off-site store to clean. They'll be caught by
  // the FK cascade.
  const remoteJobs = jobs.filter((j) => j.targetConfigId);
  if (remoteJobs.length === 0) {
    return {
      status: 'noop',
      detail: jobs.length === 0
        ? 'client has no backup bundles'
        : `${jobs.length} bundle(s) without targetConfigId — FK cascade will reap rows`,
    };
  }

  const encryptionKey = resolveEncryptionKey();
  // Resolve each unique target once.
  const targetIds = Array.from(new Set(remoteJobs.map((j) => j.targetConfigId!)));
  const stores = new Map<string, Awaited<ReturnType<typeof resolveBackupStore>>>();
  const failures: Array<{ bundleId: string; error: string }> = [];

  for (const targetId of targetIds) {
    try {
      // requireActive=false so cleanup of bundles on a deactivated
      // target still works.
      const s = await resolveBackupStore(ctx.db, targetId, encryptionKey, { requireActive: false });
      stores.set(targetId, s);
    } catch (err) {
      // Resolve failure: every bundle on this target counts as a
      // single failure entry — the operator can fix the target and
      // the scheduler retry tick will re-attempt.
      const errorMsg = err instanceof ResolveStoreError
        ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      for (const j of remoteJobs.filter((rj) => rj.targetConfigId === targetId)) {
        failures.push({ bundleId: j.id, error: `target ${targetId}: ${errorMsg}` });
      }
    }
  }

  let deleted = 0;
  for (const job of remoteJobs) {
    const store = stores.get(job.targetConfigId!);
    if (!store) continue; // resolve failed — recorded above
    try {
      const handle = await store.open(job.id);
      if (handle) {
        await store.delete(handle);
        deleted++;
      }
      // null handle means the bundle dir was never reserved
      // (in-flight or store-side cleanup race) — count as deleted.
    } catch (err) {
      failures.push({
        bundleId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (failures.length === 0) {
    return {
      status: 'ok',
      detail: `deleted ${deleted}/${remoteJobs.length} remote bundle(s) across ${targetIds.length} target(s)`,
    };
  }
  return {
    status: 'retry',
    detail: `${deleted}/${remoteJobs.length} bundles deleted; ${failures.length} failure(s)`,
    envelope: {
      title: 'Backup bundle cleanup partial',
      detail: `${failures.length} bundle delete(s) failed; will retry on the next scheduler tick`,
      remediation: [
        'Check Backup Targets in Settings — credentials may have rotated',
        'Verify S3/SSH reachability from the cluster',
        'Manually delete via DELETE /api/v1/admin/backups/bundles/:id when needed',
      ],
      raw: failures.map((f) => `${f.bundleId}: ${f.error}`).join('\n'),
    },
  };
}

export const backupsV2BundleCleanupHook: LifecycleHook = {
  name: HOOK_NAME,
  transitions: ['deleted'],
  order: 410,
  blocking: 'continue',
  // 3 attempts max — after that the bundle stays orphan; operator
  // visibility via the dispatcher's hook_runs row.
  maxAttempts: 3,
  // Run after dns-zone-cleanup so DNS finishes first (fast providers
  // shouldn't be blocked behind slower S3 list+delete-many).
  after: ['dns-zone-cleanup'],
  run: runImpl,
};

let _registered = false;
export function registerBackupsV2BundleCleanupHook(): void {
  if (_registered) return;
  registerLifecycleHook(backupsV2BundleCleanupHook);
  _registered = true;
}
