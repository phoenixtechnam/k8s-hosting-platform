import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// Simple cron expression validator: 5 space-separated fields
const cronRegex = /^([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createCronJobSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['webcron', 'deployment']),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression (expected 5 fields: min hour dom mon dow)'),
  // Webcron fields
  url: z.string().url().max(2000).optional(),
  http_method: z.enum(['GET', 'POST', 'PUT']).default('GET'),
  // Deployment cron fields
  command: z.string().min(1).max(2000).optional(),
  deployment_id: z.string().uuid().optional(),
  // Common
  enabled: z.boolean().default(true),
}).refine(
  (data) => {
    if (data.type === 'webcron') return !!data.url;
    if (data.type === 'deployment') return !!data.command && !!data.deployment_id;
    return false;
  },
  { message: 'Webcron requires url; deployment cron requires command and deployment_id' }
);

export const updateCronJobSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression').optional(),
  url: z.string().url().max(2000).optional(),
  http_method: z.enum(['GET', 'POST', 'PUT']).optional(),
  command: z.string().min(1).max(2000).optional(),
  deployment_id: z.string().uuid().optional(),
  enabled: z.boolean().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const cronJobResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  name: z.string(),
  type: z.enum(['webcron', 'deployment']),
  schedule: z.string(),
  command: z.string().nullable(),
  url: z.string().nullable(),
  httpMethod: z.string().nullable(),
  deploymentId: z.string().nullable(),
  enabled: z.number(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'running']).nullable(),
  lastRunDurationMs: z.number().nullable(),
  lastRunResponseCode: z.number().nullable(),
  lastRunOutput: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const cronJobListResponseSchema = paginatedResponseSchema(cronJobResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
export type CronJobResponse = z.infer<typeof cronJobResponseSchema>;
export type CronJobListResponse = z.infer<typeof cronJobListResponseSchema>;
