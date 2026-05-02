import dns from 'node:dns/promises';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';
import type { Database } from '../../db/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VerificationCheck {
  readonly type: string;
  readonly status: 'pass' | 'fail';
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly checks: readonly VerificationCheck[];
}

export interface PlatformConfig {
  readonly nameservers: readonly string[];
  readonly ingressHostname: string;
}

export interface PlatformIngressIps {
  readonly v4: Set<string>;
  readonly v6: Set<string>;
  readonly source: 'cluster_nodes' | 'dns' | 'mixed' | 'none';
}

// ─── Platform IP Detector ────────────────────────────────────────────────────

/**
 * Build the set of IPs that identify this platform's ingress.
 *
 * Sources (both merged):
 * 1. All cluster_nodes rows with role in ('server','worker') active in the
 *    last 7 days — uses publicIp for v4.
 * 2. DNS resolution of the ingressBaseDomain — A + AAAA records.
 *
 * Survives empty cluster_nodes table (falls back to DNS-only).
 * Survives DNS failure (falls back to cluster_nodes-only).
 */
export async function getPlatformIngressIps(
  db: Database,
  ingressBaseDomain?: string,
): Promise<PlatformIngressIps> {
  const v4Set = new Set<string>();
  const v6Set = new Set<string>();
  let hasNodes = false;
  let hasDns = false;

  // Source 1: cluster_nodes table
  // Use dynamic imports to keep drizzle-orm out of the top-level imports
  // (the test environment cannot resolve drizzle-orm as a package — see
  // the getPlatformConfig function below for the same pattern).
  try {
    const { clusterNodes } = await import('../../db/schema.js');
    const { and, gt, inArray } = await import('drizzle-orm');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // HIGH fix from code review: explicit role filter — both server and
    // worker run the ingress DaemonSet today, but documenting the intent
    // protects us against a future role (e.g. `storage_only`) that
    // shouldn't accept tenant ingress traffic.
    const nodes = await db
      .select({ publicIp: clusterNodes.publicIp })
      .from(clusterNodes)
      .where(
        and(
          gt(clusterNodes.lastSeenAt, sevenDaysAgo),
          inArray(clusterNodes.role, ['server', 'worker']),
        ),
      );
    for (const node of nodes) {
      if (node.publicIp) {
        const ip = String(node.publicIp);
        // Rough IPv6 detection: contains ':'
        if (ip.includes(':')) {
          v6Set.add(ip);
        } else {
          v4Set.add(ip);
        }
        hasNodes = true;
      }
    }
  } catch {
    // cluster_nodes unavailable — will rely on DNS
  }

  // Source 2: DNS resolution of the ingress base domain
  if (ingressBaseDomain) {
    try {
      const [v4Result, v6Result] = await Promise.allSettled([
        dns.resolve4(ingressBaseDomain),
        dns.resolve6(ingressBaseDomain),
      ]);
      if (v4Result.status === 'fulfilled') {
        for (const ip of v4Result.value) {
          v4Set.add(ip);
          hasDns = true;
        }
      }
      if (v6Result.status === 'fulfilled') {
        for (const ip of v6Result.value) {
          v6Set.add(ip);
          hasDns = true;
        }
      }
    } catch {
      // DNS resolution failed — cluster_nodes is the only source
    }
  }

  const source: PlatformIngressIps['source'] =
    hasNodes && hasDns ? 'mixed'
    : hasNodes ? 'cluster_nodes'
    : hasDns ? 'dns'
    : 'none';

  return { v4: v4Set, v6: v6Set, source };
}

// ─── DNS Verification Functions ─────────────────────────────────────────────

