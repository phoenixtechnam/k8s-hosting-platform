/**
 * Ingress route service.
 *
 * Manages per-hostname routing with CNAME-chain architecture.
 * Each route generates: hostname → {slug}.ingress.platform.net → node → IP
 */

import { eq, and } from 'drizzle-orm';
import { ingressRoutes, domains, platformSettings, dnsRecords } from '../../db/schema.js';
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
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
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

// ─── www Companion Hostname ──────────────────────────────────────────────────

/**
 * Compute the companion hostname for a www redirect, if any.
 * Returns null when no companion is needed.
 */
export function getWwwCompanionHostname(
  hostname: string,
  wwwRedirect: string | null | undefined,
): string | null {
  if (wwwRedirect === 'add-www' && !hostname.startsWith('www.')) {
    return `www.${hostname}`;
  }
  if (wwwRedirect === 'remove-www' && !hostname.startsWith('www.')) {
    // The route is test-ingress.local with remove-www
    // Need www.test-ingress.local to resolve so the redirect can happen
    return `www.${hostname}`;
  }
  if (wwwRedirect === 'remove-www' && hostname.startsWith('www.')) {
    return hostname.replace(/^www\./, '');
  }
  return null;
}

// ─── Route CRUD ─────────────────────────────────────────────────────────────

