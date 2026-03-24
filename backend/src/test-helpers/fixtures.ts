import { regions, hostingPlans, clients, domains, backups } from '../db/schema.js';
import type { Database } from '../db/index.js';

export async function seedRegion(db: Database, overrides: Partial<typeof regions.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    code: `test-region-${id.slice(0, 8)}`,
    name: 'Test Region',
    provider: 'hetzner',
    status: 'active' as const,
  };
  await db.insert(regions).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedPlan(db: Database, overrides: Partial<typeof hostingPlans.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    code: `plan-${id.slice(0, 8)}`,
    name: 'Test Plan',
    cpuLimit: '1.00',
    memoryLimit: '2.00',
    storageLimit: '20.00',
    monthlyPriceUsd: '10.00',
    status: 'active' as const,
  };
  await db.insert(hostingPlans).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedClient(db: Database, regionId: string, planId: string, overrides: Partial<typeof clients.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    regionId,
    companyName: `Test Company ${id.slice(0, 8)}`,
    companyEmail: `test-${id.slice(0, 8)}@example.com`,
    status: 'active' as const,
    kubernetesNamespace: `client-test-${id.slice(0, 8)}`,
    planId,
  };
  await db.insert(clients).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedDomain(db: Database, clientId: string, overrides: Partial<typeof domains.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    clientId,
    domainName: `test-${id.slice(0, 8)}.example.com`,
    status: 'active' as const,
    dnsMode: 'cname' as const,
  };
  await db.insert(domains).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

export async function seedBackup(db: Database, clientId: string, overrides: Partial<typeof backups.$inferInsert> = {}) {
  const id = crypto.randomUUID();
  const defaults = {
    id,
    clientId,
    backupType: 'manual' as const,
    resourceType: 'full',
    status: 'completed' as const,
    sizeBytes: 1024000,
    storagePath: `/backups/${clientId}/${id}.tar.gz`,
  };
  await db.insert(backups).values({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}
