import { z } from 'zod';

// ─── Orphaned Volumes ────────────────────────────────────────────────────────

/**
 * Reasons a Persistent Volume / Longhorn volume is classified as orphaned.
 *
 *  - namespace_deleted     The PV's claimRef.namespace is gone.
 *  - client_record_deleted Tenant namespace exists but no client row in DB.
 *  - pv_released_stale     Phase=Released for > stalePvThresholdDays.
 *  - longhorn_volume_unbound  Longhorn volume CR exists but no PV references it.
 *  - namespace_orphaned    A `client-*` namespace exists with no matching
 *                          client row and no PV already covered by a more
 *                          specific reason — typically a deprovision that
 *                          left the namespace stranded after volumes were
 *                          already cleaned up.
 */
export const orphanReasonSchema = z.enum([
  'namespace_deleted',
  'client_record_deleted',
  'pv_released_stale',
  'longhorn_volume_unbound',
  'namespace_orphaned',
]);
export type OrphanReason = z.infer<typeof orphanReasonSchema>;

export const orphanedVolumeEntrySchema = z.object({
  /** PV name when one exists; null for `longhorn_volume_unbound`. */
  pvName: z.string().nullable(),
  /** Longhorn volume name when one exists; null when the PV uses a
      different provisioner. The UI must hide the Snapshot button for
      rows where this is null. */
  longhornVolumeName: z.string().nullable(),
  namespace: z.string().nullable(),
  pvcName: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  /** Nodes currently holding a healthy replica. */
  nodes: z.array(z.string()).default([]),
  reason: orphanReasonSchema,
  /** Days since PV.status.lastTransitionTime; null when unknown. */
  ageDays: z.number().int().nonnegative().nullable(),
  /** Pre-resolved label: client company name OR "Platform System (<ns>)". */
  ownerLabel: z.string(),
});
export type OrphanedVolumeEntry = z.infer<typeof orphanedVolumeEntrySchema>;

export const orphanedVolumesReportSchema = z.object({
  orphans: z.array(orphanedVolumeEntrySchema),
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  stalePvThresholdDays: z.number().int().min(1),
});
export type OrphanedVolumesReport = z.infer<typeof orphanedVolumesReportSchema>;

export const orphanSnapshotResponseSchema = z.object({
  snapshotName: z.string(),
});
export type OrphanSnapshotResponse = z.infer<typeof orphanSnapshotResponseSchema>;

export const orphanDeleteResponseSchema = z.object({
  deletedPv: z.boolean(),
  deletedLonghornVolume: z.boolean(),
  deletedNamespace: z.boolean().default(false),
});
export type OrphanDeleteResponse = z.infer<typeof orphanDeleteResponseSchema>;

/**
 * Per-orphan failure detail for the purge-all endpoint. Identified by the
 * action key the operator would have used in the row's Delete button.
 */
export const orphanPurgeFailureSchema = z.object({
  /** longhornVolumeName ?? pvName ?? namespace — same precedence the modal uses. */
  key: z.string(),
  reason: orphanReasonSchema,
  /** OperatorError envelope or plain string fallback. */
  error: z.string(),
});
export type OrphanPurgeFailure = z.infer<typeof orphanPurgeFailureSchema>;

export const orphanPurgeAllResponseSchema = z.object({
  attempted: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  bytesReclaimed: z.number().int().nonnegative(),
  failures: z.array(orphanPurgeFailureSchema),
});
export type OrphanPurgeAllResponse = z.infer<typeof orphanPurgeAllResponseSchema>;
