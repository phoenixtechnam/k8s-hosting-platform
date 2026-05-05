import { z } from 'zod';

/**
 * Stalwart 0.16 BlobStore — singleton (id `singleton`) that holds
 * tenant message bodies.
 *
 * Stalwart 0.16's actual schema variants (per `cli describe BlobStore`):
 * Default / Sharded / S3 / Azure / FileSystem / FoundationDb / PostgreSql / MySql.
 *
 * The platform UI exposes the three variants operators care about:
 *   - Default — blobs in the configured DataStore (mail-pg PG by default;
 *     blows up on disk at scale but works without external infra).
 *   - S3 — blobs in an external S3 bucket (required for HA stateless
 *     since each replica's emptyDir would split blobs otherwise).
 *   - FileSystem — blobs on the Pod's local disk (INCOMPATIBLE with
 *     multi-replica Stalwart — each replica sees only its own blobs).
 *
 * Switching is online (Stalwart applies the change in-flight via the
 * cli) but DOES NOT migrate existing blobs. Old blobs stay in the
 * previous store; new mail lands in the new store. Operators needing
 * to move existing blobs run an external migrator —
 * docs/03-mail/STALWART_BLOB_STORE_MIGRATION.md covers it.
 */
export const blobStoreType = z.enum(['Default', 'S3', 'FileSystem']);
export type BlobStoreType = z.infer<typeof blobStoreType>;

/**
 * GET /admin/mail/blob-store response.
 *
 * S3 access keys are NEVER serialized in the response — only the
 * non-secret bucket/region/endpoint are exposed so the UI can show
 * "current = S3 in <bucket>/<region>" without leaking. Operators
 * needing to read keys do `kubectl get secret stalwart-blob-credentials`.
 */
export const blobStoreResponseSchema = z.object({
  id: z.string().min(1),
  type: blobStoreType,
  s3: z
    .object({
      bucket: z.string().min(1),
      region: z.string().min(1).optional(),
      endpoint: z.string().min(1).optional(),
    })
    .optional(),
  fileSystem: z
    .object({
      path: z.string().min(1),
      depth: z.number().int().min(0).optional(),
    })
    .optional(),
  lastUpdatedAt: z.string().datetime().nullable(),
});
export type BlobStoreResponse = z.infer<typeof blobStoreResponseSchema>;

/**
 * PATCH /admin/mail/blob-store request — discriminated on `type`.
 *
 * For `S3`, the operator provides bucket + region + endpoint + access
 * keys. The backend writes the access keys to a Secret
 * `stalwart-blob-credentials` (mail ns) and references them via
 * `envFrom` on the cli-update Job — they NEVER appear in argv.
 *
 * For `Disk`, no extra config (uses the Pod's emptyDir).
 *
 * For `PG`, no extra config (uses mail-pg).
 */
export const blobStoreUpdateRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Default') }),
  z.object({
    type: z.literal('FileSystem'),
    fileSystem: z
      .object({
        path: z.string().min(1).default('/var/lib/stalwart/blobs'),
        depth: z.number().int().min(0).max(8).default(2),
      })
      .default({ path: '/var/lib/stalwart/blobs', depth: 2 }),
  }),
  z.object({
    type: z.literal('S3'),
    s3: z.object({
      bucket: z.string().min(1).max(63),
      region: z.string().min(1).max(64),
      endpoint: z.string().url().optional(),
      accessKey: z.string().min(1).max(256),
      secretKey: z.string().min(1).max(512),
    }),
  }),
]);
export type BlobStoreUpdateRequest = z.infer<typeof blobStoreUpdateRequestSchema>;

/**
 * PATCH /admin/mail/blob-store response — returns the spawned Job's
 * name + initial status. Operator polls
 * GET /admin/mail/blob-store/jobs/:name for completion.
 */
export const blobStoreUpdateResponseSchema = z.object({
  id: z.string().min(1),
  type: blobStoreType,
  jobName: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  startedAt: z.string().datetime(),
});
export type BlobStoreUpdateResponse = z.infer<typeof blobStoreUpdateResponseSchema>;

/**
 * GET /admin/mail/blob-store/jobs/:name response — Job status from K8s
 * with the Pod's last log lines on success/failure so the operator can
 * see Stalwart's BEFORE/AFTER cli output.
 */
export const blobStoreJobStatusResponseSchema = z.object({
  jobName: z.string().min(1),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown']),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /** Tail of the Pod log (truncated to last 50 lines). null until logs accessible. */
  podLogTail: z.string().nullable(),
  /** Failure reason from .status.conditions, if status === 'failed'. */
  failureReason: z.string().nullable(),
});
export type BlobStoreJobStatusResponse = z.infer<typeof blobStoreJobStatusResponseSchema>;
