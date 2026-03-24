import { z } from 'zod';

export const updateSubscriptionSchema = z.object({
  plan_id: z.string().uuid().optional(),
  subscription_expires_at: z.string().datetime().optional(),
  status: z.enum(['active', 'suspended', 'cancelled', 'pending']).optional(),
  notes: z.string().max(1000).optional(),
});

export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
