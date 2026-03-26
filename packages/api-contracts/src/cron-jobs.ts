import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// Simple cron expression validator: 5 space-separated fields
const cronRegex = /^([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createCronJobSchema = z.object({
  name: z.string().min(1).max(255),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression (expected 5 fields: min hour dom mon dow)'),
  command: z.string().min(1).max(2000),
  enabled: z.boolean().default(true),
});

export const updateCronJobSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression').optional(),
  command: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const cronJobResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  name: z.string(),
  schedule: z.string(),
  command: z.string(),
  enabled: z.number(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'running']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const cronJobListResponseSchema = paginatedResponseSchema(cronJobResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
export type CronJobResponse = z.infer<typeof cronJobResponseSchema>;
export type CronJobListResponse = z.infer<typeof cronJobListResponseSchema>;
