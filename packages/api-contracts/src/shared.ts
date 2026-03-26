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

export const statusEnum = z.enum(['active', 'suspended', 'pending', 'cancelled']);
export type Status = z.infer<typeof statusEnum>;

export const uuidField = z.string().uuid();
