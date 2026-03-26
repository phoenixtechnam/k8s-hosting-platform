import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const createWorkloadSchema = z.object({
  name: z.string().min(1).max(255),
  image_id: z.string().uuid(),
  replica_count: z.number().int().min(1).max(10).default(1),
  cpu_request: z.string().max(20).default('0.25'),
  memory_request: z.string().max(20).default('256Mi'),
});

export const updateWorkloadSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  image_id: z.string().uuid().optional(),
  replica_count: z.number().int().min(1).max(10).optional(),
  cpu_request: z.string().max(20).optional(),
  memory_request: z.string().max(20).optional(),
  status: z.enum(['running', 'stopped']).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const workloadResponseSchema = z.object({
  id: uuidField,
  clientId: uuidField,
  name: z.string(),
  containerImageId: z.string().nullable(),
  replicaCount: z.number(),
  cpuRequest: z.string(),
  memoryRequest: z.string(),
  status: z.enum(['running', 'stopped', 'pending', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workloadListResponseSchema = paginatedResponseSchema(workloadResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateWorkloadInput = z.infer<typeof createWorkloadSchema>;
export type UpdateWorkloadInput = z.infer<typeof updateWorkloadSchema>;
export type WorkloadResponse = z.infer<typeof workloadResponseSchema>;
export type WorkloadListResponse = z.infer<typeof workloadListResponseSchema>;
