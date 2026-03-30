import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Response Schemas ────────────────────────────────────────────────────────

export const applicationCatalogResponseSchema = z.object({
  id: uuidField,
  code: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  documentation: z.string().nullable(),
  category: z.string().nullable(),
  minPlan: z.string().nullable(),
  tenancy: z.array(z.string()).nullable(),
  components: z.array(z.unknown()).nullable(),
  networking: z.record(z.string(), z.unknown()).nullable(),
  volumes: z.array(z.unknown()).nullable(),
  resources: z.record(z.string(), z.unknown()).nullable(),
  healthCheck: z.record(z.string(), z.unknown()).nullable(),
  parameters: z.array(z.unknown()).nullable(),
  tags: z.array(z.string()).nullable(),
  status: z.string(),
  featured: z.number(),
  popular: z.number(),
  sourceRepoId: z.string().nullable(),
  manifestUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const applicationInstanceResponseSchema = z.object({
  id: uuidField,
  clientId: z.string(),
  applicationCatalogId: z.string(),
  name: z.string(),
  domainName: z.string().nullable(),
  configuration: z.record(z.string(), z.unknown()).nullable(),
  helmReleaseName: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createApplicationInstanceSchema = z.object({
  applicationCatalogId: uuidField,
  name: z.string().min(1).max(255),
  domainName: z.string().max(255).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApplicationCatalogResponse = z.infer<typeof applicationCatalogResponseSchema>;
export type ApplicationInstanceResponse = z.infer<typeof applicationInstanceResponseSchema>;
export type CreateApplicationInstanceInput = z.infer<typeof createApplicationInstanceSchema>;
