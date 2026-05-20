/**
 * Status + list helpers for the backup-rclone-shim admin surface.
 *
 * Split out from routes.ts so the same helpers can be reused by the
 * future R-X10 dashboard tile + the integration test suite.
 */

import { eq, inArray } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import { backupConfigurations, backupTargetAssignments } from '../../db/schema.js';
import {
  type BackupShimClass,
  type ShimAssignmentRow,
  type ShimState,
  DRAIN_TIMEOUT_SECONDS_DEFAULT,
} from '@k8s-hosting/api-contracts';

import {
  SHIM_CLASSES,
  SHIM_NAMESPACE,
  SHIM_STATUS_CM_NAME,
} from './service.js';

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * One row per shim class. Classes without a binding appear as
 * `targetId: null`. Drives the admin UI's three-card layout.
 */
export async function listCurrentShimAssignments(
  db: Database,
): Promise<ShimAssignmentRow[]> {
  const rows = await db
    .select({
      className: backupTargetAssignments.snapshotClass,
      targetId: backupConfigurations.id,
      targetName: backupConfigurations.name,
      targetStorageType: backupConfigurations.storageType,
      drainTimeoutSeconds: backupConfigurations.drainTimeoutSeconds,
    })
    .from(backupTargetAssignments)
    .innerJoin(
      backupConfigurations,
      eq(backupConfigurations.id, backupTargetAssignments.targetId),
    )
    .where(
      inArray(
        backupTargetAssignments.snapshotClass,
        SHIM_CLASSES as readonly string[] as string[],
      ),
    );

  const byClass = new Map<BackupShimClass, ShimAssignmentRow>();
  for (const r of rows) {
    if (!SHIM_CLASSES.includes(r.className as BackupShimClass)) continue;
    const className = r.className as BackupShimClass;
    // If multiple rows exist for the same class (legacy multi-target
    // assignments), keep the first seen. The reconciler service layer
    // picks the lowest-priority and reports the rest as 'shadowed';
    // here we just want the headline binding.
    if (byClass.has(className)) continue;
    byClass.set(className, {
      className,
      targetId: r.targetId,
      targetName: r.targetName,
      targetStorageType: r.targetStorageType as 's3' | 'ssh' | 'cifs' | 'nfs',
      drainTimeoutSeconds: r.drainTimeoutSeconds,
    });
  }

  // Emit one row per class, defaulted to "unassigned" when absent.
  return SHIM_CLASSES.map((c) =>
    byClass.get(c) ?? {
      className: c,
      targetId: null,
      targetName: null,
      targetStorageType: null,
      drainTimeoutSeconds: DRAIN_TIMEOUT_SECONDS_DEFAULT,
    },
  );
}

// ---------------------------------------------------------------------------
// Status read
// ---------------------------------------------------------------------------

interface ConfigMapShape {
  data?: Record<string, string>;
}

export interface ShimStatusSnapshot {
  readonly state: ShimState;
  readonly reconciledAt: string;
  readonly keyFingerprint: string;
  readonly inputHash: string;
  readonly assignedClasses: ReadonlyArray<BackupShimClass>;
  readonly errorMessage: string;
}

/**
 * Read the shim's status ConfigMap. Returns sensible defaults when
 * the CM is missing (fresh cluster pre-first-reconcile). All values
 * are operator-readable, no secret material.
 */
export async function readShimStatus(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'warn'>,
): Promise<ShimStatusSnapshot> {
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: SHIM_STATUS_CM_NAME,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0])) as ConfigMapShape;
    const d = cm.data ?? {};
    const assignedRaw = (d['assignedClasses'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
    return {
      state: normaliseState(d['state']),
      reconciledAt: d['reconciledAt'] ?? '',
      keyFingerprint: d['keyFingerprint'] ?? '',
      inputHash: d['inputHash'] ?? '',
      assignedClasses: assignedRaw.filter((s): s is BackupShimClass =>
        (SHIM_CLASSES as ReadonlyArray<string>).includes(s),
      ),
      errorMessage: d['errorMessage'] ?? '',
    };
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      // No status CM yet — reconciler hasn't run; report as missing-key
      // until proven otherwise.
      return {
        state: 'STATE_MISSING_KEY',
        reconciledAt: '',
        keyFingerprint: '',
        inputHash: '',
        assignedClasses: [],
        errorMessage: 'Status ConfigMap not yet created (reconciler has not run)',
      };
    }
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'backup-rclone-shim: status CM read failed (returning error placeholder)',
    );
    return {
      state: 'STATE_ERROR',
      reconciledAt: '',
      keyFingerprint: '',
      inputHash: '',
      assignedClasses: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

function normaliseState(raw: string | undefined): ShimState {
  switch (raw) {
    case 'STATE_OK':
    case 'STATE_MISSING_KEY':
    case 'STATE_NO_ASSIGNMENTS':
    case 'STATE_ERROR':
      return raw;
    default:
      return 'STATE_ERROR';
  }
}
