/**
 * Ingress route service.
 *
 * Manages per-hostname routing with CNAME-chain architecture.
 * Each route generates: hostname → {slug}.ingress.platform.net → node → IP
 */

import { eq, and } from 'drizzle-orm';
import { ingressRoutes, domains, dnsRecords, platformSettings } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { syncRecordToProviders } from '../dns-records/service.js';
import type { Database } from '../../db/index.js';

// ─── Platform Ingress Settings ──────────────────────────────────────────────

const ENV_INGRESS_BASE_DOMAIN = process.env.INGRESS_BASE_DOMAIN;
const ENV_INGRESS_DEFAULT_IPV4 = process.env.INGRESS_DEFAULT_IPV4;

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onDuplicateKeyUpdate({ set: { value } });
}

export async function getIngressSettings(db: Database) {
  const baseDomain = await getSetting(db, 'ingress_base_domain');
  const ipv4 = await getSetting(db, 'ingress_default_ipv4');
  const ipv6 = await getSetting(db, 'ingress_default_ipv6');

  return {
    ingressBaseDomain: baseDomain ?? ENV_INGRESS_BASE_DOMAIN ?? 'ingress.localhost',
    ingressDefaultIpv4: ipv4 ?? ENV_INGRESS_DEFAULT_IPV4 ?? '127.0.0.1',
    ingressDefaultIpv6: ipv6 ?? null,
  };
}

export async function updateIngressSettings(
  db: Database,
  input: { ingressBaseDomain?: string; ingressDefaultIpv4?: string; ingressDefaultIpv6?: string | null },
) {
  if (input.ingressBaseDomain !== undefined) {
    await setSetting(db, 'ingress_base_domain', input.ingressBaseDomain);
  }
  if (input.ingressDefaultIpv4 !== undefined) {
    await setSetting(db, 'ingress_default_ipv4', input.ingressDefaultIpv4);
  }
  if (input.ingressDefaultIpv6 !== undefined) {
    if (input.ingressDefaultIpv6) {
      await setSetting(db, 'ingress_default_ipv6', input.ingressDefaultIpv6);
    }
  }
  return getIngressSettings(db);
}

// ─── CNAME Slug Generation ──────────────────────────────────────────────────

/**
 * Generate a DNS-safe CNAME slug from a hostname.
 * e.g., "blog.example.com" → "blog-example-com"
 */
export function hostnameToSlug(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63); // DNS label max length
}

/**
 * Detect if a hostname is the zone apex (same as domain name).
 */
export function isApexHostname(hostname: string, domainName: string): boolean {
  return hostname.toLowerCase() === domainName.toLowerCase();
}

// ─── Route CRUD ─────────────────────────────────────────────────────────────

export async function createRoute(
  db: Database,
  domainId: string,
  clientId: string,
  hostname: string,
  workloadId?: string | null,
) {
  // Verify domain ownership
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  // Check for duplicate hostname
  const [existing] = await db
    .select({ id: ingressRoutes.id })
    .from(ingressRoutes)
    .where(eq(ingressRoutes.hostname, hostname));

  if (existing) {
    throw new ApiError('ROUTE_EXISTS', `Route for '${hostname}' already exists`, 409);
  }

  const settings = await getIngressSettings(db);
  const slug = hostnameToSlug(hostname);
  const ingressCname = `${slug}.${settings.ingressBaseDomain}`;
  const apex = isApexHostname(hostname, domain.domainName);

  const id = crypto.randomUUID();
  await db.insert(ingressRoutes).values({
    id,
    domainId,
    hostname,
    workloadId: workloadId ?? null,
    ingressCname,
    nodeHostname: null, // uses default node
    isApex: apex ? 1 : 0,
    tlsMode: 'auto',
    status: 'active',
  });

  // Auto-create DNS records for PRIMARY domains
  if (domain.dnsMode === 'primary') {
    try {
      if (apex) {
        // Apex: create A record (CNAME not allowed at apex per RFC 1034)
        await syncRecordToProviders(db, domain.domainName, 'create', {
          type: 'A',
          name: '@',
          content: settings.ingressDefaultIpv4,
          ttl: 300,
        });
        // Also add AAAA if IPv6 configured
        const ipv6 = await getSetting(db, 'ingress_default_ipv6');
        if (ipv6) {
          await syncRecordToProviders(db, domain.domainName, 'create', {
            type: 'AAAA',
            name: '@',
            content: ipv6,
            ttl: 300,
          });
        }
      } else {
        // Subdomain: create CNAME → ingressCname
        const subdomain = hostname.replace(`.${domain.domainName}`, '');
        await syncRecordToProviders(db, domain.domainName, 'create', {
          type: 'CNAME',
          name: subdomain,
          content: ingressCname,
          ttl: 300,
        });
      }
    } catch {
      // DNS creation failure shouldn't block route creation
    }
  }

  const [created] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, id));
  return created;
}

export async function updateRoute(
  db: Database,
  routeId: string,
  input: { workloadId?: string | null; tlsMode?: string; nodeHostname?: string | null },
) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.workloadId !== undefined) updateValues.workloadId = input.workloadId;
  if (input.tlsMode !== undefined) updateValues.tlsMode = input.tlsMode;
  if (input.nodeHostname !== undefined) updateValues.nodeHostname = input.nodeHostname;

  if (Object.keys(updateValues).length > 0) {
    await db.update(ingressRoutes).set(updateValues).where(eq(ingressRoutes.id, routeId));
  }

  const [updated] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  return updated;
}

export async function deleteRoute(db: Database, routeId: string) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }
  await db.delete(ingressRoutes).where(eq(ingressRoutes.id, routeId));
}

export async function listRoutesForDomain(db: Database, domainId: string) {
  return db.select().from(ingressRoutes).where(eq(ingressRoutes.domainId, domainId));
}

export async function listRoutesForClient(db: Database, clientId: string) {
  // Join routes with domains to filter by client
  const clientDomains = await db.select({ id: domains.id }).from(domains).where(eq(domains.clientId, clientId));
  const domainIds = clientDomains.map(d => d.id);
  if (domainIds.length === 0) return [];

  const allRoutes = await db.select().from(ingressRoutes);
  return allRoutes.filter(r => domainIds.includes(r.domainId));
}
