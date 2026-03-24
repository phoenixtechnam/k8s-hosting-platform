import { z } from 'zod';

// Simple cron expression validator: 5 space-separated fields
const cronRegex = /^([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)$/;

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

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;
export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
