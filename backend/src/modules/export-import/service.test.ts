import { describe, it, expect, vi } from 'vitest';
import { exportAll, importData } from './service.js';

function createMockDb(options?: {
  tenants?: Record<string, unknown>[];
  domains?: Record<string, unknown>[];
  hostingPlans?: Record<string, unknown>[];
  dnsServers?: Record<string, unknown>[];
}) {
  const data = {
    tenants: options?.tenants ?? [{ id: 'c1', name: 'Acme', primaryEmail: 'admin@acme.com', status: 'active', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'tenant-acme' }],
    domains: options?.domains ?? [{ id: 'd1', tenantId: 'c1', domainName: 'acme.com', status: 'active' }],
    hostingPlans: options?.hostingPlans ?? [{ id: 'p1', code: 'starter', name: 'Starter', cpuLimit: '1.00', memoryLimit: '1.00', storageLimit: '10.00', monthlyPriceUsd: '9.99' }],
    dnsServers: options?.dnsServers ?? [{ id: 'dns1', displayName: 'Primary', providerType: 'powerdns', connectionConfigEncrypted: 'ENCRYPTED_SECRET', zoneDefaultKind: 'Native', isDefault: 1, enabled: 1 }],
  };

  // Track what table is being selected from
  let callCount = 0;
  const tableOrder = ['tenants', 'domains', 'hostingPlans', 'dnsServers'];

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
  // exportAll's first SELECT (tenants, is_system=false filter) is
  // chained: `.from(tenants).where(...)`. The second SELECT
  // (is_system=true ids for SYSTEM-owned domain filtering) is also
  // chained. The remaining three SELECTs (domains/plans/dnsServers)
  // call `.from()` directly without `.where()`. The mock below
  // returns thenable objects with both `.where()` and direct-resolve
  // semantics so a single chain handler serves all callers.
  function buildExportMockDb(results: unknown[][]) {
    let callIdx = 0;
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          const rows = results[callIdx++] ?? [];
          return {
            where: vi.fn().mockResolvedValue(rows),
            then: (resolve: (v: unknown) => void) => resolve(rows),
            [Symbol.toStringTag]: 'Promise',
          };
        }),
      }),
    } as any;
  }

  it('export includes all resource types', async () => {
    const clientsData = [{ id: 'c1', name: 'Acme', primaryEmail: 'admin@acme.com' }];
    // SYSTEM-tenant-id lookup query — return empty so no domain filtering happens.
    const systemTenantIdsData: unknown[] = [];
    const domainsData = [{ id: 'd1', tenantId: 'c1', domainName: 'acme.com' }];
    const plansData = [{ id: 'p1', code: 'starter', name: 'Starter' }];
    const dnsData = [{ id: 'dns1', displayName: 'Primary', providerType: 'powerdns', connectionConfigEncrypted: 'SECRET' }];

    const db = buildExportMockDb([
      clientsData, // SELECT tenants WHERE isSystem=false
      domainsData, // SELECT domains
      plansData,   // SELECT hostingPlans
      dnsData,     // SELECT dnsServers
      systemTenantIdsData, // SELECT id FROM tenants WHERE isSystem=true
    ]);

    const result = await exportAll(db);

    expect(result.version).toBe('1.0');
    expect(result.exportedAt).toBeDefined();
    expect(result.tenants).toHaveLength(1);
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

    const db = buildExportMockDb([
      [],     // tenants
      [],     // domains
      [],     // hostingPlans
      dnsData, // dnsServers
      [],     // system tenant ids
    ]);

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
      tenants: [{ id: 'c1', name: 'Acme', primaryEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [{ id: 'd1', tenantId: 'c1', domainName: 'acme.com' }],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(3); // 1 plan + 1 tenant + 1 domain
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
      tenants: [{ id: 'c1', name: 'Acme', primaryEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(result.created).toBe(2); // 1 plan + 1 tenant
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
      tenants: [{ id: 'c1', name: 'Acme', primaryEmail: 'admin@acme.com', regionId: 'r1', planId: 'p1', kubernetesNamespace: 'ns-acme' }],
      domains: [{ id: 'd1', tenantId: 'c1', domainName: 'acme.com' }],
      hostingPlans: [{ id: 'p1', code: 'starter', name: 'Starter' }],
      dnsServers: [],
    };

    const result = await importData(db, importPayload, { dryRun: false });

    expect(result.skipped).toBe(3); // all 3 already exist
    expect(result.created).toBe(0);
  });
});
