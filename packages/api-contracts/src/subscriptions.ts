import { z } from 'zod';
import { statusEnum } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const updateSubscriptionSchema = z.object({
  plan_id: z.string().uuid().optional(),
  subscription_expires_at: z.string().datetime().optional(),
  status: statusEnum.optional(),
  notes: z.string().max(1000).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const hostingPlanSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cpuLimit: z.string(),
  memoryLimit: z.string(),
  storageLimit: z.string(),
  monthlyPriceUsd: z.string(),
  features: z.unknown().nullable(),
  status: z.string(),
  createdAt: z.string(),
});

export const subscriptionResponseSchema = z.object({
  client_id: z.string(),
  plan: hostingPlanSchema.nullable(),
  status: z.string(),
  subscription_expires_at: z.string().nullable(),
  created_at: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;
export type HostingPlan = z.infer<typeof hostingPlanSchema>;
export type SubscriptionResponse = z.infer<typeof subscriptionResponseSchema>;
