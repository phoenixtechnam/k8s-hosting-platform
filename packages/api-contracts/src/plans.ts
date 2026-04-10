import { z } from 'zod';

export const createPlanSchema = z.object({
  code: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  cpu_limit: z.string().min(1).max(20),
  memory_limit: z.string().min(1).max(20),
  storage_limit: z.string().min(1).max(20),
  monthly_price_usd: z.string().min(1).max(20),
  features: z.record(z.unknown()).optional().default({}),
}).strict();

export const updatePlanSchema = createPlanSchema.partial().strict();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
