import { z } from 'zod';

// ─── Input Schemas ───────────────────────────────────────────────────────────

export const metricsQuerySchema = z.object({
  period: z.enum(['24h', '7d', '30d']).default('24h'),
  metric_type: z.enum(['cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb']).optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const metricAggregateSchema = z.object({
  avg: z.number(),
  max: z.number(),
  min: z.number(),
  count: z.number(),
  latest: z.number(),
});

export const metricsResponseSchema = z.object({
  client_id: z.string(),
  period: z.string(),
  since: z.string(),
  metrics: z.record(z.string(), metricAggregateSchema),
  data_points: z.number(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
export type MetricAggregate = z.infer<typeof metricAggregateSchema>;
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;
