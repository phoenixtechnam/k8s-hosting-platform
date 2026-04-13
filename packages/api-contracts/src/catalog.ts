import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Catalog Repository ──────────────────────────────────────────────────────

export const catalogRepoResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  url: z.string(),
  branch: z.string(),
  syncIntervalMinutes: z.number(),
  lastSyncedAt: z.string().nullable(),
  status: z.string(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createCatalogRepoSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(500),
  branch: z.string().max(100).default('main'),
  auth_token: z.string().max(500).optional(),
  sync_interval_minutes: z.number().int().min(5).max(1440).default(60),
});

export const updateCatalogRepoSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().max(500).optional(),
  branch: z.string().max(100).optional(),
  auth_token: z.string().max(500).nullable().optional(),
  sync_interval_minutes: z.number().int().min(5).max(1440).optional(),
});

// ─── Catalog Entry ───────────────────────────────────────────────────────────

export const componentSchema = z.object({
  name: z.string(),
  type: z.enum(['deployment', 'statefulset', 'cronjob', 'job']),
  image: z.string(),
  ports: z.array(z.object({
    port: z.number(),
    protocol: z.string(),
    ingress: z.boolean().optional(),
  })).optional(),
  optional: z.boolean().optional(),
  schedule: z.string().optional(),
});

export const volumeSchema = z.object({
  local_path: z.string(),
  container_path: z.string(),
  description: z.string().optional(),
  optional: z.boolean().optional(),
});

export const parameterSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['string', 'secret', 'boolean', 'integer', 'string[]']),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

