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
 *     wildcardRequested=true AND primary + DNS-01-capable provider
 *                                  → letsencrypt-prod-dns01-<provider>
 *     everything else              → letsencrypt-prod-http01
 *
 * Wildcard certs are DNS-01 only (Let's Encrypt policy). Supported
 * DNS-01 solver providers: powerdns, cloudflare, route53, hetzner,
 * cloudns. The issuer is selected dynamically based on the domain's
 * primary DNS provider type.
 */

import {
  canIssueWildcardCert,
  DNS01_SOLVER_PROVIDERS,
  type DomainAuthorityInput,
  type DomainAuthorityServer,
} from '../dns-servers/authority.js';

export type CertEnvironment = 'development' | 'staging' | 'production';
export type ChallengeType = 'dns01' | 'http01' | 'ca';

export interface ConfiguredIssuers {
  readonly letsencryptProdHttp01: string;
  readonly letsencryptStagingHttp01: string;
  readonly dns01Issuers: Readonly<Record<string, string>>;
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
    const dns01Server = input.activeServers.find(
      (s) => s.enabled === 1 && s.role === 'primary' && DNS01_SOLVER_PROVIDERS.has(s.providerType),
    );
    const providerType = dns01Server?.providerType ?? 'powerdns';
    const issuerName = input.issuers.dns01Issuers[providerType] ?? input.issuers.fallbackIssuer;
    return {
      issuerName,
      challengeType: 'dns01' as ChallengeType,
      wildcardCapable: true,
    };
  }

  return {
    issuerName: input.issuers.letsencryptProdHttp01,
    challengeType: 'http01',
    wildcardCapable: false,
  };
}
