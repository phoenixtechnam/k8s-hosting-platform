/**
 * Phase 3 T2.1 — IMAPSync job runner service.
 *
 * One-shot Kubernetes Jobs that migrate mail from an external IMAP
 * server INTO an existing platform mailbox. Standard onboarding
 * path for customers coming from Gmail / Outlook / legacy hosting.
 *
 * Key design decisions (see plan + 0015 migration):
 *   - Source password encrypted at rest with OIDC_ENCRYPTION_KEY.
 *   - Per-job Kubernetes Secret holds source + dest passwords as
 *     env vars (envFrom) so they never appear in `args` or in
 *     `kubectl describe pod` output.
 *   - Destination uses Stalwart's `master` SSO via the
 *     `<mailbox>%master` user convention with MASTER_SECRET, so
 *     we never need the mailbox cleartext password.
 *   - Concurrency: enforced by a partial unique DB index
 *     `(mailbox_id) WHERE status IN ('pending','running')`. The
 *     application catches the unique violation and surfaces a 409
 *     IMAPSYNC_ALREADY_RUNNING — no race window between read and
 *     insert.
 */

import crypto from 'crypto';
import { eq, and, desc, inArray, lt, sql } from 'drizzle-orm';
import type { V1Job, V1Secret } from '@kubernetes/client-node';
import {
  imapSyncJobs,
  mailboxes,
  type ImapSyncJob,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt } from '../oidc/crypto.js';
import { notifyClientImapsyncTerminal } from '../notifications/events.js';
import type { Database } from '../../db/index.js';
import type { CreateImapSyncJobInput, UpdateImapSyncJobInput, ImapSyncJobResponse } from '@k8s-hosting/api-contracts';
import {
  MAX_ACTIVE_IMAPSYNC_JOBS,
  MAX_TOTAL_IMAPSYNC_JOBS,
  IMAPSYNC_JOB_RETENTION_DAYS,
} from '@k8s-hosting/api-contracts';

// Pinned image — operators can override via STALWART_IMAPSYNC_IMAGE
// env var if they need a different mirror or local image.
// The Docker Hub image only publishes `latest` — there is no
// version-tagged release. Pin to latest and track upstream
// releases manually.
export const DEFAULT_IMAPSYNC_IMAGE = 'gilleslamiral/imapsync:latest';

// imapsync supports --passfile1 / --passfile2 to read passwords from
// a file. We mount the per-job Secret as env vars and have the
// container's command read the env into a temp file before invoking
// imapsync. This matches the security guarantees in the plan: no
// passwords in `args`, no passwords in `kubectl describe`, no
// passwords on the imapsync command line visible to ps.
const IMAPSYNC_ENTRYPOINT = `
set -e
umask 077
mkdir -p /tmp/imapsync
printf '%s' "$SOURCE_PASSWORD" > /tmp/imapsync/p1
printf '%s' "$DEST_PASSWORD"   > /tmp/imapsync/p2
exec imapsync \\
  --passfile1 /tmp/imapsync/p1 \\
  --passfile2 /tmp/imapsync/p2 \\
  "$@"
`.trim();

// ─── Pure manifest builders ──────────────────────────────────────────────

export interface BuildJobManifestInput {
  readonly jobId: string;
  readonly secretName: string;
  readonly namespace: string;
  readonly mailboxAddress: string;
  readonly sourceHost: string;
  readonly sourcePort: number;
  readonly sourceUsername: string;
  readonly sourceSsl: boolean;
  readonly destHost: string;
  readonly destPort: number;
  readonly options: {
    readonly automap?: boolean;
    readonly noFolderSizes?: boolean;
    readonly dryRun?: boolean;
    readonly excludeFolders?: readonly string[];
  };
  readonly image: string;
}

