import { z } from 'zod';

const domainNameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

export const createDomainSchema = z.object({
  domain_name: z.string().min(1).max(255).regex(domainNameRegex, 'Invalid domain name format'),
  dns_mode: z.enum(['primary', 'cname', 'secondary']).default('cname'),
  workload_id: z.string().uuid().optional(),
});

export const updateDomainSchema = z.object({
  dns_mode: z.enum(['primary', 'cname', 'secondary']).optional(),
  ssl_auto_renew: z.boolean().optional(),
  status: z.enum(['active', 'pending', 'suspended', 'deleted']).optional(),
  workload_id: z.string().uuid().nullable().optional(),
});

export type CreateDomainInput = z.infer<typeof createDomainSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
