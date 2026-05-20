/**
 * rclone-push via shim (R-X9).
 *
 * When the new 3-class shim binding is set for the equivalent
 * class, snapshot-storage's S3StreamingStore points at the shim's
 * encrypted bucket instead of decrypting + connecting directly to
 * the operator-configured upstream.
 *
 * Class mapping (legacy 4-class → new 3-class):
 *
 *     tenant_snapshot  → tenant   (rclone-crypt bucket: s3://tenant)
 *     tenant_bundle    → tenant   (same)
 *     system_backup    → system   (rclone-crypt bucket: s3://system)
 *     system_mail      → mail     (managed by R-X8 mail-restic;
 *                                   storage-lifecycle should not
 *                                   handle mail snapshots in
 *                                   shim mode)
 *
 * The shim's per-class `crypt` bucket wraps every PUT with rclone's
 * built-in AES-256 + HMAC stream encryption (XChaCha20-Poly1305 on
 * AEAD-capable backends). The on-the-wire payload to upstream is
 * already encrypted by the time it leaves the shim — no
 * double-encryption (storage-lifecycle's existing AES-256-GCM
 * password envelope still wraps the *content* before it hits the
 * shim, so the resulting object has TWO layers of crypto).
 */

import { eq, inArray } from 'drizzle-orm';

import {
  backupConfigurations,
  backupTargetAssignments,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { SnapshotClass } from '@k8s-hosting/api-contracts';
import type { BackupShimClass } from '@k8s-hosting/api-contracts';

import {
  deriveShimAccessKey,
  deriveShimSecretKey,
} from './crypto.js';
import { SHIM_NAMESPACE } from './service.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Shim S3 endpoint (HTTP — same as R-X6/R-X7/R-X8). */
export const SHIM_S3_ENDPOINT_URL = `http://backup-rclone-shim.${SHIM_NAMESPACE}.svc.cluster.local:9000`;

/** Synthetic AWS region the shim accepts. rclone-serve-s3 ignores
 *  the value but the S3 SDK in the streaming-store needs one. */
export const SHIM_REGION = 'auto';

// ---------------------------------------------------------------------------
// Class mapping
// ---------------------------------------------------------------------------

/**
 * Map a legacy snapshot class to its 3-class shim equivalent.
 * Returns `null` for classes that should NOT route through the shim
 * (e.g. `system_mail` — handled by the R-X8 mail-restic reconciler
 * directly on the CronJob's Pod spec, not via streaming-store).
 */
export function shimClassFor(snapshotClass: SnapshotClass): BackupShimClass | null {
  switch (snapshotClass) {
    case 'tenant_snapshot':
    case 'tenant_bundle':
      return 'tenant';
    case 'system_backup':
      return 'system';
    case 'system_mail':
      // Mail uses the R-X8 restic path with a dedicated Secret.
      // The snapshot-storage streaming-store layer is NOT
      // appropriate here (no restic semantics).
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface ShimStreamingStoreConfig {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly pathPrefix: string;
}

/**
 * Build the S3StreamingStore constructor args for the shim. Pure
 * over (rawKey, snapshotClass).
 *
 * `pathPrefix` mirrors the legacy storage-lifecycle convention:
 * `snapshots/<legacy-class>` so existing readers see the same path
 * structure post-flip.
 */
export function buildShimStreamingStoreConfig(
  rawKey: Buffer,
  snapshotClass: SnapshotClass,
): ShimStreamingStoreConfig | null {
  const shimClass = shimClassFor(snapshotClass);
  if (shimClass === null) return null;
  return {
    bucket: shimClass, // 's3://tenant' or 's3://system' (rclone-crypt-wrapped)
    region: SHIM_REGION,
    endpoint: SHIM_S3_ENDPOINT_URL,
    accessKeyId: deriveShimAccessKey(rawKey),
    secretAccessKey: deriveShimSecretKey(rawKey),
    pathPrefix: `snapshots/${snapshotClass}`,
  };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Returns true iff the relevant 3-class shim binding is set + the
 * bound target is enabled. The caller uses this to decide between
 * shim mode (this module's builder) and legacy mode (the existing
 * per-storage-type plumbing in storage-lifecycle/snapshot-store.ts).
 *
 * `system_mail` is treated as "never shim-mode" here — the mail
 * subsystem owns its restic flow via R-X8. See shimClassFor()
 * above.
 */
export async function isShimModeActive(
  db: Database,
  snapshotClass: SnapshotClass,
): Promise<boolean> {
  const shimClass = shimClassFor(snapshotClass);
  if (shimClass === null) return false;
  const rows = await db
    .select({ enabled: backupConfigurations.enabled })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(inArray(backupTargetAssignments.snapshotClass, [shimClass]))
    .orderBy(backupTargetAssignments.priority)
    .limit(1);
  return rows.length > 0 && rows[0].enabled === 1;
}