export function buildJobManifest(input: BuildJobManifestInput): V1Job {
  const args: string[] = [
    '--host1', input.sourceHost,
    '--port1', String(input.sourcePort),
    '--user1', input.sourceUsername,
    '--host2', input.destHost,
    '--port2', String(input.destPort),
    // Stalwart master SSO — `<mailbox>%master` authenticates as the
    // mailbox owner using MASTER_SECRET.
    '--user2', `${input.mailboxAddress}%master`,
    // Always disable telemetry / pings against the imapsync home
    // server even though the privately-hosted image generally has
    // them off.
    '--noreleasecheck',
    '--nofoldersizesatend',
  ];
  if (input.sourceSsl) args.push('--ssl1');
  if (input.options.automap) args.push('--automap');
  if (input.options.noFolderSizes) args.push('--nofoldersizes');
  if (input.options.dryRun) args.push('--dry');
  for (const folder of input.options.excludeFolders ?? []) {
    args.push('--exclude', folder);
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: `imapsync-${input.jobId}`,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'imapsync',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.io/job-id': input.jobId,
      },
    },
    spec: {
      backoffLimit: 0,
      // Auto-clean up after 1 hour past terminal state. Operator
      // can still grab logs from the DB row's `log_tail`.
      ttlSecondsAfterFinished: 3600,
      // IMAP Phase 4: wall-clock timeout. Without this a pod
      // stuck Pending (failed scheduling, ImagePullBackOff,
      // CrashLoopBackOff, etc.) would sit forever until an
      // operator manually cleaned it up. 2 hours is generous
      // enough for large mailbox migrations (imapsync typically
      // moves ~500 msg/min over fast links) but short enough
      // that a stuck job doesn't hold resources indefinitely.
      // When this deadline is exceeded the pod transitions to
      // Failed with reason `DeadlineExceeded` — which the
      // reconciler observes via `status.failed >= 1` and flips
      // the DB row to `failed` with the log tail attached.
      activeDeadlineSeconds: 7200,
      template: {
        metadata: {
          labels: {
            'app.kubernetes.io/name': 'imapsync',
            'platform.io/job-id': input.jobId,
          },
        },
        spec: {
          restartPolicy: 'Never',
          containers: [
            {
              name: 'imapsync',
              image: input.image,
              imagePullPolicy: 'IfNotPresent',
              // Override the image's default entrypoint with our
              // password-from-env shim. This keeps the cleartext
              // password out of `args`, out of `ps`, and out of
              // `kubectl describe`.
              command: ['sh', '-c', IMAPSYNC_ENTRYPOINT, '--'],
              args,
              envFrom: [{ secretRef: { name: input.secretName } }],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
            },
          ],
        },
      },
    },
  };
}

export interface BuildJobSecretInput {
  readonly jobId: string;
  readonly namespace: string;
  readonly sourcePassword: string;
  readonly destPassword: string;
}

export function buildJobSecret(input: BuildJobSecretInput): V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: `imapsync-${input.jobId}`,
      namespace: input.namespace,
      labels: {
        'app.kubernetes.io/name': 'imapsync',
        'app.kubernetes.io/managed-by': 'platform-api',
        'platform.io/job-id': input.jobId,
      },
    },
    stringData: {
      SOURCE_PASSWORD: input.sourcePassword,
      DEST_PASSWORD: input.destPassword,
    },
  };
}

// ─── DB-side service helpers ─────────────────────────────────────────────

