import { z } from 'zod';

export const metricsQuerySchema = z.object({
  period: z.enum(['24h', '7d', '30d']).default('24h'),
  metric_type: z.enum(['cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb']).optional(),
});

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
