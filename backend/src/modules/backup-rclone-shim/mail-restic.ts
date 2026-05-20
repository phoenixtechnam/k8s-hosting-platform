/**
 * mail-restic via shim reconciler (R-X8).
 *
 * When the new 3-class `mail` shim binding is set, this reconciler
 * owns the `mail/stalwart-snapshot-restic-repo` Secret and writes
 * shim-targeting restic env vars:
 *
 *      RESTIC_REPOSITORY = s3:http://shim:9000/mail-raw/mail-snapshots
 *      RESTIC_PASSWORD   = base64(BACKUP_TARGET_KEY)              [HKDF-aligned]
 *      AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY = HKDF-derived from BACKUP_TARGET_KEY
 *
 * Coexistence with the legacy `system_mail` (4-class) path
 * (mail-admin/mail-target-sync.ts):
 *   - If `mail` class is bound → this reconciler takes ownership.
 *   - If only legacy `system_mail` is bound → legacy reconciler owns
 *     the Secret. This reconciler reports STATE_NO_MAIL_TARGET +
 *     does NOT touch the Secret (no conflict).
 *   - If BOTH are bound → this reconciler logs a warning + still
 *     defers to legacy. Operators are expected to migrate by
 *     deleting the legacy row, then the next tick of this reconciler
 *     picks up cleanly. CI guard 14 enforces operator awareness
 *     via docs.
 *
 * The shim's `s3://mail-raw` bucket is a passthrough alias (no
 * rclone-crypt wrapping) — restic already encrypts its repo. Using
 * the `-raw` variant avoids the double-encryption + storage-overhead
 * RFC §13a-i identifies.
 */

import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import {
  deriveResticPassword,
  deriveShimAccessKey,
  deriveShimSecretKey,
} from './crypto.js';
import {
  loadBackupTargetKey,
  ShimKeyMissingError,
  SHIM_NAMESPACE,
} from './service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mail namespace where the Stalwart snapshot CronJob runs. */
export const MAIL_NAMESPACE = 'mail';

/** Secret name the snapshot upload sidecar reads. The legacy
 *  mail-target-sync.ts owns the same name when binding via
 *  `system_mail`; this reconciler defers to it when the 3-class
 *  `mail` row is absent. See module header. */
export const MAIL_RESTIC_SECRET_NAME = 'stalwart-snapshot-restic-repo';

/** Shim raw bucket — no rclone-crypt wrapping (restic encrypts).
 *  See RFC §13a-i for the encrypted-vs-raw bucket rationale. */
export const MAIL_SHIM_BUCKET = 'mail-raw';
export const MAIL_SHIM_PREFIX = 'mail-snapshots';

export const SHIM_S3_ENDPOINT_URL = `http://backup-rclone-shim.${SHIM_NAMESPACE}.svc.cluster.local:9000`;

/** Identifier on every reconciler-managed resource. */
export const MAIL_RESTIC_FIELD_MANAGER = 'platform-api-mail-restic-shim';

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

export interface MailResticShimEnv {
  readonly RESTIC_REPOSITORY: string;
  readonly RESTIC_PASSWORD: string;
  readonly AWS_ACCESS_KEY_ID: string;
  readonly AWS_SECRET_ACCESS_KEY: string;
}

/**
 * Emit the restic env-var map the Stalwart snapshot CronJob's
 * upload sidecar consumes. Pure over `rawKey` — exported so tests
 * can lock the output byte-equal across releases without spinning
 * up a real cluster.
 */