function rowToResponse(row: ImapSyncJob): ImapSyncJobResponse {
  return {
    id: row.id,
    clientId: row.clientId,
    mailboxId: row.mailboxId,
    sourceHost: row.sourceHost,
    sourcePort: row.sourcePort,
    sourceUsername: row.sourceUsername,
    sourceSsl: row.sourceSsl === 1,
    options: (row.options ?? {}) as Record<string, unknown>,
    status: row.status as ImapSyncJobResponse['status'],
    k8sJobName: row.k8sJobName,
    k8sNamespace: row.k8sNamespace,
    logTail: row.logTail,
    errorMessage: row.errorMessage,
    // Round-4 Phase 3: progress columns from migration 0022.
    messagesTotal: row.messagesTotal ?? null,
    messagesTransferred: row.messagesTransferred ?? null,
    currentFolder: row.currentFolder ?? null,
    lastProgressAt: row.lastProgressAt ? row.lastProgressAt.toISOString() : null,
    // IMAP Phase 3: pod-level observability from migration 0023.
    podPhase: row.podPhase ?? null,
    podMessage: row.podMessage ?? null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Create a new pending IMAPSync job for a client's mailbox.
 *
 * Validates that the mailbox actually belongs to the client to
 * prevent cross-tenant access. Encrypts the source password at
 * rest. Returns the new row (passwords stripped).
 */
export async function createImapSyncJob(
  db: Database,
  encryptionKey: string,
  clientId: string,
  input: CreateImapSyncJobInput,
): Promise<ImapSyncJobResponse> {
  // Ownership check
  const [mb] = await db
    .select({
      id: mailboxes.id,
      clientId: mailboxes.clientId,
      fullAddress: mailboxes.fullAddress,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, input.mailbox_id));
  if (!mb || mb.clientId !== clientId) {
    throw new ApiError(
      'MAILBOX_NOT_FOUND',
      `Mailbox '${input.mailbox_id}' not found for client '${clientId}'`,
      404,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date();
  try {
    const [row] = await db
      .insert(imapSyncJobs)
      .values({
        id,
        clientId,
        mailboxId: input.mailbox_id,
        sourceHost: input.source_host,
        sourcePort: input.source_port,
        sourceUsername: input.source_username,
        sourcePasswordEncrypted: encrypt(input.source_password, encryptionKey),
        sourceSsl: input.source_ssl ? 1 : 0,
        options: input.options ?? {},
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return rowToResponse(row as ImapSyncJob);
  } catch (err: unknown) {
    const pgErr = err as { code?: string; message?: string };
    if (pgErr.code === '23505') {
      throw new ApiError(
        'IMAPSYNC_ALREADY_RUNNING',
        'Another IMAPSync job is already pending or running for this mailbox',
        409,
      );
    }
    throw err;
  }
}

/**
 * List IMAPSync jobs for a client, newest first. Capped at 100.
 * Passwords stripped before returning.
 */
export async function listImapSyncJobs(
  db: Database,
  clientId: string,
): Promise<readonly ImapSyncJobResponse[]> {
  const rows = await db
    .select()
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.clientId, clientId))
    .orderBy(desc(imapSyncJobs.createdAt))
    .limit(100);
  return rows.map(rowToResponse);
}

/**
 * Get a single IMAPSync job by id, scoped to a client. Returns null
 * if the job doesn't exist or belongs to a different client.
 */
export async function getImapSyncJob(
  db: Database,
  clientId: string,
  jobId: string,
): Promise<ImapSyncJobResponse | null> {
  const [row] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.clientId, clientId)));
  return row ? rowToResponse(row as ImapSyncJob) : null;
}

/**
 * Mark a job as cancelled in the DB. The K8s Job + Secret cleanup
 * happens in the routes layer (since it needs the K8s client
 * handle). Returns the updated row or null if the job is already
 * terminal.
 */
export async function markCancelled(
  db: Database,
  jobId: string,
): Promise<void> {
  // Look up clientId first so we can notify after the DB write.
  const [row] = await db
    .select({ clientId: imapSyncJobs.clientId })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.id, jobId));

  await db
    .update(imapSyncJobs)
    .set({
      status: 'cancelled',
      finishedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));

  if (row?.clientId) {
    void notifyClientImapsyncTerminal(db, row.clientId, {
      jobId,
      status: 'cancelled',
    });
  }
}

/**
 * Mark a pending job as running and record the K8s Job name.
 */
export async function markRunning(
  db: Database,
  jobId: string,
  k8sJobName: string,
): Promise<void> {
  await db
    .update(imapSyncJobs)
    .set({
      status: 'running',
      k8sJobName,
      startedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));
}

