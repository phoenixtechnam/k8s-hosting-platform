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
import { eq, sql } from 'drizzle-orm';
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

  // Fire and forget. runExport handles its own errors + DB updates.
  void runExport(runId, input, logger);

  return {
    runId,
    status: 'pending',
    pollUrl: `/api/v1/system-backup/secrets/runs/${runId}`,
  };
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
  // Stage 2: single-statement atomic claim. RETURNING gives us the
  // payload only when the UPDATE matched all WHERE clauses.
  const result = await db.execute<{
    payload: Buffer;
    sha256: string;
    size_bytes: number;
    manifest: unknown;
  }>(sql`
    UPDATE system_backup_runs
       SET downloaded_at      = now(),
           payload            = NULL,
           download_token_raw = NULL,
           updated_at         = now()
     WHERE id                      = ${verified.ok.runId}
       AND download_token_hash     = ${tokenHash}
       AND downloaded_at           IS NULL
       AND status                  = 'succeeded'
       AND download_url_expires_at > now()
       AND payload                 IS NOT NULL
     RETURNING payload, sha256, size_bytes, manifest
  `);
  const rows = (result as unknown as { rows: Array<{
    payload: Buffer;
    sha256: string;
    size_bytes: number;
    manifest: unknown;
  }> }).rows;
  if (rows.length === 0) return null;
  const r = rows[0];
  // Defence-in-depth: validate Buffer at runtime in case the pg type
  // parser was reconfigured (would arrive as a hex string with \x prefix).
  if (!Buffer.isBuffer(r.payload)) {
    return null;
  }
  return {
    payload: r.payload,
    sha256: r.sha256,
    sizeBytes: r.size_bytes,
    manifest: (r.manifest as BundleManifestItem[]) ?? [],
  };
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
