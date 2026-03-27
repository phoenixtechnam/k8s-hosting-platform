import { describe, it, expect, vi } from 'vitest';

// Mock dns-servers service before importing
vi.mock('../dns-servers/service.js', () => ({
  getProviderForServer: vi.fn().mockReturnValue({
    testConnection: vi.fn().mockResolvedValue({ status: 'ok', message: 'Connected' }),
  }),
}));

const { checkDatabase, checkDnsServers, checkOidc, runAllChecks } = await import('./service.js');

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
    const db = {
      execute: createExecuteMock(),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any;

    // Mock OIDC: no providers configured
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]), // no DNS servers
      }),
    }).mockReturnValueOnce({
      from: vi.fn().mockResolvedValue([]), // no OIDC providers
    });

    // Re-setup with proper chaining for the actual call
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    // Override select for oidc check (no where)
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) }) // dns servers
      .mockResolvedValueOnce([]); // oidc providers

    db.select = vi.fn().mockReturnValue({ from: fromFn });

    const result = await runAllChecks(db, '0'.repeat(64));

    expect(result.overall).toBe('healthy');
    expect(result.checkedAt).toBeDefined();
    expect(result.services.length).toBeGreaterThanOrEqual(2);
  });

  it('overall status is unhealthy when database check fails', async () => {
    const fromFn = vi.fn()
      .mockReturnValueOnce({ where: vi.fn().mockResolvedValue([]) }) // dns servers
      .mockResolvedValueOnce([]); // oidc providers

    const db = {
      execute: createExecuteMock(true),
      select: vi.fn().mockReturnValue({ from: fromFn }),
    } as any;

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

    const result = await runAllChecks(db, '0'.repeat(64));

    expect(result.overall).toBe('degraded');
  });
});
