/**
 * DNS authority / capability helpers.
 *
 * Answers two related questions that are used across the DNS, email
 * provisioning, and certificate modules:
 *
 *   canManageDnsZone(domain)      — "Can the platform create/update/delete
 *                                    DNS records in this domain's zone?"
 *   canIssueWildcardCert(domain)  — "Can we issue a wildcard ACME cert for
 *                                    this domain via DNS-01?"
 *
 * These were previously ad-hoc checks scattered across dns-records,
 * email-domains/dns-provisioning, and ssl-certs/cert-manager, some of
 * which silently accepted writes on unsupported domains and logged a
 * warning. Phase 2c consolidates the logic so callers can short-circuit
 * cleanly and the reasoning is testable.
 *
 * Pure functions — no DB access. Call sites pass in the resolved
 * domain fields and the list of active servers from
 * getActiveServersForDomain().
 */

export type ProviderType =
  | 'powerdns'
  | 'rndc'
  | 'cloudflare'
  | 'route53'
  | 'hetzner'
  | 'mock';

export interface DomainAuthorityServer {
  readonly id: string;
  readonly providerType: ProviderType | string;
  readonly enabled: number;
  readonly role: 'primary' | 'secondary' | string;
}

export interface DomainAuthorityInput {
  readonly dnsMode: 'primary' | 'cname' | 'secondary';
  readonly activeServers: readonly DomainAuthorityServer[];
}

/**
 * Returns true iff the platform can authoritatively create, update, and
 * delete DNS records in the zone for this domain.
 *
 * Requirements:
 *   - dnsMode === 'primary' (only primary mode means the platform owns
 *     the zone; secondary zones are read-only AXFR replicas, cname mode
 *     leaves DNS to the customer's own provider)
 *   - At least one ENABLED server with role=primary exists in the
 *     domain's assigned DNS provider group
 *
 * The provider type itself doesn't affect authority — if the platform
 * has an enabled primary provider of any supported type, it has write
 * access. Wildcard cert issuance has a stricter requirement (see below).
 */
export function canManageDnsZone(input: DomainAuthorityInput): boolean {
  if (input.dnsMode !== 'primary') return false;
  return input.activeServers.some(
    (s) => s.enabled === 1 && s.role === 'primary',
  );
}

/**
 * Returns true iff the platform can issue a wildcard ACME certificate
 * (e.g. `*.customer.com`) for this domain via DNS-01.
 *
 * Requirements:
 *   - canManageDnsZone(domain) === true
 *   - At least one active primary server uses a provider type for
 *     which cert-manager has a DNS-01 solver configured.
 *
 * Phase 2c ships only the RFC2136 solver targeting PowerDNS (see
 * k8s/base/cert-manager/clusterissuer-letsencrypt-dns01-powerdns.yaml).
 * Cloudflare, Route53, and Hetzner all have off-the-shelf cert-manager
 * solvers that could be added in a later phase — just update this
 * allowlist and provision the matching ClusterIssuer + Secret.
 */
const DNS01_SOLVER_PROVIDERS: ReadonlySet<string> = new Set([
  'powerdns',
]);

export function canIssueWildcardCert(input: DomainAuthorityInput): boolean {
  if (!canManageDnsZone(input)) return false;
  return input.activeServers.some(
    (s) =>
      s.enabled === 1 &&
      s.role === 'primary' &&
      DNS01_SOLVER_PROVIDERS.has(s.providerType),
  );
}
