import { z } from 'zod';
import { statusEnum, uuidField, paginatedResponseSchema } from './shared.js';

// ─── Input Schemas (what the frontend sends) ────────────────────────────────

export const createClientSchema = z.object({
  company_name: z.string().min(1).max(255),
  company_email: z.string().email(),
  contact_email: z.string().email().optional(),
  plan_id: uuidField,
  region_id: uuidField,
  subscription_expires_at: z.string().datetime().optional(),
});

export const updateClientSchema = z.object({
  company_name: z.string().min(1).max(255).optional(),
  company_email: z.string().email().optional(),
  contact_email: z.string().email().optional(),
  status: statusEnum.optional(),
  plan_id: uuidField.optional(),
  subscription_expires_at: z.string().datetime().nullable().optional(),
  cpu_limit_override: z.number().min(0.1).max(64).nullable().optional(),
  memory_limit_override: z.number().min(0.1).max(256).nullable().optional(),
  storage_limit_override: z.number().min(1).max(10000).nullable().optional(),
  max_sub_users_override: z.number().int().min(1).max(100).nullable().optional(),
  monthly_price_override: z.number().min(0).max(99999).nullable().optional(),
});

// ─── Response Schemas (what the backend returns) ─────────────────────────────

export const clientResponseSchema = z.object({
  id: uuidField,
  companyName: z.string(),
  companyEmail: z.string(),
  contactEmail: z.string().nullable(),
  kubernetesNamespace: z.string(),
  planId: uuidField,
  regionId: uuidField,
  status: statusEnum,
  cpuLimitOverride: z.string().nullable(),
  memoryLimitOverride: z.string().nullable(),
  storageLimitOverride: z.string().nullable(),
  maxSubUsersOverride: z.number().nullable(),
  monthlyPriceOverride: z.string().nullable(),
  createdBy: z.string().nullable(),
  subscriptionExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const clientListResponseSchema = paginatedResponseSchema(clientResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ClientResponse = z.infer<typeof clientResponseSchema>;
export type ClientListResponse = z.infer<typeof clientListResponseSchema>;
