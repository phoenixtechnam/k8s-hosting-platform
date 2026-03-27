import { z } from 'zod';

export const healthServiceSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'error', 'degraded']),
  latencyMs: z.number(),
  message: z.string().optional(),
});

export type HealthService = z.infer<typeof healthServiceSchema>;

export const healthResponseSchema = z.object({
  overall: z.enum(['healthy', 'degraded', 'unhealthy']),
  services: z.array(healthServiceSchema),
  checkedAt: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
