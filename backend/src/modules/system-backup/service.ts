/**
 * System Backup, Phase 1: secrets-bundle export service.
 *
 * Async pattern: route handler creates a `system_backup_runs` row in
 * status='pending', returns 202 + runId, fires `void runExport(...)`
 * to do the work in the background. UI polls GET /runs/:id.
 *
 * The work itself is fast (≲5 seconds for ~9 small Secrets) so we
 * don't need a Job pod here — unlike PITR which can take 10 minutes
 * and would self-kill the platform-api pod via liveness during
 * cutover.
 *
 * On success: payload (BYTEA) holds the age-encrypted bundle, sha256
 * + size + manifest are persisted, a download token is signed, and
 * BOTH the token (download_token_raw) and its hash (download_token_hash)
 * land in the row. Replication-safety: 3 platform-api replicas — any
 * one must be able to hand the operator the URL on GET /runs/:id. The
 * token + payload are wiped together by the atomic claim UPDATE on
 * first download.
 */

import type { Database } from '../../db/index.js';
import { systemBackupRuns, auditLogs } from '../../db/schema.js';
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { exportSecretsBundle, BUNDLE_SECRET_LIST, OPERATOR_KEY_SECRETS, type BundleManifestItem } from './secrets-bundle.js';
import { signDownloadToken, verifyDownloadToken, sha256Hex } from './download-token.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface ExportRunInput {
  readonly k8s: K8sClients;
  readonly db: Database;
  readonly jwtSecret: string;
  readonly operatorUserId: string;
  readonly operatorIp: string | null;
  readonly operatorUserAgent: string | null;
  readonly reason: string | null;
}

export interface CreateExportResult {
  readonly runId: string;
  readonly status: 'pending' | 'running';
  readonly pollUrl: string;
}

/** Default download-URL TTL. 15 minutes balances "operator gets the
 * download in their browser" against "URL leak window stays small". */
const DOWNLOAD_TTL_SECONDS = 15 * 60;

interface FastifyLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Create a new export run row + kick off the async work. Returns
 * immediately with the runId; the route handler returns 202.
 */
export async function createSecretsBundleExport(
  input: ExportRunInput,
  logger: FastifyLogger,
): Promise<CreateExportResult> {
  const runId = randomUUID();
  // Wrap the run-row + audit-log INSERTs in one transaction. If the
  // audit-log INSERT fails we WANT the run-row INSERT to roll back —
  // for a security-sensitive export we'd rather return 500 than ship
  // an unaudited bundle.
  await input.db.transaction(async (tx) => {
    await tx.insert(systemBackupRuns).values({
      id: runId,
      kind: 'secrets',
      status: 'pending',
      operatorUserId: input.operatorUserId,
      operatorIp: input.operatorIp,
      operatorUserAgent: input.operatorUserAgent,
    });
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actionType: 'system_backup_secrets_export',
      resourceType: 'system_backup_run',
      resourceId: runId,
      actorId: input.operatorUserId,
      actorType: 'user',
      httpMethod: 'POST',
      httpPath: '/api/v1/system-backup/secrets/export',
      httpStatus: 202,
      changes: { reason: input.reason },
      ipAddress: input.operatorIp ?? null,
    });
  });

  // Mirror to Task Tracker chip — best-effort, never throws. The
  // operator gets a chip row with `target.type='route'` so clicking
  // navigates to the system-backup runs page.
  await mirrorRunToTaskTracker(input.db, runId).catch((err) => {
    logger.warn({ err, runId }, '[system-backup] task tracker enroll failed');
  });

  // Fire and forget. runExport handles its own errors + DB updates.
  void runExport(runId, input, logger);

  return {
    runId,
    status: 'pending',
    pollUrl: `/api/v1/system-backup/secrets/runs/${runId}`,
  };
}

/**
 * Sync a `system_backup_runs` row into the Task Tracker chip via the
 * tasks helper. Idempotent on `(kind='backup.run', ref_id=runId)`.
 * Cron-driven runs (operatorUserId NULL — scheduled backups) are
 * `scope='system'` and stay bell-only per the UX agreement.
 */