export function buildMailResticShimEnv(rawKey: Buffer): MailResticShimEnv {
  return {
    RESTIC_REPOSITORY: `s3:${SHIM_S3_ENDPOINT_URL}/${MAIL_SHIM_BUCKET}/${MAIL_SHIM_PREFIX}`,
    RESTIC_PASSWORD: deriveResticPassword(rawKey),
    AWS_ACCESS_KEY_ID: deriveShimAccessKey(rawKey),
    AWS_SECRET_ACCESS_KEY: deriveShimSecretKey(rawKey),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MailResticShimClients {
  readonly core: k8s.CoreV1Api;
}

export interface MailResticShimResult {
  readonly state:
    | 'STATE_OK'
    | 'STATE_MISSING_KEY'
    | 'STATE_NO_MAIL_TARGET'
    | 'STATE_LEGACY_TAKING_OVER'
    | 'STATE_ERROR';
  readonly errorMessage: string;
  readonly secretApplied: boolean;
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export async function reconcileMailResticShim(
  db: Database,
  clients: MailResticShimClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<MailResticShimResult> {
  // 1. Determine class bindings.
  const newMail = await isClassBound(db, 'mail');
  const legacy = await isClassBound(db, 'system_mail');

  if (!newMail && legacy) {
    // Legacy reconciler (mail-target-sync.ts) owns the Secret.
    return {
      state: 'STATE_LEGACY_TAKING_OVER',
      errorMessage: '',
      secretApplied: false,
    };
  }

  if (!newMail && !legacy) {
    // Neither class is bound. Don't touch the Secret — operator may
    // have configured it manually for a transition window. The
    // sidecar already handles RESTIC_REPOSITORY="" gracefully.
    return {
      state: 'STATE_NO_MAIL_TARGET',
      errorMessage: '',
      secretApplied: false,
    };
  }

  if (newMail && legacy) {
    // Conflict: both classes bound. Defer to the legacy reconciler
    // until the operator cleans up. Log loud once per tick.
    log.warn(
      {},
      'mail-restic-shim: both `mail` and `system_mail` classes are bound — deferring to legacy mail-target-sync (delete the `system_mail` row to switch to shim mode)',
    );
    return {
      state: 'STATE_LEGACY_TAKING_OVER',
      errorMessage: '',
      secretApplied: false,
    };
  }

  // 2. New `mail` class is bound (and only this one). Load the
  // BACKUP_TARGET_KEY + emit shim env.
  let rawKey: Buffer;
  try {
    const ki = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE, { log });
    rawKey = ki.rawKey;
  } catch (err) {
    if (err instanceof ShimKeyMissingError) {
      log.warn(
        { err: err.message },
        'mail-restic-shim: BACKUP_TARGET_KEY missing — will retry',
      );
      return {
        state: 'STATE_MISSING_KEY',
        errorMessage: err.message,
        secretApplied: false,
      };
    }
    throw err;
  }

  const env = buildMailResticShimEnv(rawKey);
  try {
    await applyMailResticSecret(clients.core, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'mail-restic-shim: Secret apply failed');
    return {
      state: 'STATE_ERROR',
      errorMessage: msg,
      secretApplied: false,
    };
  }
  return { state: 'STATE_OK', errorMessage: '', secretApplied: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isClassBound(
  db: Database,
  className: 'mail' | 'system_mail',
): Promise<boolean> {
  const rows = await db
    .select({ enabled: backupConfigurations.enabled })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(inArray(backupTargetAssignments.snapshotClass, [className]))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return rows.length > 0 && rows[0].enabled === 1;
}

async function applyMailResticSecret(
  core: k8s.CoreV1Api,
  env: MailResticShimEnv,
): Promise<void> {
  const dataB64: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    dataB64[k] = Buffer.from(v, 'utf8').toString('base64');
  }
  // Whole-object replace so any operator-added keys are pruned. The
  // Secret is reconciler-owned when this code path executes.
  const body = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: MAIL_RESTIC_SECRET_NAME,
      namespace: MAIL_NAMESPACE,
      labels: {
        app: 'stalwart',
        'app.kubernetes.io/part-of': 'hosting-platform',
        'app.kubernetes.io/component': 'mail-restic',
        'app.kubernetes.io/managed-by': MAIL_RESTIC_FIELD_MANAGER,
      },
    },
    type: 'Opaque',
    data: dataB64,
  };
  // backup-coverage: excluded:cluster-infrastructure
  // mail-restic Secret lives in the `mail` namespace and holds the
  // restic repo password the shim derives at boot. Not tenant data —
  // recreated deterministically from BACKUP_TARGET_KEY on cluster
  // restore, so no tenant-bundle component captures it.
  try {
    await core.replaceNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      name: MAIL_RESTIC_SECRET_NAME,
      body: body as unknown as object,
    } as unknown as Parameters<typeof core.replaceNamespacedSecret>[0]);
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
    // backup-coverage: excluded:cluster-infrastructure
    await core.createNamespacedSecret({
      namespace: MAIL_NAMESPACE,
      body: body as unknown as object,
    } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
  }
}
