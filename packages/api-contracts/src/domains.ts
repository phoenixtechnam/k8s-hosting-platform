import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

const domainNameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createDomainSchema = z.object({
  domain_name: z.string().min(1).max(255).regex(domainNameRegex, 'Invalid domain name format'),
  dns_mode: z.enum(['primary', 'cname', 'secondary']).default('cname'),
  deployment_id: uuidField.optional(),
  dns_group_id: uuidField.optional(),
});

export const updateDomainSchema = z.object({
  dns_mode: z.enum(['primary', 'cname', 'secondary']).optional(),
  ssl_auto_renew: z.boolean().optional(),
  status: z.enum(['active', 'pending', 'suspended', 'deleted']).optional(),
  deployment_id: uuidField.nullable().optional(),
  dns_group_id: uuidField.nullable().optional(),
});

// ─── DNS Provider Group Schemas ─────────────────────────────────────────────

export const createDnsProviderGroupSchema = z.object({
  name: z.string().min(1).max(255),
  is_default: z.boolean().optional(),
  ns_hostnames: z.array(z.string()).optional(),
});

export const updateDnsProviderGroupSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  is_default: z.boolean().optional(),
  ns_hostnames: z.array(z.string()).optional(),
});

export const migrateDnsSchema = z.object({
  target_group_id: uuidField,
});

export const dnsProviderGroupResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  isDefault: z.boolean(),
  nsHostnames: z.array(z.string()).nullable().optional(),
  serverCount: z.number().optional(),
  domainCount: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const domainResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  domainName: z.string(),
  status: z.string(),
  dnsMode: z.string(),
  deploymentId: z.string().nullable().optional(),
  dnsGroupId: z.string().nullable().optional(),
  sslAutoRenew: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const domainListResponseSchema = paginatedResponseSchema(domainResponseSchema);

// ─── Delete preview (Phase 3 round-3) ────────────────────────────────────────

export const domainDeletePreviewSchema = z.object({
  domainName: z.string(),
  dnsRecords: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      name: z.string().nullable(),
    }),
  ),
  emailDomain: z
    .object({
      id: z.string(),
      webmailEnabled: z.boolean(),
      mailboxes: z.array(
        z.object({
          id: z.string(),
          fullAddress: z.string(),
        }),
      ),
      aliases: z.array(
        z.object({
          id: z.string(),
          sourceAddress: z.string(),
        }),
      ),
    })
    .nullable(),
  ingressRoutes: z.array(
    z.object({
      id: z.string(),
      hostname: z.string(),
    }),
  ),
  webmailIngressHostname: z.string().nullable(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDomainInput = z.infer<typeof createDomainSchema>;
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>;
export type DomainResponse = z.infer<typeof domainResponseSchema>;
export type DomainListResponse = z.infer<typeof domainListResponseSchema>;
export type DomainDeletePreview = z.infer<typeof domainDeletePreviewSchema>;
export type CreateDnsProviderGroupInput = z.infer<typeof createDnsProviderGroupSchema>;
export type UpdateDnsProviderGroupInput = z.infer<typeof updateDnsProviderGroupSchema>;
export type MigrateDnsInput = z.infer<typeof migrateDnsSchema>;
export type DnsProviderGroupResponse = z.infer<typeof dnsProviderGroupResponseSchema>;
