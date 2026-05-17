// Per-snapshot-class target resolver (Phase 3 of snapshot-storage overhaul).
//
// One entry point for every subsystem that needs to know "where does
// snapshot class X go right now?". Calls the strict-primary lookup in
// snapshot-classes/service.ts and surfaces a typed NO_SNAPSHOT_TARGET
// error that callers can pattern-match on.
//
// Caching: per-class resolution is hot during long-running ops
// (snapshot.ts can resolve once and reuse for the Job spec). The
// resolver itself is uncached — Phase 4 will add a 60s in-memory
// cache mirroring loadStorageLifecycleSettings, once we have a measured
// QPS that justifies it.
//
// Fallback behaviour: NONE. The locked decision is fail-loud — an
// unassigned class refuses to snapshot rather than silently writing
// to a default. Operators get NO_SNAPSHOT_TARGET + a deep link to
// the assignments page in the UI.

import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import { resolvePrimaryTarget } from '../snapshot-classes/service.js';
import type { SnapshotClass } from '@k8s-hosting/api-contracts';

export interface ResolvedSnapshotTarget {
  readonly snapshotClass: SnapshotClass;
  readonly targetId: string;
  readonly targetName: string;
  readonly targetStorageType: string;
}

/**
 * Resolve the primary backup target for a snapshot class. Throws
 * `NO_SNAPSHOT_TARGET` (HTTP 409) when no assignment exists — caller
 * surfaces this to the admin UI with a deep-link to /settings/snapshot-classes.
 *
 * Returns enough metadata for the caller to:
 *   - record `storage_snapshots.target_id` for forensics
 *   - call into the existing `resolveBackupStore` (tenant-bundles) or
 *     the Phase 4 streaming store factory to materialise an upload client
 */
export async function resolveTargetFor(
  db: Database,
  snapshotClass: SnapshotClass,
): Promise<ResolvedSnapshotTarget> {
  const primary = await resolvePrimaryTarget(db, snapshotClass);
  if (!primary) {
    throw new ApiError(
      'NO_SNAPSHOT_TARGET',
      `No backup target assigned to snapshot class '${snapshotClass}'. ` +
      `Configure one at /settings/snapshot-classes.`,
      409,
    );
  }
  return {
    snapshotClass,
    targetId: primary.targetId,
    targetName: primary.targetName,
    targetStorageType: primary.targetStorageType,
  };
}

/**
 * Soft variant — returns null instead of throwing. Used by code paths
 * that want to ask "is this class assigned?" without crashing the
 * whole operation (e.g. admin UI status indicators).
 */
export async function maybeResolveTargetFor(
  db: Database,
  snapshotClass: SnapshotClass,
): Promise<ResolvedSnapshotTarget | null> {
  const primary = await resolvePrimaryTarget(db, snapshotClass);
  if (!primary) return null;
  return {
    snapshotClass,
    targetId: primary.targetId,
    targetName: primary.targetName,
    targetStorageType: primary.targetStorageType,
  };
}
