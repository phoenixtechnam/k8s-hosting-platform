import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createBackupSchema = z.object({
  backup_type: z.enum(['manual', 'scheduled']).default('manual'),
  resource_type: z.string().max(50).default('full'),
  resource_id: z.string().uuid().optional(),
  notes: z.string().max(1000).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const backupResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  backupType: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  storagePath: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  completedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});

export const backupListResponseSchema = paginatedResponseSchema(backupResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateBackupInput = z.infer<typeof createBackupSchema>;
export type BackupResponse = z.infer<typeof backupResponseSchema>;
export type BackupListResponse = z.infer<typeof backupListResponseSchema>;
