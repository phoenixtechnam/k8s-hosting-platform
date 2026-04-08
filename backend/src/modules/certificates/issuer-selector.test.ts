import { describe, it, expect } from 'vitest';
import { selectIssuerForDomain, type IssuerSelectorInput } from './issuer-selector.js';

describe('selectIssuerForDomain', () => {
  const defaults = {
    letsencryptProdHttp01: 'letsencrypt-prod-http01',
    letsencryptStagingHttp01: 'letsencrypt-staging-http01',
    letsencryptProdDns01Powerdns: 'letsencrypt-prod-dns01-powerdns',
    localCaIssuer: 'local-ca-issuer',
    fallbackIssuer: 'letsencrypt-prod-http01',
  };

  it('chooses DNS-01 wildcard issuer when primary PowerDNS + wildcard requested in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input)).toEqual({
      issuerName: 'letsencrypt-prod-dns01-powerdns',
      challengeType: 'dns01',
      wildcardCapable: true,
    });
  });

  it('chooses HTTP-01 prod issuer when dnsMode=cname in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'cname',
      activeServers: [],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input)).toEqual({
      issuerName: 'letsencrypt-prod-http01',
      challengeType: 'http01',
      wildcardCapable: false,
    });
  });

  it('chooses HTTP-01 prod issuer when dnsMode=secondary in production', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'secondary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });

  it('chooses staging HTTP-01 in staging environment', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'cname',
      activeServers: [],
      wildcardRequested: false,
      environment: 'staging',
      issuers: defaults,
    };
    expect(selectIssuerForDomain(input).issuerName).toBe('letsencrypt-staging-http01');
  });

  it('chooses local CA issuer in dev environment regardless of dnsMode', () => {
    const cases: Array<'primary' | 'cname' | 'secondary'> = ['primary', 'cname', 'secondary'];
    for (const mode of cases) {
      const result = selectIssuerForDomain({
        dnsMode: mode,
        activeServers: [],
        wildcardRequested: false,
        environment: 'development',
        issuers: defaults,
      });
      expect(result.issuerName).toBe('local-ca-issuer');
      expect(result.challengeType).toBe('ca');
    }
  });

  it('falls back to HTTP-01 when wildcard requested but PowerDNS absent', () => {
    // Customer is primary authority via Cloudflare (no DNS-01 solver wired
    // in Phase 2c) — wildcard cannot be issued, fall back to per-hostname.
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });

  it('returns wildcard=false when wildcardRequested=false even with PowerDNS primary', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: false,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    // Can use HTTP-01 for a single hostname — simpler than DNS-01 when no
    // wildcard is needed, and avoids nameserver round trips.
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.challengeType).toBe('http01');
    expect(result.wildcardCapable).toBe(false);
  });
});
