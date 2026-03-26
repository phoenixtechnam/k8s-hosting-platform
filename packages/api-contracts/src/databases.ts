import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

const nameRegex = /^[a-zA-Z0-9_]+$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createDatabaseSchema = z.object({
  name: z.string().min(1).max(63).regex(nameRegex, 'Name must contain only alphanumeric characters and underscores'),
  db_type: z.enum(['mysql', 'postgresql']).default('mysql'),
});

export const updateDatabaseSchema = z.object({
  name: z.string().min(1).max(63).regex(nameRegex).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const databaseResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  name: z.string(),
  databaseType: z.string(),
  username: z.string(),
  status: z.string(),
  port: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const databaseListResponseSchema = paginatedResponseSchema(databaseResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type UpdateDatabaseInput = z.infer<typeof updateDatabaseSchema>;
export type DatabaseResponse = z.infer<typeof databaseResponseSchema>;
export type DatabaseListResponse = z.infer<typeof databaseListResponseSchema>;
