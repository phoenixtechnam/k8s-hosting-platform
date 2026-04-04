import { sql, eq } from 'drizzle-orm';
import type * as k8s from '@kubernetes/client-node';
import { dnsServers, oidcProviders } from '../../db/schema.js';
import { getProviderForServer } from '../dns-servers/service.js';
import { getRedis } from '../../shared/redis.js';
import type { Database } from '../../db/index.js';

export interface ServiceStatus {
  readonly name: string;
  readonly status: 'ok' | 'degraded' | 'error';
  readonly latencyMs?: number;
  readonly message?: string;
}

export interface HealthCheckResult {
  readonly overall: 'healthy' | 'degraded' | 'unhealthy';
  readonly services: readonly ServiceStatus[];
  readonly checkedAt: string;
}

export async function checkDatabase(db: Database): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    const latencyMs = Date.now() - start;
    return { name: 'database', status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Database unreachable';
    return { name: 'database', status: 'error', latencyMs, message };
  }
}

export async function checkDnsServers(db: Database, encryptionKey: string): Promise<readonly ServiceStatus[]> {
  const servers = await db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));

  const results: ServiceStatus[] = [];

  for (const server of servers) {
    try {
      const provider = getProviderForServer(server, encryptionKey);
      const health = await provider.testConnection();
      results.push({
        name: `dns:${server.displayName}`,
        status: health.status === 'ok' ? 'ok' : 'error',
        message: health.message,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      results.push({
        name: `dns:${server.displayName}`,
        status: 'error',
        message,
      });
    }
  }

  return results;
}

export async function checkOidc(db: Database): Promise<ServiceStatus> {
  try {
    const providers = await db.select({ id: oidcProviders.id, enabled: oidcProviders.enabled })
      .from(oidcProviders);

    const enabledCount = providers.filter((p) => p.enabled === 1).length;

    if (providers.length === 0) {
      return { name: 'oidc', status: 'ok', message: 'No OIDC providers configured' };
    }

    if (enabledCount === 0) {
      return { name: 'oidc', status: 'degraded', message: 'All OIDC providers disabled' };
    }

    return { name: 'oidc', status: 'ok', message: `${enabledCount} provider(s) active` };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'OIDC check failed';
    return { name: 'oidc', status: 'error', message };
  }
}

export async function checkKubernetes(core?: k8s.CoreV1Api): Promise<ServiceStatus> {
  if (!core) {
    return { name: 'kubernetes', status: 'degraded', message: 'No kubeconfig configured' };
  }
  const start = Date.now();
  try {
    const res = await core.listNode();
    const latencyMs = Date.now() - start;
    const nodeCount = res.items.length;
    return { name: 'kubernetes', status: 'ok', latencyMs, message: `${nodeCount} node(s)` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'K8s API unreachable';
    return { name: 'kubernetes', status: 'error', latencyMs, message };
  }
}

export async function checkRedis(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const redis = getRedis();
    await redis.ping();
    const latencyMs = Date.now() - start;
    return { name: 'redis', status: 'ok', latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Redis unreachable';
    return { name: 'redis', status: 'error', latencyMs, message };
  }
}

export async function runAllChecks(db: Database, encryptionKey: string, k8sCore?: k8s.CoreV1Api): Promise<HealthCheckResult> {
  const [dbStatus, dnsStatuses, oidcStatus, k8sStatus, redisStatus] = await Promise.all([
    checkDatabase(db),
    checkDnsServers(db, encryptionKey),
    checkOidc(db),
    checkKubernetes(k8sCore),
    checkRedis(),
  ]);

  const services: readonly ServiceStatus[] = [dbStatus, ...dnsStatuses, oidcStatus, k8sStatus, redisStatus];

  const hasError = services.some((s) => s.status === 'error');
  const hasDegraded = services.some((s) => s.status === 'degraded');

  let overall: 'healthy' | 'degraded' | 'unhealthy';
  if (hasError) {
    overall = 'unhealthy';
  } else if (hasDegraded) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }

  return {
    overall,
    services,
    checkedAt: new Date().toISOString(),
  };
}
