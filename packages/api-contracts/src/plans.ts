import { z } from 'zod';

export const createPlanSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  cpu_limit: z.string().min(1).max(20),
  memory_limit: z.string().min(1).max(20),
  storage_limit: z.string().min(1).max(20),
  monthly_price_usd: z.string().min(1).max(20),
  max_sub_users: z.number().int().min(0).max(100).optional(),
  max_mailboxes: z.number().int().min(0).max(10000).optional(),
  weekly_ai_budget_cents: z.number().int().min(0).max(100000).optional(),
  features: z.record(z.string(), z.unknown()).optional().default({}),
});

export const updatePlanSchema = createPlanSchema.partial().strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
