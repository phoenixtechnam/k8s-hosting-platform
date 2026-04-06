import { eq, and, asc, sql } from 'drizzle-orm';
import { dnsServers, dnsProviderGroups, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { createProvider } from './providers/index.js';
import type { DnsProviderAdapter } from './providers/types.js';
import type { Database } from '../../db/index.js';

// ─── DNS Server CRUD ────────────────────────────────────────────────────────

export async function listDnsServers(db: Database) {
  const servers = await db.select().from(dnsServers).orderBy(asc(dnsServers.displayName));
  return servers.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    providerType: s.providerType,
    zoneDefaultKind: s.zoneDefaultKind,
    groupId: s.groupId,
    role: s.role,
    isDefault: Boolean(s.isDefault),
    enabled: Boolean(s.enabled),
    lastHealthCheck: s.lastHealthCheck,
    lastHealthStatus: s.lastHealthStatus,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

export async function getDnsServerById(db: Database, id: string) {
  const [server] = await db.select().from(dnsServers).where(eq(dnsServers.id, id));
  if (!server) throw new ApiError('DNS_SERVER_NOT_FOUND', `DNS server '${id}' not found`, 404);
  return server;
}

export interface CreateDnsServerInput {
  readonly display_name: string;
  readonly provider_type: string;
  readonly connection_config: Record<string, unknown>;
  readonly zone_default_kind?: 'Native' | 'Master';
  readonly is_default?: boolean;
  readonly enabled?: boolean;
  readonly group_id?: string;
  readonly role?: 'primary' | 'secondary';
}

export async function createDnsServer(db: Database, input: CreateDnsServerInput, encryptionKey: string) {
  // Validate provider type by trying to create it
  const provider = createProvider(input.provider_type, input.connection_config);

  // Test connection
  const health = await provider.testConnection();
  if (health.status !== 'ok') {
    throw new ApiError('DNS_CONNECTION_FAILED', `Cannot connect to DNS server: ${health.message}`, 400);
  }

  // Validate group_id if provided
  if (input.group_id) {
    await getProviderGroupById(db, input.group_id);
  }

  const id = crypto.randomUUID();
  const configEncrypted = encrypt(JSON.stringify(input.connection_config), encryptionKey);

  await db.insert(dnsServers).values({
    id,
    displayName: input.display_name,
    providerType: input.provider_type as typeof dnsServers.$inferInsert['providerType'],
    connectionConfigEncrypted: configEncrypted,
    zoneDefaultKind: (input.zone_default_kind ?? 'Native') as typeof dnsServers.$inferInsert['zoneDefaultKind'],
    groupId: input.group_id ?? null,
    role: input.role ?? 'primary',
    isDefault: input.is_default ? 1 : 0,
    enabled: input.enabled !== false ? 1 : 0,
    lastHealthCheck: new Date(),
    lastHealthStatus: 'ok',
  });

  return getDnsServerById(db, id);
}

export async function updateDnsServer(db: Database, id: string, input: Partial<CreateDnsServerInput>, encryptionKey: string) {
  await getDnsServerById(db, id);

  const updateValues: Record<string, unknown> = {};
  if (input.display_name !== undefined) updateValues.displayName = input.display_name;
  if (input.provider_type !== undefined) updateValues.providerType = input.provider_type;
  if (input.connection_config !== undefined) {
    updateValues.connectionConfigEncrypted = encrypt(JSON.stringify(input.connection_config), encryptionKey);
  }
  if (input.zone_default_kind !== undefined) updateValues.zoneDefaultKind = input.zone_default_kind;
  if (input.is_default !== undefined) updateValues.isDefault = input.is_default ? 1 : 0;
  if (input.enabled !== undefined) updateValues.enabled = input.enabled ? 1 : 0;
  if (input.group_id !== undefined) updateValues.groupId = input.group_id;
  if (input.role !== undefined) updateValues.role = input.role;

  if (Object.keys(updateValues).length > 0) {
    await db.update(dnsServers).set(updateValues).where(eq(dnsServers.id, id));
  }

  return getDnsServerById(db, id);
}

export async function deleteDnsServer(db: Database, id: string) {
  await getDnsServerById(db, id);
  await db.delete(dnsServers).where(eq(dnsServers.id, id));
}

export async function testDnsServerConnection(db: Database, id: string, encryptionKey: string) {
  const server = await getDnsServerById(db, id);
  const config = JSON.parse(decrypt(server.connectionConfigEncrypted, encryptionKey));
  const provider = createProvider(server.providerType, config);

  const health = await provider.testConnection();

  // Update health status
  await db.update(dnsServers).set({
    lastHealthCheck: new Date(),
    lastHealthStatus: health.status,
  }).where(eq(dnsServers.id, id));

  return health;
}

export function getProviderForServer(server: typeof dnsServers.$inferSelect, encryptionKey: string): DnsProviderAdapter {
  const config = JSON.parse(decrypt(server.connectionConfigEncrypted, encryptionKey));
  return createProvider(server.providerType, config);
}

export async function getActiveServers(db: Database, groupId?: string) {
  if (groupId) {
    return db.select().from(dnsServers).where(
      and(eq(dnsServers.enabled, 1), eq(dnsServers.groupId, groupId)),
    );
  }
  return db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));
}

