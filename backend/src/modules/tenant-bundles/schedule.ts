/**
 * Tenant Backup Tier-1/3 scheduler.
 *
 * Reads `client_backup_schedules` and ticks one bundle per client
 * whose `last_run_at` is older than the requested frequency. The
 * tick runs every 5 min on every platform-api replica; we use a
 * `lastRunAt` claim-and-update pattern to serialise across replicas
 * (one row update wins; the other replica skips this tick).
 *
 * Frequencies:
 *   daily    → next run when last_run_at < now - 23h
 *   weekly   → next run when last_run_at < now - (7d - 1h)
 *   monthly  → next run when last_run_at < now - (30d - 1h)
 *
 * The "1h slack" gives the tick window before the strict window
 * boundary so the scheduler doesn't fight a clock skew between
 * replicas. dayOfWeek / dayOfMonth / hourOfDayUtc are advisory
 * fields the cluster operator can use as "preferred starts" but
 * the simple last_run_at delta is the authoritative gate.
 *
 * Failure handling: a failing run sets last_run_status='failed'
 * which leaves the schedule eligible to retry on the NEXT tick (5
 * min later). Persistent failures will NOT block other clients —
 * the loop catches per-client errors.
 */

import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { clientBackupSchedules, backupConfigurations } from '../../db/schema.js';
import { runBundle } from './orchestrator.js';
import { decrypt } from '../oidc/crypto.js';
import { S3BackupStore } from './s3-backup-store.js';
import { SshBackupStore } from './ssh-backup-store.js';
import type { BackupStore } from './bundle-store.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

// Hours of slack before the strict frequency boundary.
const SLACK_HOURS = 1;

export interface ScheduleTickResult {
  readonly considered: number;
  readonly ranBundles: number;
  readonly errors: number;
}

export async function runScheduleTick(app: FastifyInstance): Promise<ScheduleTickResult> {
  const due = await app.db.execute(sql`
    SELECT s.client_id          AS "clientId",
           s.frequency,
           s.retention_days     AS "retentionDays",
           s.last_run_at        AS "lastRunAt"
    FROM client_backup_schedules s
    INNER JOIN clients c ON c.id = s.client_id
    WHERE s.enabled = TRUE
      AND c.status = 'active'
      AND (
            s.last_run_at IS NULL
        OR (s.frequency = 'daily'   AND s.last_run_at < now() - INTERVAL '${sql.raw(String(24 - SLACK_HOURS))} hours')
        OR (s.frequency = 'weekly'  AND s.last_run_at < now() - INTERVAL '${sql.raw(String(7 * 24 - SLACK_HOURS))} hours')
        OR (s.frequency = 'monthly' AND s.last_run_at < now() - INTERVAL '${sql.raw(String(30 * 24 - SLACK_HOURS))} hours')
      )
    ORDER BY s.last_run_at NULLS FIRST
    LIMIT 50
  `) as unknown as { rows: Array<{ clientId: string; frequency: string; retentionDays: number; lastRunAt: string | null }> };

  let considered = 0;
  let ranBundles = 0;
  let errors = 0;

  for (const row of due.rows) {
    considered++;
    const claim = await app.db.execute(sql`
      UPDATE client_backup_schedules
      SET last_run_at = now(),
          last_run_status = 'running'::backup_job_status,
          updated_at = now()
      WHERE client_id = ${row.clientId}
        AND (last_run_at IS NULL OR last_run_at = ${row.lastRunAt})
      RETURNING client_id
    `) as unknown as { rows: Array<{ client_id: string }> };
    if (claim.rows.length === 0) continue; // lost race
    try {
      await runOneScheduledBundle(app, row.clientId, row.retentionDays);
      await app.db.update(clientBackupSchedules)
        .set({ lastRunStatus: 'completed' })
        .where(eq(clientBackupSchedules.clientId, row.clientId));
      ranBundles++;
    } catch (err) {
      errors++;
      app.log.error({ err, clientId: row.clientId }, 'tenant-backup schedule: scheduled bundle failed');
      await app.db.update(clientBackupSchedules)
        .set({ lastRunStatus: 'failed' })
        .where(eq(clientBackupSchedules.clientId, row.clientId));
      // Notify platform operators (super_admin + admin) so a
      // persistent schedule failure is page-able rather than buried
      // in last_run_status. Fire-and-forget; notification failure
      // does NOT regress the tick or other clients in the loop.
      try {
        const { resolveRecipients } = await import('../notifications/recipients.js');
        const { notifyUsers } = await import('../notifications/service.js');
        const recipients = await resolveRecipients(app.db, { kind: 'admin' });
        await notifyUsers(app.db, recipients, {
          type: 'error',
          title: `Scheduled backup failed`,
          message: `The ${row.frequency} scheduled backup for client ${row.clientId} failed: ${(err as Error).message}. The next tick (5 min) will retry; check the bundle list and the platform-api logs for details.`,
          resourceType: 'client',
          resourceId: row.clientId,
        });
      } catch (notifyErr) {
        app.log.warn({ err: notifyErr, clientId: row.clientId }, 'tenant-backup schedule: failure-notification dispatch failed');
      }
    }
  }

  return { considered, ranBundles, errors };
}