export async function createRoute(
  db: Database,
  domainId: string,
  clientId: string,
  hostname: string,
  deploymentId?: string | null,
  path?: string,
) {
  // Normalize path — default to "/", ensure leading and trailing slashes
  let routePath = path && path.trim() !== '' ? path.trim() : '/';
  if (!routePath.startsWith('/')) routePath = `/${routePath}`;
  if (routePath !== '/' && !routePath.endsWith('/')) routePath = `${routePath}/`;
  if (routePath.length > 255) {
    throw new ApiError('VALIDATION_ERROR', 'Path must be 255 characters or less', 400);
  }
  if (routePath.includes('..')) {
    throw new ApiError('VALIDATION_ERROR', 'Path must not contain ".."', 400);
  }
  if (routePath.length > 255) {
    throw new ApiError('VALIDATION_ERROR', 'Path must be 255 characters or fewer', 400);
  }

  // Verify domain ownership
  const [domain] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.clientId, clientId)));

  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found`, 404);
  }

  // Validate hostname belongs to domain
  // hostname must be either:
  // - the domain name itself (apex): "example.com"
  // - a subdomain: "*.example.com" where * is non-empty
  if (hostname !== domain.domainName && !hostname.endsWith(`.${domain.domainName}`)) {
    throw new ApiError(
      'INVALID_HOSTNAME',
      `Hostname '${hostname}' must be '${domain.domainName}' or a subdomain of it (e.g., www.${domain.domainName})`,
      400,
    );
  }

  // Check for duplicate hostname+path combination
  const [existing] = await db
    .select({ id: ingressRoutes.id })
    .from(ingressRoutes)
    .where(and(
      eq(ingressRoutes.hostname, hostname),
      eq(ingressRoutes.path, routePath),
      eq(ingressRoutes.domainId, domainId),
    ));

  if (existing) {
    throw new ApiError(
      'DUPLICATE_ROUTE',
      `Route for '${hostname}${routePath === '/' ? '' : routePath}' already exists`,
      409,
    );
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
    path: routePath,
    deploymentId: deploymentId ?? null,
    ingressCname,
    nodeHostname: null, // uses default node
    isApex: apex ? 1 : 0,
    tlsMode: 'auto',
    status: 'active',
  });

  // Auto-create DNS records for PRIMARY domains
  if (domain.dnsMode === 'primary') {
    const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');
    try {
      // Always create A record (simpler, no CNAME limitations)
      await syncRecordToProviders(db, domain.domainName, 'create', {
        type: 'A',
        name: recordName,
        content: settings.ingressDefaultIpv4,
        ttl: 300,
      });
      // Also add AAAA if IPv6 configured
      const ipv6 = await getSetting(db, 'ingress_default_ipv6');
      if (ipv6) {
        await syncRecordToProviders(db, domain.domainName, 'create', {
          type: 'AAAA',
          name: recordName,
          content: ipv6,
          ttl: 300,
        });
      }
    } catch {
      // DNS creation failure shouldn't block route creation
    }
  }

  // Auto-resolve .local domains: create A record pointing to ingress IP
  // This enables local DinD testing without external DNS
  if (hostname.endsWith('.local') && domain.dnsMode !== 'primary') {
    try {
      const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');
      await syncRecordToProviders(db, domain.domainName, 'create', {
        type: 'A',
        name: recordName,
        content: settings.ingressDefaultIpv4,
        ttl: 300,
      });
    } catch {
      // Non-blocking
    }
  }

  const [created] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, id));
  return created;
}

export async function updateRoute(
  db: Database,
  routeId: string,
  input: { deploymentId?: string | null; tlsMode?: string; nodeHostname?: string | null },
) {
  const [route] = await db.select().from(ingressRoutes).where(eq(ingressRoutes.id, routeId));
  if (!route) {
    throw new ApiError('ROUTE_NOT_FOUND', `Ingress route '${routeId}' not found`, 404);
  }

  const updateValues: Record<string, unknown> = {};
  if (input.deploymentId !== undefined) updateValues.deploymentId = input.deploymentId;
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

  // Auto-delete DNS records that were provisioned for this route
  try {
    await autoDeleteRouteDns(db, route.domainId, route.hostname);
  } catch {
    // Non-blocking — DNS cleanup failure shouldn't block route deletion
  }

  // Also delete the companion DNS record if www redirect was active
  const companionHostname = getWwwCompanionHostname(route.hostname, route.wwwRedirect);
  if (companionHostname) {
    try {
      await autoDeleteRouteDns(db, route.domainId, companionHostname);
    } catch {
      // Non-blocking
    }
  }
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

// ─── Auto-DNS Provisioning ───────────────────────────────────────────────────

/**
 * Auto-provision DNS records for a hostname under a domain.
 *
 * For primary-mode domains this creates A/AAAA records (both apex and
 * subdomain) via the configured DNS providers. Non-blocking — failures
 * are swallowed so callers are never disrupted.
 */
export async function autoProvisionRouteDns(
  db: Database,
  domainId: string,
  hostname: string,
): Promise<void> {
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain || domain.dnsMode !== 'primary') return;

  const settings = await getIngressSettings(db);
  const apex = isApexHostname(hostname, domain.domainName);

  const recordName = apex ? '@' : hostname.replace(`.${domain.domainName}`, '');

  try {
    // Always create A record (simpler, no CNAME limitations at apex or subdomain)
    await syncRecordToProviders(db, domain.domainName, 'create', {
      type: 'A',
      name: recordName,
      content: settings.ingressDefaultIpv4,
      ttl: 300,
    });
    const ipv6 = await getSetting(db, 'ingress_default_ipv6');
    if (ipv6) {
      await syncRecordToProviders(db, domain.domainName, 'create', {
        type: 'AAAA',
        name: recordName,
        content: ipv6,
        ttl: 300,
      });
    }
  } catch {
    // Non-blocking — DNS provisioning failure should not break callers
  }
}

// ─── Auto-DNS Cleanup ───────────────────────────────────────────────────────

/**
 * Remove DNS records that were auto-provisioned when the route was created.
 *
 * For primary-mode domains this deletes the A/AAAA records from both the
 * external DNS provider and the local dns_records table.
 */
export async function autoDeleteRouteDns(
  db: Database,
  domainId: string,
  hostname: string,
): Promise<void> {
  // 1. Check if domain is primary mode
  const [domain] = await db.select().from(domains).where(eq(domains.id, domainId));
  if (!domain || domain.dnsMode !== 'primary') return;

  // 2. Determine the record name relative to the domain
  //    hostname: "app.example.com", domainName: "example.com" → "app"
  //    hostname: "example.com",     domainName: "example.com" → "@" (apex)
  const apex = hostname.toLowerCase() === domain.domainName.toLowerCase();
  const recordName = apex
    ? '@'
    : hostname.replace(`.${domain.domainName}`, '');

  // 3. Delete from external DNS provider(s)
  const settings = await getIngressSettings(db);

  // All routes (apex and subdomain) now use A records
  await syncRecordToProviders(db, domain.domainName, 'delete', {
    type: 'A',
    name: recordName,
    content: settings.ingressDefaultIpv4,
    id: 'auto', // provider uses name|type|content composite key
  }, domainId);

  const ipv6 = await getSetting(db, 'ingress_default_ipv6');
  if (ipv6) {
    await syncRecordToProviders(db, domain.domainName, 'delete', {
      type: 'AAAA',
      name: recordName,
      content: ipv6,
      id: 'auto',
    }, domainId);
  }

  // 4. Remove matching records from local dns_records table
  const localRecords = await db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.recordName, recordName)));

  for (const rec of localRecords) {
    // Only delete records that match what auto-provisioning would have created (A/AAAA)
    if (rec.recordType === 'A' || rec.recordType === 'AAAA') {
      await db.delete(dnsRecords).where(eq(dnsRecords.id, rec.id));
    }
  }
}
