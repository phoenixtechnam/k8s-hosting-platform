import { z } from 'zod';

export const exportResponseSchema = z.object({
  version: z.literal('1.0'),
  exportedAt: z.string(),
  clients: z.array(z.record(z.string(), z.unknown())),
  domains: z.array(z.record(z.string(), z.unknown())),
  hostingPlans: z.array(z.record(z.string(), z.unknown())),
  dnsServers: z.array(z.record(z.string(), z.unknown())),
});

export type ExportResponse = z.infer<typeof exportResponseSchema>;

export const importRequestSchema = z.object({
  version: z.literal('1.0'),
  clients: z.array(z.record(z.string(), z.unknown())).optional(),
  domains: z.array(z.record(z.string(), z.unknown())).optional(),
  hostingPlans: z.array(z.record(z.string(), z.unknown())).optional(),
});

export type ImportRequest = z.infer<typeof importRequestSchema>;

export const importResultSchema = z.object({
  dryRun: z.boolean(),
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.array(z.object({
    resource: z.string(),
    id: z.string(),
    error: z.string(),
  })),
});

export type ImportResult = z.infer<typeof importResultSchema>;
