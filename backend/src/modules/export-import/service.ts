import { eq } from 'drizzle-orm';
import { clients, domains, hostingPlans, dnsServers } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

interface ExportData {
  readonly version: '1.0';
  readonly exportedAt: string;
  readonly clients: readonly Record<string, unknown>[];
  readonly domains: readonly Record<string, unknown>[];
  readonly hostingPlans: readonly Record<string, unknown>[];
  readonly dnsServers: readonly Record<string, unknown>[];
}

interface ImportResult {
  readonly dryRun: boolean;
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly string[];
}

export async function exportAll(db: Database): Promise<ExportData> {
  const [allClients, allDomains, allPlans, allDnsServers] = await Promise.all([
    db.select().from(clients),
    db.select().from(domains),
    db.select().from(hostingPlans),
    db.select().from(dnsServers),
  ]);

  // Mask encrypted fields on DNS servers
  const maskedDnsServers = allDnsServers.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    providerType: s.providerType,
    zoneDefaultKind: s.zoneDefaultKind,
    isDefault: s.isDefault,
    enabled: s.enabled,
    lastHealthCheck: s.lastHealthCheck,
    lastHealthStatus: s.lastHealthStatus,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    // connectionConfigEncrypted is intentionally omitted
  }));

  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    clients: allClients,
    domains: allDomains,
    hostingPlans: allPlans,
    dnsServers: maskedDnsServers,
  };
}

export async function importData(
  db: Database,
  data: Record<string, unknown>,
  options: { dryRun: boolean },
): Promise<ImportResult> {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Validate basic structure
  if (!data || typeof data !== 'object') {
    return { dryRun: options.dryRun, created, updated, skipped, errors: ['Invalid import data format'] };
  }

  const importVersion = data.version;
  if (importVersion !== '1.0') {
    return { dryRun: options.dryRun, created, updated, skipped, errors: [`Unsupported import version: ${importVersion}`] };
  }

  // Import hosting plans
  const importPlans = Array.isArray(data.hostingPlans) ? data.hostingPlans : [];
  for (const plan of importPlans) {
    try {
      if (!plan.id || !plan.code || !plan.name) {
        errors.push(`Hosting plan missing required fields: ${JSON.stringify(plan).slice(0, 100)}`);
        continue;
      }

      const [existing] = await db.select({ id: hostingPlans.id }).from(hostingPlans).where(eq(hostingPlans.id, plan.id));

      if (existing) {
        skipped++;
        continue;
      }

      if (!options.dryRun) {
        await db.insert(hostingPlans).values({
          id: plan.id,
          code: plan.code,
          name: plan.name,
          description: plan.description ?? null,
          cpuLimit: plan.cpuLimit ?? '1.00',
          memoryLimit: plan.memoryLimit ?? '1.00',
          storageLimit: plan.storageLimit ?? '10.00',
          monthlyPriceUsd: plan.monthlyPriceUsd ?? '0.00',
          maxSubUsers: plan.maxSubUsers ?? 3,
          features: plan.features ?? null,
          status: plan.status ?? 'active',
        });
      }
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Failed to import hosting plan ${plan.id}: ${message}`);
    }
  }

  // Import clients
  const importClients = Array.isArray(data.clients) ? data.clients : [];
  for (const client of importClients) {
    try {
      if (!client.id || !client.companyName || !client.companyEmail) {
        errors.push(`Client missing required fields: ${JSON.stringify(client).slice(0, 100)}`);
        continue;
      }

      const [existing] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, client.id));

      if (existing) {
        skipped++;
        continue;
      }

      if (!options.dryRun) {
        await db.insert(clients).values({
          id: client.id,
          regionId: client.regionId,
          companyName: client.companyName,
          companyEmail: client.companyEmail,
          contactEmail: client.contactEmail ?? null,
          status: client.status ?? 'pending',
          kubernetesNamespace: client.kubernetesNamespace,
          planId: client.planId,
          createdBy: client.createdBy ?? null,
        });
      }
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Failed to import client ${client.id}: ${message}`);
    }
  }

  // Import domains
  const importDomains = Array.isArray(data.domains) ? data.domains : [];
  for (const domain of importDomains) {
    try {
      if (!domain.id || !domain.clientId || !domain.domainName) {
        errors.push(`Domain missing required fields: ${JSON.stringify(domain).slice(0, 100)}`);
        continue;
      }

      const [existing] = await db.select({ id: domains.id }).from(domains).where(eq(domains.id, domain.id));

      if (existing) {
        skipped++;
        continue;
      }

      if (!options.dryRun) {
        await db.insert(domains).values({
          id: domain.id,
          clientId: domain.clientId,
          domainName: domain.domainName,
          status: domain.status ?? 'pending',
          dnsMode: domain.dnsMode ?? 'cname',
        });
      }
      created++;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`Failed to import domain ${domain.id}: ${message}`);
    }
  }

  // DNS servers: skip import — encrypted credentials cannot be imported
  const importDnsServers = Array.isArray(data.dnsServers) ? data.dnsServers : [];
  skipped += importDnsServers.length;

  return { dryRun: options.dryRun, created, updated, skipped, errors };
}
