/**
 * Tenant Backup retention sweeper.
 *
 * Two responsibilities:
 *   1. Delete bundles whose `expires_at` is in the past — call
 *      BackupStore.delete() on the off-site target, then flip the
 *      DB row's `status` to 'expired'.
 *   2. GC stuck `running` bundles older than 24h — set their
 *      status to 'failed' with a clear lastError so the operator
 *      can re-trigger.
 *
 * Idempotent: a half-completed sweep is safe to re-run. The store-
 * delete is idempotent at the BackupStore level (a missing remote
 * bundle returns success), so a crash between "delete on remote"
 * and "set status='expired'" is recovered on the next tick.
 *
 * Per-bundle errors are logged but do NOT stop the sweep — one
 * unreachable target shouldn't block expiry of bundles on a
 * working target.
 */

import type { FastifyInstance } from 'fastify';
import { eq, and, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { backupJobs, backupConfigurations } from '../../db/schema.js';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';

const STUCK_RUNNING_HOURS = 24;

export interface RetentionSweepResult {
  readonly expiredDeleted: number;
  readonly expiredFailed: number;
  readonly stuckMarkedFailed: number;
}

/**
 * Run one sweep tick. Returns counts so the scheduler can log
 * "swept N expired, M stuck → marked failed".
 */
export async function runRetentionSweep(app: FastifyInstance): Promise<RetentionSweepResult> {
  let expiredDeleted = 0;
  let expiredFailed = 0;
  let stuckMarkedFailed = 0;

  // ── 1. Expired bundles ────────────────────────────────────────────
  // Lock candidate IDs first, then process outside any single
  // transaction so a slow remote delete doesn't hold a lock.
  // Cap at 50 per tick — a backlog catches up over multiple ticks
  // without overwhelming the target.
  const now = new Date();
  const expiredCandidates = await app.db
    .select({ id: backupJobs.id, targetConfigId: backupJobs.targetConfigId })
    .from(backupJobs)
    .where(
      and(
        lt(backupJobs.expiresAt, now),
        sql`${backupJobs.status} IN ('completed','partial','failed')`,
      ),
    )
    .limit(50);

  for (const { id, targetConfigId } of expiredCandidates) {
    if (!targetConfigId) {
      // Pre-D-redesign row with no target_config_id; can't reach
      // the remote bundle. Mark expired in DB anyway so the row
      // doesn't stay decorative forever.
      await app.db.update(backupJobs).set({ status: 'expired' }).where(eq(backupJobs.id, id));
      expiredDeleted++;
      continue;
    }
    try {
      const store = await resolveStoreForTarget(app, targetConfigId);
      const handle = await store.open(id);
      if (handle) {
        await store.delete(handle);
      }
      // (handle === null) → already gone on remote; still mark expired.
      await app.db.update(backupJobs).set({ status: 'expired' }).where(eq(backupJobs.id, id));
      expiredDeleted++;
    } catch (err) {
      app.log.error({ err, bundleId: id, targetConfigId }, 'tenant-backup retention: failed to delete expired bundle on remote — leaving status untouched for next-tick retry');
      expiredFailed++;
    }
  }

  // ── 2. Stuck `running` bundles older than 24h ─────────────────────
  // The orchestrator never crashes mid-bundle in normal operation
  // (it wraps each phase in try/catch and writes 'failed' on error).
  // But pod kills (OOM, eviction) can leave 'running' rows behind
  // forever. 24h is far longer than any legitimate bundle should
  // take; anything past that is definitely stuck.
  const cutoff = new Date(Date.now() - STUCK_RUNNING_HOURS * 60 * 60 * 1000);
  const stuckRes = await app.db.execute(sql`
    UPDATE backup_jobs
    SET status = 'failed',
        last_error = ${`stuck in 'running' for >${STUCK_RUNNING_HOURS}h — orchestrator pod likely killed mid-bundle. Re-trigger from the bundle list.`},
        finished_at = COALESCE(finished_at, now()),
        updated_at = now()
    WHERE status = 'running'
      AND started_at < ${cutoff}
    RETURNING id
  `) as unknown as { rows: Array<{ id: string }> };
  stuckMarkedFailed = stuckRes.rows.length;
  if (stuckMarkedFailed > 0) {
    app.log.warn({ count: stuckMarkedFailed, ids: stuckRes.rows.map((r) => r.id) }, 'tenant-backup retention: marked stuck running bundles as failed');
  }

  return { expiredDeleted, expiredFailed, stuckMarkedFailed };
}

/**
 * Schedule a periodic sweep. 5-min tick is plenty — bundles linger
 * on remote for 5 min past expiry which is well within any sensible
 * retention SLO. Returns the timer handle so callers can cancel
 * during graceful shutdown.
 */
export function startRetentionScheduler(app: FastifyInstance, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const r = await runRetentionSweep(app);
      if (r.expiredDeleted > 0 || r.stuckMarkedFailed > 0 || r.expiredFailed > 0) {
        app.log.info({ ...r }, 'tenant-backup retention: sweep complete');
      }
    } catch (err) {
      app.log.error({ err }, 'tenant-backup retention: sweep tick failed');
    }
  };
  // First tick fires immediately so a freshly-started platform-api
  // doesn't wait 5 min before sweeping.
  void tick();
  return setInterval(tick, intervalMs);
}

async function resolveStoreForTarget(app: FastifyInstance, targetConfigId: string): Promise<BackupStore> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.id, targetConfigId)).limit(1);
  if (!cfg) throw new Error(`Backup target ${targetConfigId} not found`);
  const configuredKey = (app.config as Record<string, unknown>).OIDC_ENCRYPTION_KEY as string | undefined
    ?? process.env.OIDC_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_ENCRYPTION_KEY is not configured in production');
  }
  const encKey = configuredKey ?? '0'.repeat(64);
  if (cfg.storageType === 's3') {
    let accessKey = '';
    let secretKey = '';
    try {
      accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, encKey) : '';
      secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, encKey) : '';
    } catch {
      throw new Error(`S3 credential decryption failed for target ${targetConfigId}`);
    }
    if (!accessKey || !secretKey) throw new Error(`S3 credentials missing on target ${targetConfigId}`);
    return new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  }
  if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new Error(`SSH target ${targetConfigId} missing required fields`);
    }
    let privateKey = '';
    try {
      privateKey = decrypt(cfg.sshKeyEncrypted, encKey);
    } catch {
      throw new Error(`SSH key decryption failed for target ${targetConfigId}`);
    }
    return new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey,
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  }
  throw new Error(`Unsupported storage type '${cfg.storageType}' on target ${targetConfigId}`);
}
