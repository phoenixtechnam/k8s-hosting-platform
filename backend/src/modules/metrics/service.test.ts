import { describe, it, expect, vi } from 'vitest';
import { getMetrics } from './service.js';

vi.mock('../clients/service.js', () => ({
  getClientById: vi.fn().mockResolvedValue({ id: 'c1', companyName: 'Acme' }),
}));

function createMockDb(rows: Array<{ metricType: string; value: string }> = []) {
  const orderByFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return { select: selectFn } as unknown as Parameters<typeof getMetrics>[0];
}

describe('getMetrics', () => {
  it('should return empty metrics when no data', async () => {
    const db = createMockDb([]);

    const result = await getMetrics(db, 'c1', { period: '24h' });
    expect(result.client_id).toBe('c1');
    expect(result.period).toBe('24h');
    expect(result.data_points).toBe(0);
    expect(result.metrics).toEqual({});
  });

  it('should aggregate metrics by type', async () => {
    const rows = [
      { metricType: 'cpu_cores', value: '2.0' },
      { metricType: 'cpu_cores', value: '4.0' },
      { metricType: 'memory_gb', value: '8.0' },
    ];
    const db = createMockDb(rows);

    const result = await getMetrics(db, 'c1', { period: '7d' });
    expect(result.period).toBe('7d');
    expect(result.data_points).toBe(3);
    expect(result.metrics.cpu_cores.avg).toBe(3);
    expect(result.metrics.cpu_cores.max).toBe(4);
    expect(result.metrics.cpu_cores.min).toBe(2);
    expect(result.metrics.cpu_cores.count).toBe(2);
    expect(result.metrics.cpu_cores.latest).toBe(4);
    expect(result.metrics.memory_gb.avg).toBe(8);
    expect(result.metrics.memory_gb.count).toBe(1);
  });

  it('should handle 30d period', async () => {
    const db = createMockDb([]);
    const result = await getMetrics(db, 'c1', { period: '30d' });
    expect(result.period).toBe('30d');
    expect(result.since).toBeDefined();
  });

  it('should pass metric_type filter', async () => {
    const db = createMockDb([]);
    const result = await getMetrics(db, 'c1', { period: '24h', metric_type: 'cpu_cores' });
    expect(result.metrics).toEqual({});
  });
});
