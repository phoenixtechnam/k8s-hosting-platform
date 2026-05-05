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
 * + size + manifest are persisted, a download token is signed and
 * its sha256 stored. Returns runId; UI fetches the row → unwraps
 * downloadUrl using the in-memory token (not persisted).
 */

import type { Database } from '../../db/index.js';
import { systemBackupRuns, auditLogs } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { exportSecretsBundle, BUNDLE_SECRET_LIST, OPERATOR_KEY_SECRETS, type BundleManifestItem } from './secrets-bundle.js';
import { signDownloadToken, sha256Hex } from './download-token.js';
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
  await input.db.insert(systemBackupRuns).values({
    id: runId,
    kind: 'secrets',
    status: 'pending',
    operatorUserId: input.operatorUserId,
    operatorIp: input.operatorIp,
    operatorUserAgent: input.operatorUserAgent,
  });

  // Audit-log the export attempt before any work starts. Reason is a
  // free-form string for the operator's own log trail.
  await input.db.insert(auditLogs).values({
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
  }).catch((err) => {
    // Audit-log failure must NOT block the export — but log loudly
    // so operations notice a missing trail.
    logger.error({ err, runId }, '[system-backup] failed to write audit log for export');
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
      .set({ status: 'running', updatedAt: new Date() })
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
        downloadUrlExpiresAt: signed.expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(systemBackupRuns.id, runId));

    // Stash the unhashed token in an in-process map so the UI can
    // fetch it once. We never persist the unhashed token — see
    // pendingTokenForRun() below.
    pendingTokens.set(runId, { token: signed.token, expiresAt: signed.expiresAt });
    logger.info({ runId, sizeBytes: bundle.sizeBytes, sha256: bundle.sha256 }, '[system-backup] secrets export complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId }, '[system-backup] secrets export failed');
    await input.db.update(systemBackupRuns)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorEnvelope: { code: 'SYSTEM_BACKUP_EXPORT_FAILED', message: msg } as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(systemBackupRuns.id, runId));
  }
}

/**
 * In-process map of unhashed download tokens. Populated by runExport
 * on success; consumed once by the route handler and immediately
 * deleted. The hashed token is the durable artifact in the DB row.
 *
 * Eviction: a periodic sweep removes entries past their expiry.
 */
const pendingTokens = new Map<string, { token: string; expiresAt: Date }>();

setInterval(() => {
  const now = Date.now();
  for (const [runId, entry] of pendingTokens) {
    if (entry.expiresAt.getTime() <= now) pendingTokens.delete(runId);
  }
}, 60_000).unref();

/** Pop and return the unhashed token for a runId, or null if absent. */
export function pendingTokenForRun(runId: string): { token: string; expiresAt: Date } | null {
  const entry = pendingTokens.get(runId);
  if (!entry) return null;
  if (entry.expiresAt.getTime() <= Date.now()) {
    pendingTokens.delete(runId);
    return null;
  }
  return entry;
}

/**
 * Atomically claim a download token: looks up by sha256(token),
 * verifies expiry + null downloaded_at, returns the payload, sets
 * downloaded_at = now() AND payload = NULL in the SAME UPDATE so a
 * second download fails. Returns null if the token is invalid /
 * already used / expired.
 */
export async function claimDownloadToken(
  db: Database,
  rawToken: string,
): Promise<{ payload: Buffer; sha256: string; sizeBytes: number; manifest: BundleManifestItem[] } | null> {
  const tokenHash = sha256Hex(rawToken);
  // Single-statement atomic claim. RETURNING gives us the payload only
  // when the UPDATE succeeded (i.e. the row matched all WHERE clauses).
  const result = await db.execute<{
    payload: Buffer;
    sha256: string;
    size_bytes: number;
    manifest: unknown;
  }>(sql`
    UPDATE system_backup_runs
       SET downloaded_at = now(),
           payload       = NULL,
           updated_at    = now()
     WHERE download_token_hash    = ${tokenHash}
       AND downloaded_at          IS NULL
       AND status                 = 'succeeded'
       AND download_url_expires_at > now()
       AND payload                IS NOT NULL
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
 * stored age public key.
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

  const items: Array<{ namespace: string; name: string; kind: 'Secret' | 'OperatorKey'; present: boolean }> = [];
  for (const s of BUNDLE_SECRET_LIST) {
    const present = await core.readNamespacedSecret({ namespace: s.namespace, name: s.name })
      .then(() => true)
      .catch(() => false);
    items.push({ namespace: s.namespace, name: s.name, kind: 'Secret', present });
  }
  for (const s of OPERATOR_KEY_SECRETS) {
    const present = await core.readNamespacedSecret({ namespace: s.namespace, name: s.name })
      .then(() => true)
      .catch(() => false);
    items.push({ namespace: s.namespace, name: s.name, kind: 'OperatorKey', present });
  }

  const operatorRecipient = await core.readNamespacedConfigMap({
    namespace: 'platform',
    name: 'platform-operator-recipient',
  })
    .then((cm) => cm.data?.recipient ?? null)
    .catch(() => null);

  return { items, operatorRecipient };
}
