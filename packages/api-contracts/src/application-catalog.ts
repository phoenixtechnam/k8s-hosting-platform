import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Version Schemas ─────────────────────────────────────────────────────────

export const envChangeSchema = z.object({
  key: z.string(),
  action: z.enum(['add', 'remove', 'rename']),
  oldKey: z.string().optional(),
  default: z.unknown().optional(),
});

export const applicationVersionResponseSchema = z.object({
  id: uuidField,
  applicationCatalogId: z.string(),
  version: z.string(),
  isDefault: z.number(),
  eolDate: z.string().nullable(),
  components: z.array(z.object({ name: z.string(), image: z.string() })).nullable(),
  upgradeFrom: z.array(z.string()).nullable(),
  breakingChanges: z.string().nullable(),
  envChanges: z.array(envChangeSchema).nullable(),
  migrationNotes: z.string().nullable(),
  minResources: z.object({
    cpu: z.string().optional(),
    memory: z.string().optional(),
    storage: z.string().optional(),
  }).nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const applicationCatalogResponseSchema = z.object({
  id: uuidField,
  code: z.string(),
  name: z.string(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  defaultVersion: z.string().nullable(),
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
  supportedVersions: z.array(applicationVersionResponseSchema).nullable().optional(),
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
  installedVersion: z.string().nullable(),
  targetVersion: z.string().nullable(),
  lastUpgradedAt: z.string().nullable(),
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
  version: z.string().max(50).optional(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type ApplicationCatalogResponse = z.infer<typeof applicationCatalogResponseSchema>;
export type ApplicationInstanceResponse = z.infer<typeof applicationInstanceResponseSchema>;
export type ApplicationVersionResponse = z.infer<typeof applicationVersionResponseSchema>;
export type CreateApplicationInstanceInput = z.infer<typeof createApplicationInstanceSchema>;
export type EnvChange = z.infer<typeof envChangeSchema>;