async function runOneScheduledBundle(app: FastifyInstance, clientId: string, retentionDays: number): Promise<void> {
  const [cfg] = await app.db.select().from(backupConfigurations).where(eq(backupConfigurations.active, true)).limit(1);
  if (!cfg) throw new Error('no active backup target — schedule cannot fire');

  const platformVersion = (app.config as Record<string, unknown>).PLATFORM_VERSION as string | undefined ?? '0.0.0';
  const configuredKey = (app.config as Record<string, unknown>).PLATFORM_ENCRYPTION_KEY as string | undefined
    ?? process.env.PLATFORM_ENCRYPTION_KEY;
  if (!configuredKey && process.env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_ENCRYPTION_KEY required in production for scheduled bundles');
  }
  const secretsKeyHex = configuredKey ?? '0'.repeat(64);

  let store: BackupStore;
  if (cfg.storageType === 's3') {
    const accessKey = cfg.s3AccessKeyEncrypted ? decrypt(cfg.s3AccessKeyEncrypted, secretsKeyHex) : '';
    const secretKey = cfg.s3SecretKeyEncrypted ? decrypt(cfg.s3SecretKeyEncrypted, secretsKeyHex) : '';
    store = new S3BackupStore({
      bucket: cfg.s3Bucket ?? '',
      region: cfg.s3Region ?? 'us-east-1',
      endpoint: cfg.s3Endpoint ?? undefined,
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      pathPrefix: cfg.s3Prefix ?? undefined,
    });
  } else if (cfg.storageType === 'ssh') {
    if (!cfg.sshHost || !cfg.sshUser || !cfg.sshKeyEncrypted || !cfg.sshPath) {
      throw new Error(`SSH target ${cfg.id} missing required fields`);
    }
    store = new SshBackupStore({
      host: cfg.sshHost,
      port: cfg.sshPort ?? 22,
      user: cfg.sshUser,
      privateKey: decrypt(cfg.sshKeyEncrypted, secretsKeyHex),
      basePath: cfg.sshPath,
      logFn: (level, ctx, msg) => app.log[level](ctx, msg),
    });
  } else {
    throw new Error(`Unsupported storage type '${cfg.storageType}' for scheduled bundle`);
  }

  let k8s;
  try {
    k8s = createK8sClients((app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined);
  } catch {
    k8s = undefined;
  }

  const platformApiUrl = (app.config as Record<string, unknown>).PLATFORM_API_INTERNAL_URL as string | undefined
    ?? process.env.PLATFORM_API_INTERNAL_URL
    ?? 'http://platform-api.platform.svc:3000';

  await runBundle(
    {
      db: app.db,
      k8s,
      store,
      platformVersion,
      secretsKeyHex,
      platformApiUrl,
      // Phase 1.5+ (ADR-036): scheduled runs tag with region id
      // and persist tenant_restic_repo_state.
      platformBaseDomain: (app.config as Record<string, unknown>).PLATFORM_BASE_DOMAIN as string | undefined
        ?? (app.config as Record<string, unknown>).INGRESS_BASE_DOMAIN as string | undefined,
      kubeconfigPath: (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined,
    },
    {
      clientId,
      initiator: 'system',
      systemTrigger: 'scheduled',
      label: 'scheduled',
      description: null,
      retentionDays,
      targetConfigId: cfg.id,
      targetUri: `${cfg.storageType}://${cfg.id}`,
      components: { files: true, mailboxes: true, config: true, secrets: true },
    },
  );
}

export function startBackupScheduleTick(app: FastifyInstance, intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      const r = await runScheduleTick(app);
      if (r.considered > 0 || r.errors > 0) {
        app.log.info({ ...r }, 'tenant-backup schedule: tick complete');
      }
    } catch (err) {
      app.log.error({ err }, 'tenant-backup schedule: tick failed');
    }
  };
  void tick();
  return setInterval(tick, intervalMs);
}
