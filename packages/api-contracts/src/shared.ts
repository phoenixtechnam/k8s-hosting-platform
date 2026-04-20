import { z } from 'zod';

// ─── Pagination ──────────────────────────────────────────────────────────────

/** Backend maximum for any list endpoint */
export const MAX_PAGE_LIMIT = 100;

export const paginationParamsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(20),
  cursor: z.string().optional(),
  sort: z.string().optional(),
  search: z.string().optional(),
});

export type PaginationParams = z.infer<typeof paginationParamsSchema>;

export const paginationMetaSchema = z.object({
  total_count: z.number(),
  cursor: z.string().nullable(),
  has_more: z.boolean(),
  page_size: z.number(),
});

export type PaginationMeta = z.infer<typeof paginationMetaSchema>;

// ─── API Response Envelopes ──────────────────────────────────────────────────

export function paginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    pagination: paginationMetaSchema,
  });
}

export function dataResponseSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    data: dataSchema,
  });
}

// ─── Common Fields ───────────────────────────────────────────────────────────

// Client lifecycle status. `archived` means the client was off-boarded:
// PVC destroyed, snapshot retained for the configured grace period, but
// the account still exists so it can be restored. See storage-lifecycle/.
//
// The terminal operation is "delete" — a verb, not a persistent state —
// which hard-removes the client row from the database. There is no
// `deleted` value in the enum; a deleted client simply doesn't exist.
export const statusEnum = z.enum(['active', 'suspended', 'pending', 'archived']);
export type Status = z.infer<typeof statusEnum>;

// Storage lifecycle state machine — orthogonal to client.status.
// Lives on `clients.storage_lifecycle_state`. Callers should treat any
// value other than `idle` as "an orchestrator is currently operating
// on this client's PVC; UI should disable destructive actions."
export const storageLifecycleStateEnum = z.enum([
  'idle',
  'snapshotting',
  'quiescing',
  'resizing',
  'replacing',
  'restoring',
  'unquiescing',
  'archiving',
  'failed',
]);
export type StorageLifecycleState = z.infer<typeof storageLifecycleStateEnum>;

export const uuidField = z.string().uuid();

// ─── Shared Patterns ────────────────────────────────────────────────────────

/** GitHub repository URL pattern — shared by workload-repos and application-repos */
export const githubUrlPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
