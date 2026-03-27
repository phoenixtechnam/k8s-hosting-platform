import { describe, it, expect, vi } from 'vitest';
import { exportAll, importData } from './service.js';

function createMockDb(options?: {
  clients?: Record<string, unknown>[];
  domains?: Record<string, unknown>[];
  hostingPlans?: Record<string, unknown>[];
  dnsServers?: Record<string, unknown>[];
}) {
  const data = {
    clients: options?.clients ?? [{ id: 'c1', companyName: 'Acme', companyEmail: 'admin@acme.com', status: 'active', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'client-acme' }],
    domains: options?.domains ?? [{ id: 'd1', clientId: 'c1', domainName: 'acme.com', status: 'active' }],
    hostingPlans: options?.hostingPlans ?? [{ id: 'p1', code: 'starter', name: 'Starter', cpuLimit: '1.00', memoryLimit: '1.00', storageLimit: '10.00', monthlyPriceUsd: '9.99' }],
    dnsServers: options?.dnsServers ?? [{ id: 'dns1', displayName: 'Primary', providerType: 'powerdns', connectionConfigEncrypted: 'ENCRYPTED_SECRET', zoneDefaultKind: 'Native', isDefault: 1, enabled: 1 }],
  };

  // Track what table is being selected from
  let callCount = 0;
  const tableOrder = ['clients', 'domains', 'hostingPlans', 'dnsServers'];

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockImplementation(() => {
        const tableName = tableOrder[callCount % tableOrder.length];
        callCount++;
        const tableData = data[tableName as keyof typeof data] ?? [];
        return {
          where: vi.fn().mockResolvedValue([]), // for import existence check
          then: (resolve: (v: unknown) => void) => resolve(tableData), // for export select
          [Symbol.toStringTag]: 'Promise',
        };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  } as any;
}

describe('export service', () => {
  it('export includes all resource types', async () => {
    const clientsData = [{ id: 'c1', companyName: 'Acme', companyEmail: 'admin@acme.com' }];
    const domainsData = [{ id: 'd1', clientId: 'c1', domainName: 'acme.com' }];
    const plansData = [{ id: 'p1', code: 'starter', name: 'Starter' }];
    const dnsData = [{ id: 'dns1', displayName: 'Primary', providerType: 'powerdns', connectionConfigEncrypted: 'SECRET' }];

    let callIdx = 0;
    const results = [clientsData, domainsData, plansData, dnsData];

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          return Promise.resolve(results[callIdx++] ?? []);
        }),
      }),
    } as any;

    const result = await exportAll(db);

    expect(result.version).toBe('1.0');
    expect(result.exportedAt).toBeDefined();
    expect(result.clients).toHaveLength(1);
    expect(result.domains).toHaveLength(1);
    expect(result.hostingPlans).toHaveLength(1);
    expect(result.dnsServers).toHaveLength(1);
  });

  it('export masks sensitive fields on DNS servers', async () => {
    const dnsData = [{
      id: 'dns1',
      displayName: 'Primary',
      providerType: 'powerdns',
      connectionConfigEncrypted: 'TOP_SECRET_ENCRYPTED_DATA',
      zoneDefaultKind: 'Native',
      isDefault: 1,
      enabled: 1,
      lastHealthCheck: null,
      lastHealthStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];

    let callIdx = 0;
    const results = [[], [], [], dnsData];

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          return Promise.resolve(results[callIdx++] ?? []);
        }),
      }),
    } as any;

    const result = await exportAll(db);

    expect(result.dnsServers).toHaveLength(1);
    const exported = result.dnsServers[0] as Record<string, unknown>;
    expect(exported.connectionConfigEncrypted).toBeUndefined();
    expect(exported.displayName).toBe('Primary');
  });
});

describe('import service', () => {
  it('import with dry_run reports changes without writing', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // nothing exists
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    } as any;

    const importPayload = {
      version: '1.0',
      clients: [{ id: 'c1', companyName: 'Acme', companyEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [{ id: 'd1', clientId: 'c1', domainName: 'acme.com' }],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(3); // 1 plan + 1 client + 1 domain
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('import creates new records', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]), // nothing exists
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    } as any;

    const importPayload = {
      version: '1.0',
      clients: [{ id: 'c1', companyName: 'Acme', companyEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.created).toBe(2); // 1 plan + 1 client
    expect(db.insert).toHaveBeenCalled();
  });

  it('import skips duplicates', async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'existing' }]), // already exists
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    } as any;

    const importPayload = {
      version: '1.0',
      clients: [{ id: 'c1', companyName: 'Acme', companyEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [{ id: 'd1', clientId: 'c1', domainName: 'acme.com' }],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: false });

    expect(result.skipped).toBe(3); // all 3 already exist
    expect(result.created).toBe(0);
  });
});
