import { eq, and, gte } from 'drizzle-orm';
import { usageMetrics } from '../../db/schema.js';
import { getClientById } from '../clients/service.js';
import type { Database } from '../../db/index.js';
import type { MetricsQuery } from './schema.js';

function periodToDate(period: string): Date {
  const now = new Date();
  switch (period) {
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '30d': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    default: return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

export async function getMetrics(db: Database, clientId: string, query: MetricsQuery) {
  await getClientById(db, clientId);

  const since = periodToDate(query.period);
  const conditions = [
    eq(usageMetrics.clientId, clientId),
    gte(usageMetrics.measurementTimestamp, since),
  ];

  if (query.metric_type) {
    conditions.push(eq(usageMetrics.metricType, query.metric_type));
  }

  const rows = await db
    .select()
    .from(usageMetrics)
    .where(and(...conditions))
    .orderBy(usageMetrics.measurementTimestamp);

  // Aggregate by metric type
  const aggregated = rows.reduce<Record<string, { avg: number; max: number; min: number; count: number; latest: number }>>((acc, row) => {
    const type = row.metricType;
    const val = Number(row.value);
    if (!acc[type]) {
      acc[type] = { avg: 0, max: -Infinity, min: Infinity, count: 0, latest: val };
    }
    acc[type].count++;
    acc[type].avg += val;
    acc[type].max = Math.max(acc[type].max, val);
    acc[type].min = Math.min(acc[type].min, val);
    acc[type].latest = val;
    return acc;
  }, {});

  // Finalize averages
  for (const type of Object.keys(aggregated)) {
    const entry = aggregated[type];
    entry.avg = entry.count > 0 ? entry.avg / entry.count : 0;
    if (entry.min === Infinity) entry.min = 0;
    if (entry.max === -Infinity) entry.max = 0;
  }

  return {
    client_id: clientId,
    period: query.period,
    since: since.toISOString(),
    metrics: aggregated,
    data_points: rows.length,
  };
}