export async function verifyNsDelegation(
  domain: string,
  expectedNs: readonly string[],
): Promise<VerificationCheck> {
  try {
    const actualNs = await dns.resolveNs(domain);
    const normalizedActual = actualNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));
    const normalizedExpected = expectedNs.map((ns) => ns.toLowerCase().replace(/\.$/, ''));

    const allMatch = normalizedExpected.every((ns) => normalizedActual.includes(ns));

    return {
      type: 'ns_delegation',
      status: allMatch ? 'pass' : 'fail',
      detail: allMatch
        ? `NS records correctly delegated to: ${normalizedActual.join(', ')}`
        : `Expected NS: ${normalizedExpected.join(', ')} — found: ${normalizedActual.join(', ')}`,
    };
  } catch (err) {
    return {
      type: 'ns_delegation',
      status: 'fail',
      detail: `NS lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * @deprecated Use verifyResolvesToPlatform for cname-mode domains instead.
 * This function does an exact CNAME match which rejects CDN/proxy setups.
 */
export async function verifyCnameRecord(
  hostname: string,
  expectedTarget: string,
): Promise<VerificationCheck> {
  try {
    const cnames = await dns.resolveCname(hostname);
    const normalizedCnames = cnames.map((c) => c.toLowerCase().replace(/\.$/, ''));
    const normalizedTarget = expectedTarget.toLowerCase().replace(/\.$/, '');

    const matches = normalizedCnames.includes(normalizedTarget);

    return {
      type: 'cname_record',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `CNAME correctly points to ${normalizedTarget}`
        : `Expected CNAME target: ${normalizedTarget} — found: ${normalizedCnames.join(', ') || 'none'}`,
    };
  } catch (err) {
    return {
      type: 'cname_record',
      status: 'fail',
      detail: `CNAME lookup failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Resolve IPs for a hostname using both A and AAAA queries.
 * dns.resolve4/6 follow CNAME chains transparently.
 * Returns an empty array (and optionally logs into `errors`) if no records exist.
 */
async function resolveAllIps(
  hostname: string,
  errors: string[],
): Promise<{ v4: string[]; v6: string[] }> {
  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const v4: string[] = [];
  const v6: string[] = [];

  if (v4Result.status === 'fulfilled') {
    v4.push(...v4Result.value);
  } else {
    const code = (v4Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`A lookup error: ${v4Result.reason instanceof Error ? v4Result.reason.message : String(v4Result.reason)}`);
    }
  }

  if (v6Result.status === 'fulfilled') {
    v6.push(...v6Result.value);
  } else {
    const code = (v6Result.reason as NodeJS.ErrnoException).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
      errors.push(`AAAA lookup error: ${v6Result.reason instanceof Error ? v6Result.reason.message : String(v6Result.reason)}`);
    }
  }

  return { v4, v6 };
}

/**
 * Verify that a customer hostname ultimately resolves to one or more IPs
 * that overlap with the platform's known ingress IPs (from cluster_nodes
 * table + DNS resolution of the ingressBaseDomain).
 *
 * Pass/fail is determined by IP-set intersection — any CDN or proxy chain
 * that ends at the platform's ingress IPs will pass. Checks both v4 and v6.
 *
 * Pre-fetched platformIps can be passed to avoid redundant lookups across
 * multiple domains in the same cron tick.
 */