async function mirrorRunToTaskTracker(db: Database, runId: string): Promise<void> {
  const [run] = await db
    .select({
      id: systemBackupRuns.id,
      kind: systemBackupRuns.kind,
      status: systemBackupRuns.status,
      operatorUserId: systemBackupRuns.operatorUserId,
      errorEnvelope: systemBackupRuns.errorEnvelope,
    })
    .from(systemBackupRuns)
    .where(eq(systemBackupRuns.id, runId))
    .limit(1);
  if (!run || !run.operatorUserId) return;

  const isTerminal = run.status === 'succeeded' || run.status === 'failed';
  const taskStatus: 'running' | 'succeeded' | 'failed' =
    !isTerminal ? 'running'
    : run.status === 'failed' ? 'failed'
    : 'succeeded';

  const { start: startTask, finishByRef } = await import('../tasks/service.js');
  const { toSafeText } = await import('@k8s-hosting/api-contracts');

  await startTask(db, {
    kind: 'backup.run',
    refId: run.id,
    scope: 'admin',
    userId: run.operatorUserId,
    label: toSafeText(`System backup (${run.kind})`),
    target: { type: 'route', href: '/settings/system-backup' },
    progressPct: taskStatus === 'succeeded' ? 100 : null,
    details: { kind: run.kind },
  });

  if (taskStatus !== 'running') {
    const errMsg = (run.errorEnvelope && typeof run.errorEnvelope === 'object'
      ? ((run.errorEnvelope as Record<string, unknown>).message as string | undefined)
      : null) ?? null;
    await finishByRef(db, 'backup.run', run.id, {
      status: taskStatus,
      error: taskStatus === 'failed' ? errMsg : null,
    });
  }
}

/**
 * The actual work: build bundle, sign download token, store payload.
 * Wraps everything in try/catch so a thrown error always lands in
 * the run row — never silently propagates to the unhandled rejection
 * handler.
 */
async function runExport(runId: string, input: ExportRunInput, logger: FastifyLogger): Promise<void> {
  try {
    await input.db.update(systemBackupRuns)
      .set({ status: 'running' })
      .where(eq(systemBackupRuns.id, runId));

    const bundle = await exportSecretsBundle({ k8s: input.k8s });
    const signed = signDownloadToken({ runId, ttlSeconds: DOWNLOAD_TTL_SECONDS }, input.jwtSecret);

    await input.db.update(systemBackupRuns)
      .set({
        status: 'succeeded',
        finishedAt: new Date(),
        sizeBytes: bundle.sizeBytes,
        sha256: bundle.sha256,
        manifest: bundle.manifest as unknown as Record<string, unknown>,
        payload: bundle.payload,
        downloadTokenHash: signed.tokenHash,
        downloadTokenRaw: signed.token,
        downloadUrlExpiresAt: signed.expiresAt,
      })
      .where(eq(systemBackupRuns.id, runId));

    logger.info({ runId, sizeBytes: bundle.sizeBytes, sha256: bundle.sha256 }, '[system-backup] secrets export complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId }, '[system-backup] secrets export failed');
    await input.db.update(systemBackupRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorEnvelope: { code: 'SYSTEM_BACKUP_EXPORT_FAILED', message: msg } as unknown as Record<string, unknown>,
      })
      .where(eq(systemBackupRuns.id, runId));
  }
  // Mirror terminal status into the chip task. Best-effort: a tracker
  // failure must not propagate into runExport since callers already
  // returned. Without this, the chip stays at status='running' forever
  // and only the 24h orphan reaper resolves it.
  try {
    await mirrorRunToTaskTracker(input.db, runId);
  } catch (taskErr) {
    logger.warn(
      { err: taskErr instanceof Error ? taskErr.message : String(taskErr), runId },
      '[system-backup] task tracker finalize failed (non-fatal)',
    );
  }
}

/**
 * Atomically claim a download token. Two-stage:
 *   1. verifyDownloadToken — HMAC-SHA256 + expiry check, in-process.
 *      Without this, the only authenticity guarantee at download time
 *      is the sha256(token) DB lookup, which is pre-image resistance,
 *      NOT what HMAC was designed for.
 *   2. UPDATE…RETURNING by sha256(token) — atomic single-use claim.
 *      Wipes payload + download_token_raw + sets downloaded_at in the
 *      SAME statement so a second download sees no matching row.
 *
 * Returns null if the token fails MAC verify, is expired, has been
 * used, or its row doesn't exist. Callers MUST NOT distinguish these
 * cases to the client (single 410 response — no oracle).
 */
