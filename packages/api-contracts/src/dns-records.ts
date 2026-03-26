import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createDnsRecordSchema = z.object({
  record_type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS']),
  record_name: z.string().max(253).optional(),
  record_value: z.string().max(1000),
  ttl: z.number().int().min(60).max(86400).default(3600),
  priority: z.number().int().min(0).max(65535).optional(),
  weight: z.number().int().min(0).max(65535).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

export const updateDnsRecordSchema = z.object({
  record_value: z.string().max(1000).optional(),
  ttl: z.number().int().min(60).max(86400).optional(),
  priority: z.number().int().min(0).max(65535).optional(),
  weight: z.number().int().min(0).max(65535).optional(),
  port: z.number().int().min(0).max(65535).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const dnsRecordResponseSchema = z.object({
  id: uuidField,
  domainId: uuidField,
  recordType: z.string(),
  recordName: z.string().nullable(),
  recordValue: z.string().nullable(),
  ttl: z.number(),
  priority: z.number().nullable(),
  weight: z.number().nullable(),
  port: z.number().nullable(),
  updatedAt: z.string(),
});

export const dnsRecordListResponseSchema = paginatedResponseSchema(dnsRecordResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateDnsRecordInput = z.infer<typeof createDnsRecordSchema>;
export type UpdateDnsRecordInput = z.infer<typeof updateDnsRecordSchema>;
export type DnsRecordResponse = z.infer<typeof dnsRecordResponseSchema>;
export type DnsRecordListResponse = z.infer<typeof dnsRecordListResponseSchema>;