/**
 * Round-4 Phase 1: delete a terminal IMAPSync job row.
 *
 * Only allowed for jobs in `succeeded`, `failed`, or `cancelled`
 * status. Active jobs must be cancelled first via the existing
 * DELETE cancel endpoint. Returns the deleted row's identifying
 * info (clientId, status, k8sJobName, k8sNamespace) so the caller
 * can clean up any K8s residue without re-querying the DB. Returns
 * null if the row doesn't exist.
 *
 * Review HIGH-3 fix: previously the route called getImapSyncJob
 * THEN this function, both reading the same row. Returning the K8s
 * coordinates here lets the route skip the outer fetch and closes
 * the TOCTOU window between the two reads.
 */
export async function deleteTerminalJob(
  db: Database,
  clientId: string,
  jobId: string,
): Promise<{
  clientId: string;
  status: string;
  k8sJobName: string | null;
  k8sNamespace: string;
} | null> {
  const [row] = await db
    .select({
      clientId: imapSyncJobs.clientId,
      status: imapSyncJobs.status,
      k8sJobName: imapSyncJobs.k8sJobName,
      k8sNamespace: imapSyncJobs.k8sNamespace,
    })
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.clientId, clientId)));
  if (!row) return null;
  if (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'cancelled') {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot delete IMAPSync job in '${row.status}' state — cancel it first`,
      409,
      { status: row.status },
    );
  }
  await db.delete(imapSyncJobs).where(eq(imapSyncJobs.id, jobId));
  return {
    clientId: row.clientId,
    status: row.status,
    k8sJobName: row.k8sJobName,
    k8sNamespace: row.k8sNamespace,
  };
}

/**
 * Re-sync a terminal IMAPSync job by resetting it in-place. Clears
 * all progress/log/error fields and sets status back to 'pending'.
 * Reuses the same row ID. Returns the raw row for K8s Job creation.
 *
 * Concurrency check: the partial unique index on mailbox_id WHERE
 * status IN ('pending','running') prevents a resync if another job
 * is already active for the same mailbox.
 */
export async function resyncImapSyncJob(
  db: Database,
  clientId: string,
  jobId: string,
): Promise<ImapSyncJob> {
  const [original] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.clientId, clientId)));
  if (!original) {
    throw new ApiError(
      'IMAPSYNC_JOB_NOT_FOUND',
      `IMAPSync job '${jobId}' not found for client '${clientId}'`,
      404,
    );
  }
  if (
    original.status !== 'succeeded'
    && original.status !== 'failed'
    && original.status !== 'cancelled'
  ) {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot re-sync a job in '${original.status}' state — wait for it to finish or cancel it first`,
      409,
      { status: original.status },
    );
  }

  // Check active job limit per client
  await enforceActiveJobLimit(db, clientId);

  const now = new Date();
  const newK8sJobName = `imapsync-${jobId}-${now.getTime()}`;
  const [row] = await db
    .update(imapSyncJobs)
    .set({
      status: 'pending',
      k8sJobName: newK8sJobName,
      logTail: null,
      errorMessage: null,
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
      lastProgressAt: null,
      podPhase: null,
      podMessage: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    })
    .where(eq(imapSyncJobs.id, jobId))
    .returning();
  return row as ImapSyncJob;
}

/**
 * Enforce the per-client active job limit. Throws 429 if the
 * client already has MAX_ACTIVE_IMAPSYNC_JOBS pending/running.
 */
export async function enforceActiveJobLimit(
  db: Database,
  clientId: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(imapSyncJobs)
    .where(
      and(
        eq(imapSyncJobs.clientId, clientId),
        inArray(imapSyncJobs.status, ['pending', 'running']),
      ),
    );
  if (count >= MAX_ACTIVE_IMAPSYNC_JOBS) {
    throw new ApiError(
      'IMAPSYNC_ACTIVE_LIMIT',
      `Maximum ${MAX_ACTIVE_IMAPSYNC_JOBS} active sync jobs per client`,
      429,
    );
  }
}

