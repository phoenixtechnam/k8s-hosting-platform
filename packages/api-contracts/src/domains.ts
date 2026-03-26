import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

const domainNameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createDomainSchema = z.object({
  domain_name: z.string().min(1).max(255).regex(domainNameRegex, 'Invalid domain name format'),
  dns_mode: z.enum(['primary', 'cname', 'secondary']).default('cname'),
  workload_id: uuidField.optional(),
});

export const updateDomainSchema = z.object({
  dns_mode: z.enum(['primary', 'cname', 'secondary']).optional(),
  ssl_auto_renew: z.boolean().optional(),
  status: z.enum(['active', 'pending', 'suspended', 'deleted']).optional(),
  workload_id: uuidField.nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const domainResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  domainName: z.string(),
  status: z.string(),
  dnsMode: z.string(),
  sslAutoRenew: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const domainListResponseSchema = paginatedResponseSchema(domainResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDomainInput = z.infer<typeof createDomainSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type DomainResponse = z.infer<typeof domainResponseSchema>;
export type DomainListResponse = z.infer<typeof domainListResponseSchema>;
