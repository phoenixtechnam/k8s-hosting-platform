import { z } from 'zod';

export const createClientSchema = z.object({
  company_name: z.string().min(1).max(255),
  company_email: z.string().email(),
  contact_email: z.string().email().optional(),
  plan_id: z.string().uuid(),
  region_id: z.string().uuid(),
  subscription_expires_at: z.string().datetime().optional(),
});

export const updateClientSchema = z.object({
  company_name: z.string().min(1).max(255).optional(),
  company_email: z.string().email().optional(),
  contact_email: z.string().email().optional(),
  status: z.enum(['active', 'suspended', 'cancelled', 'pending']).optional(),
  plan_id: z.string().uuid().optional(),
  subscription_expires_at: z.string().datetime().optional(),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
