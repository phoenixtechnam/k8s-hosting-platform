import { z } from 'zod';

/**
 * GET /admin/mail/pvc/storage
 *
 * Returns the live state of the `stalwart-rocksdb-data` PVC — the
 * RocksDB DataStore mount for the Stalwart mail server in the `mail`
 * namespace. Operator UI displays this in the Email Management →
 * Storage section so super_admins can see how much of the local NVMe
 * the data dir is using.
 *
 * `usedBytes` / `freeBytes` may be null if the kubectl-exec `du -sb`
 * probe fails (e.g. Stalwart pod not Ready). The card MUST render the
 * requested + capacity sizes regardless so a degraded mail server can
 * still be diagnosed.
 *
 * `expansionAllowed` and `lastResizedAt` are kept on the response for
 * contract stability after the 2026-05-14 streamline removed the
 * resize endpoint. Mail is local-path-only after the RocksDB migration
 * (see project_stalwart_storage_benchmark_2026_05_11.md — local-path
 * NVMe is 35× faster than network-attached storage and is the only
 * class fast enough for `stalwart -e` import/export at production
 * volumes). The local-path provisioner does NOT quota
 * `requests.storage` — it is informational only after creation — so
 * online-grow was never a meaningful operation post-migration. Both
 * fields are emitted as `false` / `null` and the UI hides any
 * resize-related affordances.
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