export async function verifyResolvesToPlatform(
  hostname: string,
  ingressBaseDomain: string,
  db: Database,
  precomputedPlatformIps?: PlatformIngressIps,
): Promise<VerificationCheck> {
  // Get platform IPs (from cache if pre-fetched by cron)
  const platformIps = precomputedPlatformIps ?? await getPlatformIngressIps(db, ingressBaseDomain);

  if (platformIps.v4.size === 0 && platformIps.v6.size === 0) {
    const detail = platformIps.source === 'none'
      ? `Platform ingress has no resolvable A/AAAA records — operator misconfiguration (ingress_base_domain not set or DNS not resolving)`
      : `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration`;
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // Resolve customer hostname IPs (follows CNAME chain transparently)
  const customerErrors: string[] = [];
  const customerIps = await resolveAllIps(hostname, customerErrors);
  const allCustomerIps = [...customerIps.v4, ...customerIps.v6];

  if (allCustomerIps.length === 0) {
    let detail = `No A/AAAA records resolve for ${hostname}`;
    if (customerErrors.length > 0) {
      detail += ` (${customerErrors.join('; ')})`;
    }
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // IP-set intersection check — v4 and v6 independently
  const v4Overlap = customerIps.v4.filter((ip) => platformIps.v4.has(ip));
  const v6Overlap = customerIps.v6.filter((ip) => platformIps.v6.has(ip));
  const passes = v4Overlap.length > 0 || v6Overlap.length > 0;

  // Build a friendly CNAME-chain prefix for the detail message (best-effort)
  let chainPrefix = '';
  try {
    const cnames = await dns.resolveCname(hostname);
    if (cnames.length > 0) {
      chainPrefix = `${hostname} → ${cnames.join(' → ')} → `;
    }
  } catch {
    // CNAME chain is informational only — ignore lookup failures
  }

  const resolvedDisplay = `${chainPrefix}${allCustomerIps.join(', ')}`;
  const platformDisplay = [...platformIps.v4, ...platformIps.v6].join(', ');

  const detail = passes
    ? `${resolvedDisplay} (matches platform IPs: ${[...v4Overlap, ...v6Overlap].join(', ')})`
    : `Resolved IPs (${resolvedDisplay}) do not overlap with platform IPs (${platformDisplay})`;

  return {
    type: 'cname_to_ingress',
    status: passes ? 'pass' : 'fail',
    detail,
  };
}

/**
 * Legacy shim — resolves ingress IPs via DNS only (no cluster_nodes lookup).
 * Used by the routes.ts verify endpoint which passes an explicit
 * ingressBaseDomain string. Keep for backwards compat with existing tests.
 *
 * @deprecated Prefer verifyResolvesToPlatform(hostname, ingressBaseDomain, db)
 */
export async function verifyResolvesToIngress(
  hostname: string,
  ingressBaseDomain: string,
): Promise<VerificationCheck> {
  // Resolve ingress base IPs first — if this fails it's an operator config problem
  const ingressErrors: string[] = [];
  const ingressIpsResult = await resolveAllIps(ingressBaseDomain, ingressErrors);
  const ingressIps = [...ingressIpsResult.v4, ...ingressIpsResult.v6];

  if (ingressIps.length === 0) {
    const detail = ingressErrors.length > 0
      ? `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration (${ingressErrors.join('; ')})`
      : `Platform ingress base domain has no resolvable A/AAAA records — operator misconfiguration`;
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // Resolve customer hostname IPs (follows CNAME chain transparently)
  const customerErrors: string[] = [];
  const customerIpsResult = await resolveAllIps(hostname, customerErrors);
  const customerIps = [...customerIpsResult.v4, ...customerIpsResult.v6];

  if (customerIps.length === 0) {
    let detail = `No A/AAAA records resolve for ${hostname}`;
    if (customerErrors.length > 0) {
      detail += ` (${customerErrors.join('; ')})`;
    }
    return { type: 'cname_to_ingress', status: 'fail', detail };
  }

  // IP-set intersection check
  const ingressSet = new Set(ingressIps);
  const overlap = customerIps.filter((ip) => ingressSet.has(ip));
  const passes = overlap.length > 0;

  // Build a friendly CNAME-chain prefix for the detail message (best-effort)
  let chainPrefix = '';
  try {
    const cnames = await dns.resolveCname(hostname);
    if (cnames.length > 0) {
      chainPrefix = `${hostname} → ${cnames.join(' → ')} → `;
    }
  } catch {
    // CNAME chain is informational only — ignore lookup failures
  }

  const resolvedDisplay = `${chainPrefix}${customerIps.join(', ')}`;

  const detail = passes
    ? `${resolvedDisplay} (matches ingress base IPs: ${[...ingressSet].join(', ')})`
    : `Resolved IPs (${resolvedDisplay}) do not overlap with ingress base IPs (${ingressIps.join(', ')})`;

  return {
    type: 'cname_to_ingress',
    status: passes ? 'pass' : 'fail',
    detail,
  };
}

export async function verifyAxfrSync(
  db: Database,
  domainName: string,
): Promise<VerificationCheck> {
  const encryptionKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
  try {
    const activeServers = await getActiveServers(db);
    for (const server of activeServers) {
      try {
        const provider = getProviderForServer(server, encryptionKey);
        if (provider.getZoneAxfrStatus) {
          const axfrStatus = await provider.getZoneAxfrStatus(domainName);
          return {
            type: 'axfr_sync',
            status: axfrStatus.synced ? 'pass' : 'fail',
            detail: axfrStatus.synced
              ? `AXFR synced — SOA serial: ${axfrStatus.lastSoaSerial ?? 'unknown'}`
              : 'AXFR not yet synced — SOA record not found',
          };
        }
        // Fallback: check if zone exists with SOA via getZone
        const zone = await provider.getZone(domainName);
        return {
          type: 'axfr_sync',
          status: zone ? 'pass' : 'fail',
          detail: zone
            ? `Slave zone exists — serial: ${zone.serial}`
            : 'Slave zone not found on DNS server',
        };
      } catch {
        // Try next server
      }
    }
    return {
      type: 'axfr_sync',
      status: 'fail',
      detail: 'No DNS server available to check AXFR status',
    };
  } catch {
    return {
      type: 'axfr_sync',
      status: 'fail',
      detail: 'Failed to check AXFR status — no DNS servers configured',
    };
  }
}

// ─── Main Verification Dispatcher ───────────────────────────────────────────

export async function verifyDomain(
  domain: string,
  dnsMode: 'primary' | 'cname' | 'secondary',
  platformConfig: PlatformConfig,
  db: Database,
  precomputedPlatformIps?: PlatformIngressIps,
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  switch (dnsMode) {
    case 'primary': {
      const nsCheck = await verifyNsDelegation(domain, platformConfig.nameservers);
      checks.push(nsCheck);
      break;
    }
    case 'cname': {
      // Use platform IP-set intersection (cluster_nodes + DNS) so worker IPs
      // and IPv6 addresses are included in the match set.
      const cnameCheck = await verifyResolvesToPlatform(
        domain,
        platformConfig.ingressHostname,
        db,
        precomputedPlatformIps,
      );
      checks.push(cnameCheck);
      break;
    }
    case 'secondary': {
      const axfrCheck = await verifyAxfrSync(db, domain);
      checks.push(axfrCheck);
      break;
    }
  }

  const verified = checks.length > 0 && checks.every((c) => c.status === 'pass');

  return { verified, checks };
}

// ─── Config Helper ──────────────────────────────────────────────────────────

/**
 * Read platform configuration.
 * ingressHostname is read from platform_settings.ingress_base_domain (DB-first),
 * then falls back to the PLATFORM_INGRESS_HOSTNAME env var, then empty string.
 *
 * The DB lookup is delegated to the caller to keep verification.ts free of
 * direct ORM imports (drizzle-orm is not available in the test environment).
 * Pass a pre-fetched `dbIngressBaseDomain` value; the function will fall back
 * to the env var if it is null/undefined.
 */
export async function getPlatformConfig(db: Database): Promise<PlatformConfig> {
  const nameserversEnv = process.env.PLATFORM_NAMESERVERS ?? '';
  const nameservers = nameserversEnv
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean);

  // DB-first for ingressHostname — delegate to ingress-routes service to avoid
  // direct drizzle-orm imports here.
  let ingressHostname = '';
  try {
    const { getIngressSettings } = await import('../ingress-routes/service.js');
    const settings = await getIngressSettings(db);
    ingressHostname = settings.ingressBaseDomain;
  } catch {
    // DB unavailable — fall through to env fallback
  }

  if (!ingressHostname) {
    ingressHostname = process.env.PLATFORM_INGRESS_HOSTNAME ?? '';
  }

  return { nameservers, ingressHostname };
}