// ─── DNS Provider Group CRUD ────────────────────────────────────────────────

export async function listProviderGroups(db: Database) {
  const groups = await db.select().from(dnsProviderGroups).orderBy(asc(dnsProviderGroups.name));

  // Enrich with server and domain counts
  const enriched = await Promise.all(groups.map(async (g) => {
    const [serverCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(dnsServers)
      .where(eq(dnsServers.groupId, g.id));
    const [domainCount] = await db
      .select({ count: sql<number>`count(*)` })
      .from(domains)
      .where(eq(domains.dnsGroupId, g.id));
    return {
      id: g.id,
      name: g.name,
      isDefault: Boolean(g.isDefault),
      nsHostnames: g.nsHostnames,
      serverCount: Number(serverCount?.count ?? 0),
      domainCount: Number(domainCount?.count ?? 0),
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
    };
  }));

  return enriched;
}

export async function getProviderGroupById(db: Database, id: string) {
  const [group] = await db.select().from(dnsProviderGroups).where(eq(dnsProviderGroups.id, id));
  if (!group) throw new ApiError('DNS_PROVIDER_GROUP_NOT_FOUND', `DNS provider group '${id}' not found`, 404);
  return group;
}

export async function getDefaultGroup(db: Database) {
  const [group] = await db.select().from(dnsProviderGroups).where(eq(dnsProviderGroups.isDefault, 1));
  return group ?? null;
}

export interface CreateProviderGroupInput {
  readonly name: string;
  readonly is_default?: boolean;
  readonly ns_hostnames?: string[];
}

export async function createProviderGroup(db: Database, input: CreateProviderGroupInput) {
  const id = crypto.randomUUID();

  // If marking as default, clear existing default
  if (input.is_default) {
    await db.update(dnsProviderGroups).set({ isDefault: 0 }).where(eq(dnsProviderGroups.isDefault, 1));
  }

  await db.insert(dnsProviderGroups).values({
    id,
    name: input.name,
    isDefault: input.is_default ? 1 : 0,
    nsHostnames: input.ns_hostnames ?? null,
  });

  return getProviderGroupById(db, id);
}

export interface UpdateProviderGroupInput {
  readonly name?: string;
  readonly is_default?: boolean;
  readonly ns_hostnames?: string[];
}

export async function updateProviderGroup(db: Database, id: string, input: UpdateProviderGroupInput) {
  await getProviderGroupById(db, id);

  // If marking as default, clear existing default first
  if (input.is_default) {
    await db.update(dnsProviderGroups).set({ isDefault: 0 }).where(eq(dnsProviderGroups.isDefault, 1));
  }

  const updateValues: Record<string, unknown> = {};
  if (input.name !== undefined) updateValues.name = input.name;
  if (input.is_default !== undefined) updateValues.isDefault = input.is_default ? 1 : 0;
  if (input.ns_hostnames !== undefined) updateValues.nsHostnames = input.ns_hostnames;

  if (Object.keys(updateValues).length > 0) {
    await db.update(dnsProviderGroups).set(updateValues).where(eq(dnsProviderGroups.id, id));
  }

  return getProviderGroupById(db, id);
}

export async function deleteProviderGroup(db: Database, id: string) {
  await getProviderGroupById(db, id);

  // Check if any domains use this group
  const [domainCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(domains)
    .where(eq(domains.dnsGroupId, id));

  if (Number(domainCount?.count ?? 0) > 0) {
    throw new ApiError(
      'GROUP_HAS_DOMAINS',
      'Cannot delete provider group that is assigned to domains. Migrate domains first.',
      409,
    );
  }

  // Unassign servers from this group
  await db.update(dnsServers).set({ groupId: null }).where(eq(dnsServers.groupId, id));

  await db.delete(dnsProviderGroups).where(eq(dnsProviderGroups.id, id));
}

export async function getServersForGroup(db: Database, groupId: string) {
  return db.select().from(dnsServers).where(eq(dnsServers.groupId, groupId));
}

export async function getPrimaryServersForGroup(db: Database, groupId: string) {
  return db.select().from(dnsServers).where(
    and(
      eq(dnsServers.groupId, groupId),
      eq(dnsServers.role, 'primary'),
      eq(dnsServers.enabled, 1),
    ),
  );
}

/**
 * Get the active servers for a domain, using its group or the default group.
 * Returns only primary servers when a group is resolved.
 */
export async function getActiveServersForDomain(db: Database, domainId: string) {
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain) return [];

  const groupId = domain.dnsGroupId;
  if (groupId) {
    return getPrimaryServersForGroup(db, groupId);
  }

  // Fall back to default group
  const defaultGroup = await getDefaultGroup(db);
  if (defaultGroup) {
    return getPrimaryServersForGroup(db, defaultGroup.id);
  }

  // No group at all — fall back to all active servers (backward compat)
  return db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));
}
