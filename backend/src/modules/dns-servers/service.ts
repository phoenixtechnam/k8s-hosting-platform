import { eq, asc } from 'drizzle-orm';
import { dnsServers } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { encrypt, decrypt } from '../oidc/crypto.js';
import { createProvider } from './providers/index.js';
import type { DnsProviderAdapter } from './providers/types.js';
import type { Database } from '../../db/index.js';

export async function listDnsServers(db: Database) {
  const servers = await db.select().from(dnsServers).orderBy(asc(dnsServers.displayName));
  return servers.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    providerType: s.providerType,
    zoneDefaultKind: s.zoneDefaultKind,
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

interface CreateDnsServerInput {
  readonly display_name: string;
  readonly provider_type: string;
  readonly connection_config: Record<string, unknown>;
  readonly zone_default_kind?: 'Native' | 'Master';
  readonly is_default?: boolean;
  readonly enabled?: boolean;
}

export async function createDnsServer(db: Database, input: CreateDnsServerInput, encryptionKey: string) {
  // Validate provider type by trying to create it
  const provider = createProvider(input.provider_type, input.connection_config);

  // Test connection
  const health = await provider.testConnection();
  if (health.status !== 'ok') {
    throw new ApiError('DNS_CONNECTION_FAILED', `Cannot connect to DNS server: ${health.message}`, 400);
  }

  const id = crypto.randomUUID();
  const configEncrypted = encrypt(JSON.stringify(input.connection_config), encryptionKey);

  await db.insert(dnsServers).values({
    id,
    displayName: input.display_name,
    providerType: input.provider_type as any,
    connectionConfigEncrypted: configEncrypted,
    zoneDefaultKind: (input.zone_default_kind ?? 'Native') as any,
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

export async function getActiveServers(db: Database) {
  return db.select().from(dnsServers).where(eq(dnsServers.enabled, 1));
}
