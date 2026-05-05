import { z } from 'zod';

/**
 * GET /admin/mail/pvc/storage
 *
 * Returns the live state of the mail-pg-1 PVC (the CNPG-managed PG
 * cluster's persistent volume in the `mail` namespace). Operator UI
 * displays this in the Email Management → Mail Server Storage card so
 * super_admins can see used/free + grow when needed.
 *
 * `usedBytes` / `freeBytes` may be null if the kubectl-exec df probe
 * fails (e.g. CNPG pod not Ready). The card MUST render the requested
 * + capacity sizes regardless so a degraded cluster can still be
 * resized out of trouble.
 *
 * `expansionAllowed` reflects the PVC's StorageClass
 * `allowVolumeExpansion` field — a Longhorn-default true on the
 * platform's `longhorn-system-local` SC. The PATCH endpoint refuses
 * to grow when this is false (would silently no-op otherwise).
 *
 * `lastResizedAt` is read from the PVC annotation
 * `platform.phoenix-host.net/last-resized-at` set by every successful
 * grow. Null on a never-resized PVC.
 */
export const mailPvcStorageResponseSchema = z.object({
  pvcName: z.string().min(1),
  namespace: z.literal('mail'),
  requestedBytes: z.number().int().nonnegative(),
  capacityBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative().nullable(),
  freeBytes: z.number().int().nonnegative().nullable(),
  storageClass: z.string().min(1),
  expansionAllowed: z.boolean(),
  lastResizedAt: z.string().datetime().nullable(),
});
export type MailPvcStorageResponse = z.infer<typeof mailPvcStorageResponseSchema>;

/**
 * PATCH /admin/mail/pvc/storage
 *
 * Online-grows the mail-pg-1 PVC. Body is the new requested size in
 * GiB (integer). The backend rejects:
 *   - newGiB < currentGiB → MAIL_PVC_SHRINK_NOT_SUPPORTED (K8s does
 *     not support online shrink; would corrupt PG data).
 *   - newGiB == currentGiB → MAIL_PVC_SAME_SIZE (no-op).
 *   - StorageClass.allowVolumeExpansion === false →
 *     STORAGE_CLASS_NO_EXPANSION (operator must change SC first).
 *
 * No `confirmShrink` field — v1 always rejects. A future shrink path
 * would require snapshot+restore-into-fresh-cluster orchestration
 * which is out of scope.
 *
 * Min/max bounds: 1 GiB lower (anything smaller breaks PG initdb);
 * 2048 GiB upper (Longhorn single-volume practical ceiling). Operators
 * needing larger should split PG via CNPG instances or shard.
 */
export const mailPvcResizeRequestSchema = z.object({
  newGiB: z.number().int().min(1).max(2048),
});
export type MailPvcResizeRequest = z.infer<typeof mailPvcResizeRequestSchema>;

/**
 * PATCH /admin/mail/pvc/storage response — returns the updated state
 * immediately after the patch (status.capacity may still be the old
 * value; CSI driver updates it after volume expansion completes).
 * Operator UI polls GET /admin/mail/pvc/storage to observe convergence.
 */
export const mailPvcResizeResponseSchema = z.object({
  pvcName: z.string().min(1),
  requestedBytes: z.number().int().positive(),
  lastResizedAt: z.string().datetime(),
});
export type MailPvcResizeResponse = z.infer<typeof mailPvcResizeResponseSchema>;
