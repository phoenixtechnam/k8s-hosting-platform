import { describe, it, expect } from 'vitest';
import { metricsQuerySchema } from './schema.js';

describe('metricsQuerySchema', () => {
  it('should accept empty object with defaults', () => {
    const result = metricsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.period).toBe('24h');
      expect(result.data.metric_type).toBeUndefined();
    }
  });

  it('should accept valid periods', () => {
    expect(metricsQuerySchema.safeParse({ period: '24h' }).success).toBe(true);
    expect(metricsQuerySchema.safeParse({ period: '7d' }).success).toBe(true);
    expect(metricsQuerySchema.safeParse({ period: '30d' }).success).toBe(true);
  });

  it('should reject invalid period', () => {
    expect(metricsQuerySchema.safeParse({ period: '1y' }).success).toBe(false);
  });

  it('should accept valid metric types', () => {
    expect(metricsQuerySchema.safeParse({ metric_type: 'cpu_cores' }).success).toBe(true);
    expect(metricsQuerySchema.safeParse({ metric_type: 'memory_gb' }).success).toBe(true);
    expect(metricsQuerySchema.safeParse({ metric_type: 'storage_gb' }).success).toBe(true);
    expect(metricsQuerySchema.safeParse({ metric_type: 'bandwidth_gb' }).success).toBe(true);
  });

  it('should reject invalid metric type', () => {
    expect(metricsQuerySchema.safeParse({ metric_type: 'disk_iops' }).success).toBe(false);
  });
});
