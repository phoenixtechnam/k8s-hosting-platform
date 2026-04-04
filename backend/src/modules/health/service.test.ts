import { describe, it, expect, vi } from 'vitest';

// Mock dns-servers service before importing
vi.mock('../dns-servers/service.js', () => ({
  getProviderForServer: vi.fn().mockReturnValue({
    testConnection: vi.fn().mockResolvedValue({ status: 'ok', message: 'Connected' }),
  }),
}));

vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(),
}));

const { checkDatabase, checkDnsServers, checkOidc, checkKubernetes, checkRedis, runAllChecks } = await import('./service.js');
const { getRedis } = await import('../../shared/redis.js') as { getRedis: ReturnType<typeof vi.fn> };

function createExecuteMock(shouldFail = false) {
  if (shouldFail) {
    return vi.fn().mockRejectedValue(new Error('Connection refused'));
  }
  return vi.fn().mockResolvedValue([{ '1': 1 }]);
}

describe('health service', () => {
  it('database check returns ok with latency', async () => {
    const db = {
      execute: createExecuteMock(),
    } as any;

    const result = await checkDatabase(db);

    expect(result.name).toBe('database');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('database check returns error when connection fails', async () => {
    const db = {
      execute: createExecuteMock(true),
    } as any;

    const result = await checkDatabase(db);

    expect(result.name).toBe('database');
    expect(result.status).toBe('error');
    expect(result.message).toContain('Connection refused');
  });

  it('DNS server check aggregates results from active servers', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 's1', displayName: 'Primary DNS', providerType: 'powerdns', connectionConfigEncrypted: '{}', enabled: 1 },
            { id: 's2', displayName: 'Secondary DNS', providerType: 'powerdns', connectionConfigEncrypted: '{}', enabled: 1 },
          ]),
        }),
      }),
    } as any;

    const results = await checkDnsServers(db, '0'.repeat(64));

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('dns:Primary DNS');
    expect(results[1].name).toBe('dns:Secondary DNS');
  });

  it('overall status is healthy when all services are ok', async () => {
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) }) // dns servers
      .mockResolvedValueOnce([]); // oidc providers

    const db = {
      execute: createExecuteMock(),
      select: vi.fn().mockReturnValue({ from: fromFn }),
    } as any;

    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      status: 'ready',
    });

    const k8sCore = {
      listNode: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'n1' } }] }),
    };

    const result = await runAllChecks(db, '0'.repeat(64), k8sCore as any);

    expect(result.overall).toBe('healthy');
    expect(result.checkedAt).toBeDefined();
    expect(result.services.length).toBeGreaterThanOrEqual(4);
  });

  it('overall status is unhealthy when database check fails', async () => {
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) }) // dns servers
      .mockResolvedValueOnce([]); // oidc providers

    const db = {
      execute: createExecuteMock(true),
      select: vi.fn().mockReturnValue({ from: fromFn }),
    } as any;

    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      status: 'ready',
    });

    const result = await runAllChecks(db, '0'.repeat(64));

    expect(result.overall).toBe('unhealthy');
  });

  it('overall status is degraded when OIDC providers are all disabled', async () => {
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) }) // dns servers
      .mockResolvedValueOnce([{ id: 'p1', enabled: 0 }]); // oidc providers — all disabled

    const db = {
      execute: createExecuteMock(),
      select: vi.fn().mockReturnValue({ from: fromFn }),
    } as any;

    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      status: 'ready',
    });

    const k8sCore = {
      listNode: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'n1' } }] }),
    };

    const result = await runAllChecks(db, '0'.repeat(64), k8sCore as any);

    expect(result.overall).toBe('degraded');
  });

  // --- Kubernetes health check ---

  it('kubernetes check returns ok with node count', async () => {
    const k8sCore = {
      listNode: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'node1' } }, { metadata: { name: 'node2' } }] }),
    };
    const result = await checkKubernetes(k8sCore as any);
    expect(result.name).toBe('kubernetes');
    expect(result.status).toBe('ok');
    expect(result.message).toBe('2 node(s)');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('kubernetes check returns error when API unreachable', async () => {
    const k8sCore = {
      listNode: vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND k3s-server')),
    };
    const result = await checkKubernetes(k8sCore as any);
    expect(result.name).toBe('kubernetes');
    expect(result.status).toBe('error');
    expect(result.message).toContain('ENOTFOUND');
  });

  it('kubernetes check returns not_configured when no client provided', async () => {
    const result = await checkKubernetes(undefined);
    expect(result.name).toBe('kubernetes');
    expect(result.status).toBe('degraded');
    expect(result.message).toBe('No kubeconfig configured');
  });

  // --- Redis health check ---

  it('redis check returns ok when ping succeeds', async () => {
    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      status: 'ready',
    });
    const result = await checkRedis();
    expect(result.name).toBe('redis');
    expect(result.status).toBe('ok');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('redis check returns error when ping fails', async () => {
    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockRejectedValue(new Error('Connection refused')),
      status: 'ready',
    });
    const result = await checkRedis();
    expect(result.name).toBe('redis');
    expect(result.status).toBe('error');
    expect(result.message).toContain('Connection refused');
  });

  // --- runAllChecks includes k8s and redis ---

  it('runAllChecks includes kubernetes and redis services', async () => {
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce([]);
    const db = {
      execute: createExecuteMock(),
      select: vi.fn().mockReturnValue({ from: fromFn }),
    } as any;

    (getRedis as ReturnType<typeof vi.fn>).mockReturnValue({
      ping: vi.fn().mockResolvedValue('PONG'),
      status: 'ready',
    });

    const k8sCore = {
      listNode: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'n1' } }] }),
    };

    const result = await runAllChecks(db, '0'.repeat(64), k8sCore as any);
    const names = result.services.map((s) => s.name);
    expect(names).toContain('kubernetes');
    expect(names).toContain('redis');
  });
});