export const catalogEntryResponseSchema = z.object({
  id: uuidField,
  code: z.string(),
  name: z.string(),
  type: z.enum(['application', 'runtime', 'database', 'service', 'static']),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  defaultVersion: z.string().nullable(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  documentation: z.string().nullable(),
  category: z.string().nullable(),
  minPlan: z.string().nullable(),
  tenancy: z.array(z.string()).nullable(),
  components: z.array(componentSchema).nullable(),
  networking: z.record(z.string(), z.unknown()).nullable(),
  volumes: z.array(volumeSchema).nullable(),
  resources: z.object({
    recommended: z.object({ cpu: z.string(), memory: z.string(), storage: z.string().optional() }),
    minimum: z.object({ cpu: z.string(), memory: z.string(), storage: z.string().optional() }),
  }).nullable(),
  healthCheck: z.record(z.string(), z.unknown()).nullable(),
  parameters: z.array(parameterSchema).nullable(),
  tags: z.array(z.string()).nullable(),
  runtime: z.string().nullable(),
  webServer: z.string().nullable(),
  image: z.string().nullable(),
  hasDockerfile: z.number(),
  deploymentStrategy: z.string().nullable(),
  services: z.record(z.string(), z.unknown()).nullable(),
  provides: z.record(z.string(), z.unknown()).nullable(),
  envVars: z.record(z.string(), z.unknown()).nullable(),
  status: z.string(),
  featured: z.number(),
  popular: z.number(),
  sourceRepoId: z.string().nullable(),
  manifestUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const catalogEntryListResponseSchema = paginatedResponseSchema(catalogEntryResponseSchema);

// ─── Catalog Entry Versions ──────────────────────────────────────────────────

export const envChangeSchema = z.object({
  key: z.string(),
  action: z.enum(['add', 'remove', 'rename']),
  oldKey: z.string().optional(),
  default: z.unknown().optional(),
});

export const catalogEntryVersionResponseSchema = z.object({
  id: uuidField,
  catalogEntryId: z.string(),
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

// ─── Deployments ─────────────────────────────────────────────────────────────

export const volumePathSchema = z.object({
  containerPath: z.string(),
  k8sPath: z.string(),
});

export const deploymentResponseSchema = z.object({
  id: uuidField,
  clientId: z.string(),
  catalogEntryId: z.string(),
  name: z.string(),
  domainName: z.string().nullable(),
  replicaCount: z.number(),
  cpuRequest: z.string(),
  memoryRequest: z.string(),
  configuration: z.record(z.string(), z.unknown()).nullable(),
  storagePath: z.string().nullable(),
  helmReleaseName: z.string().nullable(),
  installedVersion: z.string().nullable(),
  targetVersion: z.string().nullable(),
  lastUpgradedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  deletedAt: z.string().nullable(),
  status: z.string(),
  volumePaths: z.array(volumePathSchema).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const deploymentListResponseSchema = paginatedResponseSchema(deploymentResponseSchema);

/** DNS-compatible name: lowercase alphanumeric + hyphens, max 63 chars, must start/end with alphanumeric */
export const k8sNameRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const createDeploymentSchema = z.object({
  catalog_entry_id: z.string().uuid(),
  name: z.string().min(1).max(63).regex(k8sNameRegex, {
    message: 'Name must be DNS-compatible: lowercase letters, digits, and hyphens only (max 63 chars, must start and end with a letter or digit)',
  }),
  domain_name: z.string().max(255).optional(),
  replica_count: z.number().int().min(1).max(10).default(1),
  cpu_request: z.string().max(20).default('0.25'),
  memory_request: z.string().max(20).default('256Mi'),
  configuration: z.record(z.string(), z.unknown()).optional(),
  version: z.string().max(50).optional(),
  storage_mode: z.enum(['default', 'custom']).default('default'),
  storage_path: z.string().max(500).optional(),
});

export const updateDeploymentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  replica_count: z.number().int().min(1).max(10).optional(),
  cpu_request: z.string().max(20).optional(),
  memory_request: z.string().max(20).optional(),
  status: z.enum(['running', 'stopped']).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
});

export const updateDeploymentResourcesSchema = z.object({
  cpu_request: z.string().max(20).optional(),
  memory_request: z.string().max(20).optional(),
}).refine(data => data.cpu_request !== undefined || data.memory_request !== undefined, {
  message: 'At least one of cpu_request or memory_request must be provided',
});

// ─── Deployment Upgrades ─────────────────────────────────────────────────────

export const deploymentUpgradeResponseSchema = z.object({
  id: uuidField,
  deploymentId: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  status: z.string(),
  triggeredBy: z.string(),
  triggerType: z.string(),
  backupId: z.string().nullable(),
  progressPct: z.number(),
  statusMessage: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const triggerUpgradeSchema = z.object({
  target_version: z.string().min(1).max(50),
});

export const batchUpgradeSchema = z.object({
  deployment_ids: z.array(z.string().uuid()).min(1).max(50),
  target_version: z.string().min(1).max(50),
});

// ─── Delete Preview ─────────────────────────────────────────────────────────

export const deletePreviewRouteSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  path: z.string(),
  domainName: z.string(),
});

export const deletePreviewResponseSchema = z.object({
  deploymentId: z.string(),
  deploymentName: z.string(),
  affectedRoutes: z.array(deletePreviewRouteSchema),
});

// ─── Storage Folder Listing ─────────────────────────────────────────────────

export const storageFolderSchema = z.object({
  name: z.string(),
  path: z.string(),
  isEmpty: z.boolean(),
  usedByDeployment: z.string().nullable(),
});

export const storageFolderListResponseSchema = z.object({
  basePath: z.string(),
  folders: z.array(storageFolderSchema),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type CatalogRepoResponse = z.infer<typeof catalogRepoResponseSchema>;
export type CreateCatalogRepoInput = z.infer<typeof createCatalogRepoSchema>;
export type UpdateCatalogRepoInput = z.infer<typeof updateCatalogRepoSchema>;
export type CatalogEntryResponse = z.infer<typeof catalogEntryResponseSchema>;
export type CatalogEntryListResponse = z.infer<typeof catalogEntryListResponseSchema>;
export type CatalogEntryVersionResponse = z.infer<typeof catalogEntryVersionResponseSchema>;
export type DeploymentResponse = z.infer<typeof deploymentResponseSchema>;
export type DeploymentListResponse = z.infer<typeof deploymentListResponseSchema>;
export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;
export type UpdateDeploymentInput = z.infer<typeof updateDeploymentSchema>;
export type UpdateDeploymentResourcesInput = z.infer<typeof updateDeploymentResourcesSchema>;
export type DeploymentUpgradeResponse = z.infer<typeof deploymentUpgradeResponseSchema>;
export type TriggerUpgradeInput = z.infer<typeof triggerUpgradeSchema>;
export type BatchUpgradeInput = z.infer<typeof batchUpgradeSchema>;
export type EnvChange = z.infer<typeof envChangeSchema>;
export type Component = z.infer<typeof componentSchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type VolumePath = z.infer<typeof volumePathSchema>;
export type Parameter = z.infer<typeof parameterSchema>;
export type DeletePreviewRoute = z.infer<typeof deletePreviewRouteSchema>;
export type DeletePreviewResponse = z.infer<typeof deletePreviewResponseSchema>;
export type StorageFolder = z.infer<typeof storageFolderSchema>;
export type StorageFolderListResponse = z.infer<typeof storageFolderListResponseSchema>;
