import { z } from 'zod';

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

export type CreateWorkloadInput = z.infer<typeof createWorkloadSchema>;
export type UpdateWorkloadInput = z.infer<typeof updateWorkloadSchema>;
