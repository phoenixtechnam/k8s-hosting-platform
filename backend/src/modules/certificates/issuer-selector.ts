/**
 * Certificate ClusterIssuer selection.
 *
 * Given a domain's DNS state (mode, providers, whether a wildcard is
 * wanted) and the runtime environment, picks which cert-manager
 * ClusterIssuer should sign the certificate. Pure function — no DB,
 * no k8s calls. Callers resolve the inputs and pass them in.
 *
 * Selection matrix (summary):
 *
 *   environment=development        → local-ca-issuer            (no ACME)
 *   environment=staging            → letsencrypt-staging-http01
 *   environment=production:
 *     wildcardRequested=true AND primary+PowerDNS
 *                                  → letsencrypt-prod-dns01-powerdns
 *     everything else              → letsencrypt-prod-http01
 *
 * Wildcard certs are DNS-01 only (Let's Encrypt policy), and Phase 2c
 * only ships the RFC2136/PowerDNS solver. If a customer is primary
 * authority via Cloudflare/Route53/Hetzner, wildcard issuance isn't
 * possible yet and we fall back to per-hostname HTTP-01.
 */

import {
  canIssueWildcardCert,
  type DomainAuthorityInput,
  type DomainAuthorityServer,
} from '../dns-servers/authority.js';

export type CertEnvironment = 'development' | 'staging' | 'production';
export type ChallengeType = 'dns01' | 'http01' | 'ca';

export interface ConfiguredIssuers {
  readonly letsencryptProdHttp01: string;
  readonly letsencryptStagingHttp01: string;
  readonly letsencryptProdDns01Powerdns: string;
  readonly localCaIssuer: string;
  readonly fallbackIssuer: string;
}

export interface IssuerSelectorInput {
  readonly dnsMode: 'primary' | 'cname' | 'secondary';
  readonly activeServers: readonly DomainAuthorityServer[];
  readonly wildcardRequested: boolean;
  readonly environment: CertEnvironment;
  readonly issuers: ConfiguredIssuers;
}

export interface IssuerSelection {
  readonly issuerName: string;
  readonly challengeType: ChallengeType;
  readonly wildcardCapable: boolean;
}

export function selectIssuerForDomain(input: IssuerSelectorInput): IssuerSelection {
  if (input.environment === 'development') {
    return {
      issuerName: input.issuers.localCaIssuer,
      challengeType: 'ca',
      wildcardCapable: true, // local CA can sign wildcards, we just don't
                             // exercise that path for dev cert names
    };
  }

  if (input.environment === 'staging') {
    return {
      issuerName: input.issuers.letsencryptStagingHttp01,
      challengeType: 'http01',
      wildcardCapable: false,
    };
  }

  // production
  const authorityInput: DomainAuthorityInput = {
    dnsMode: input.dnsMode,
    activeServers: input.activeServers,
  };

  if (input.wildcardRequested && canIssueWildcardCert(authorityInput)) {
    return {
      issuerName: input.issuers.letsencryptProdDns01Powerdns,
      challengeType: 'dns01',
      wildcardCapable: true,
    };
  }

  return {
    issuerName: input.issuers.letsencryptProdHttp01,
    challengeType: 'http01',
    wildcardCapable: false,
  };
}
