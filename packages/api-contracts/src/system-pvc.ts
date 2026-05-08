import { z } from 'zod';

/**
 * GET /admin/system/pvc/storage
 *
 * Returns the live state of the system-db-1 PVC (the CNPG-managed
 * platform PG cluster's persistent volume in the `platform`
 * namespace). Mirrors the shape of the mail-pvc surface — see
 * mail-storage.ts for the field-level rationale. The two endpoints
 * are intentionally symmetric so the UI components can be reused.
 *
 * `usedBytes` / `freeBytes` may be null if the kubectl-exec df probe
 * fails. The card MUST render the requested + capacity sizes
 * regardless so a degraded cluster can still be resized out of
 * trouble.
 *
 * `expansionAllowed` reflects the PVC's StorageClass
 * `allowVolumeExpansion` field. The PATCH endpoint refuses to grow
 * when this is false.
 *
 * `lastResizedAt` is read from the PVC annotation
 * `platform.phoenix-host.net/last-resized-at` set by every successful
 * grow. Null on a never-resized PVC.
 */
export const systemPvcStorageResponseSchema = z.object({
  pvcName: z.string().min(1),
  namespace: z.literal('platform'),
  requestedBytes: z.number().int().nonnegative(),
  capacityBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative().nullable(),
  freeBytes: z.number().int().nonnegative().nullable(),
  storageClass: z.string().min(1),
  expansionAllowed: z.boolean(),
  lastResizedAt: z.string().datetime().nullable(),
});
export type SystemPvcStorageResponse = z.infer<typeof systemPvcStorageResponseSchema>;

/**
 * PATCH /admin/system/pvc/storage
 *
 * Online-grows the system-db-1 PVC. Body is the new requested size
 * in GiB (integer). Reject codes mirror the mail-pvc surface:
 *   - newGiB < currentGiB → SYSTEM_PVC_SHRINK_NOT_SUPPORTED
 *   - newGiB == currentGiB → SYSTEM_PVC_SAME_SIZE
 *   - StorageClass.allowVolumeExpansion === false →
 *     STORAGE_CLASS_NO_EXPANSION
 *
 * Min/max bounds: 1 GiB lower (anything smaller breaks PG initdb);
 * 2048 GiB upper (Longhorn single-volume practical ceiling).
 */
export const systemPvcResizeRequestSchema = z.object({
  newGiB: z.number().int().min(1).max(2048),
});
export type SystemPvcResizeRequest = z.infer<typeof systemPvcResizeRequestSchema>;

/**
 * PATCH /admin/system/pvc/storage response — returns the updated
 * state immediately after the patch (status.capacity may still be
 * the old value; CSI driver updates it after volume expansion
 * completes). UI polls GET /admin/system/pvc/storage to observe
 * convergence.
 */
export const systemPvcResizeResponseSchema = z.object({
  pvcName: z.string().min(1),
  requestedBytes: z.number().int().positive(),
  lastResizedAt: z.string().datetime(),
});
export type SystemPvcResizeResponse = z.infer<typeof systemPvcResizeResponseSchema>;