/**
 * Enforce the per-client total job limit. Throws 429 if the client
 * already has MAX_TOTAL_IMAPSYNC_JOBS rows.
 */
export async function enforceTotalJobLimit(
  db: Database,
  clientId: string,
): Promise<void> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.clientId, clientId));
  if (count >= MAX_TOTAL_IMAPSYNC_JOBS) {
    throw new ApiError(
      'IMAPSYNC_TOTAL_LIMIT',
      `Maximum ${MAX_TOTAL_IMAPSYNC_JOBS} sync jobs per client — delete old jobs to create new ones`,
      429,
    );
  }
}

/**
 * Update a terminal job's source settings. Only allowed for jobs
 * in succeeded/failed/cancelled status. Re-encrypts the password
 * if provided.
 */
export async function updateImapSyncJob(
  db: Database,
  encryptionKey: string,
  clientId: string,
  jobId: string,
  input: UpdateImapSyncJobInput,
): Promise<ImapSyncJobResponse> {
  const [row] = await db
    .select()
    .from(imapSyncJobs)
    .where(and(eq(imapSyncJobs.id, jobId), eq(imapSyncJobs.clientId, clientId)));
  if (!row) {
    throw new ApiError('IMAPSYNC_JOB_NOT_FOUND', 'IMAPSync job not found', 404);
  }
  if (row.status !== 'succeeded' && row.status !== 'failed' && row.status !== 'cancelled') {
    throw new ApiError(
      'INVALID_STATE',
      `Cannot edit a job in '${row.status}' state — wait for it to finish or cancel it first`,
      409,
    );
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.source_host !== undefined) updates.sourceHost = input.source_host;
  if (input.source_port !== undefined) updates.sourcePort = input.source_port;
  if (input.source_username !== undefined) updates.sourceUsername = input.source_username;
  if (input.source_password !== undefined) {
    updates.sourcePasswordEncrypted = encrypt(input.source_password, encryptionKey);
  }
  if (input.source_ssl !== undefined) updates.sourceSsl = input.source_ssl ? 1 : 0;
  if (input.options !== undefined) updates.options = input.options;

  const [updated] = await db
    .update(imapSyncJobs)
    .set(updates)
    .where(eq(imapSyncJobs.id, jobId))
    .returning();
  return rowToResponse(updated as ImapSyncJob);
}

/**
 * Delete terminal jobs older than IMAPSYNC_JOB_RETENTION_DAYS.
 * Returns the number of rows deleted.
 */
export async function cleanupExpiredJobs(db: Database): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - IMAPSYNC_JOB_RETENTION_DAYS);

  const deleted = await db
    .delete(imapSyncJobs)
    .where(
      and(
        inArray(imapSyncJobs.status, ['succeeded', 'failed', 'cancelled']),
        lt(imapSyncJobs.finishedAt, cutoff),
      ),
    )
    .returning({ id: imapSyncJobs.id });
  return deleted.length;
}

/**
 * Mark a job as failed with an optional error message and log
 * tail. Used by the start flow if the K8s Job creation itself
 * fails.
 */
export async function markFailed(
  db: Database,
  jobId: string,
  errorMessage: string,
): Promise<void> {
  const [row] = await db
    .select({ clientId: imapSyncJobs.clientId })
    .from(imapSyncJobs)
    .where(eq(imapSyncJobs.id, jobId));

  await db
    .update(imapSyncJobs)
    .set({
      status: 'failed',
      errorMessage,
      finishedAt: new Date(),
    })
    .where(eq(imapSyncJobs.id, jobId));

  if (row?.clientId) {
    void notifyClientImapsyncTerminal(db, row.clientId, {
      jobId,
      status: 'failed',
      errorMessage,
    });
  }
}