export async function claimDownloadToken(
  db: Database,
  rawToken: string,
  jwtSecret: string,
): Promise<{ payload: Buffer; sha256: string; sizeBytes: number; manifest: BundleManifestItem[] } | null> {
  // Stage 1: HMAC verify. Cheap, in-process; defends against attackers
  // who would otherwise rely on guessing valid (runId, expiresMs)
  // tuples + raw-token entropy alone.
  const verified = verifyDownloadToken(rawToken, jwtSecret);
  if ('err' in verified) return null;

  const tokenHash = sha256Hex(rawToken);
  // Stage 2: atomic claim. Postgres UPDATE…RETURNING returns the NEW
  // post-update column values, so a single-statement claim that sets
  // `payload = NULL` would always return NULL — exactly the bug the
  // first cut hit. Instead we wrap in a transaction:
  //   1. SELECT … FOR UPDATE — row-locks the candidate; concurrent
  //      claimers wait or fail the WHERE.
  //   2. UPDATE — wipes payload + token, marks downloaded_at.
  // Both run inside the same tx, so a second claimer either:
  //   - sees the row pre-UPDATE and is row-blocked, then the WHERE
  //     re-evaluates against the committed state and matches 0 rows;
  //   - or sees the post-UPDATE state directly and matches 0 rows.
  // Either way single-use is preserved AND the route gets the OLD
  // payload before it's wiped.
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({
        id: systemBackupRuns.id,
        payload: systemBackupRuns.payload,
        sha256: systemBackupRuns.sha256,
        sizeBytes: systemBackupRuns.sizeBytes,
        manifest: systemBackupRuns.manifest,
      })
      .from(systemBackupRuns)
      .where(and(
        eq(systemBackupRuns.id, verified.ok.runId),
        eq(systemBackupRuns.downloadTokenHash, tokenHash),
        isNull(systemBackupRuns.downloadedAt),
        eq(systemBackupRuns.status, 'succeeded'),
        gt(systemBackupRuns.downloadUrlExpiresAt, new Date()),
        isNotNull(systemBackupRuns.payload),
      ))
      .for('update')
      .limit(1);
    if (candidates.length === 0) return null;
    const r = candidates[0];
    if (!r.payload || !Buffer.isBuffer(r.payload)) return null;
    await tx
      .update(systemBackupRuns)
      .set({
        downloadedAt: new Date(),
        payload: null,
        downloadTokenRaw: null,
      })
      .where(eq(systemBackupRuns.id, r.id));
    return {
      payload: r.payload,
      sha256: r.sha256 ?? '',
      sizeBytes: r.sizeBytes ?? 0,
      manifest: (r.manifest as BundleManifestItem[] | null) ?? [],
    };
  });
}

/**
 * Read-only manifest of what the next bundle WOULD include. Probes
 * each Secret with a HEAD-equivalent (read + discard data). Recipient
 * is also surfaced so the operator can pre-confirm against their
 * stored age public key. Probes run in parallel — these are 10
 * independent kube reads with no ordering dependency.
 */
export async function readManifest(
  k8s: K8sClients,
): Promise<{
  items: Array<{ namespace: string; name: string; kind: 'Secret' | 'OperatorKey'; present: boolean }>;
  operatorRecipient: string | null;
}> {
  const core = k8s.core as unknown as {
    readNamespacedSecret: (a: { namespace: string; name: string }) => Promise<unknown>;
    readNamespacedConfigMap: (a: { namespace: string; name: string }) => Promise<{ data?: Record<string, string> }>;
  };

  const probes = await Promise.all([
    ...BUNDLE_SECRET_LIST.map(async (s) => ({
      namespace: s.namespace,
      name: s.name,
      kind: 'Secret' as const,
      present: await core.readNamespacedSecret({ namespace: s.namespace, name: s.name })
        .then(() => true)
        .catch(() => false),
    })),
    ...OPERATOR_KEY_SECRETS.map(async (s) => ({
      namespace: s.namespace,
      name: s.name,
      kind: 'OperatorKey' as const,
      present: await core.readNamespacedSecret({ namespace: s.namespace, name: s.name })
        .then(() => true)
        .catch(() => false),
    })),
  ]);

  const operatorRecipient = await core.readNamespacedConfigMap({
    namespace: 'platform',
    name: 'platform-operator-recipient',
  })
    .then((cm) => cm.data?.recipient ?? null)
    .catch(() => null);

  return { items: probes, operatorRecipient };
}
