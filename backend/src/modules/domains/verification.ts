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
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];

  switch (dnsMode) {
    case 'primary': {
      const nsCheck = await verifyNsDelegation(domain, platformConfig.nameservers);
      checks.push(nsCheck);
      break;
    }
    case 'cname': {
      const cnameCheck = await verifyCnameRecord(domain, platformConfig.ingressHostname);
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

export function getPlatformConfig(): PlatformConfig {
  const nameserversEnv = process.env.PLATFORM_NAMESERVERS ?? '';
  const nameservers = nameserversEnv
    .split(',')
    .map((ns) => ns.trim())
    .filter(Boolean);

  const ingressHostname = process.env.PLATFORM_INGRESS_HOSTNAME ?? '';

  return { nameservers, ingressHostname };
}
