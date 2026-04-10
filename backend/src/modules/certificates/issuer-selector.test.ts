import { describe, it, expect } from 'vitest';
import { selectIssuerForDomain, type IssuerSelectorInput } from './issuer-selector.js';

describe('selectIssuerForDomain', () => {
  const defaults = {
    letsencryptProdHttp01: 'letsencrypt-prod-http01',
    letsencryptStagingHttp01: 'letsencrypt-staging-http01',
    dns01Issuers: {
      powerdns: 'letsencrypt-prod-dns01-powerdns',
      cloudflare: 'letsencrypt-prod-dns01-cloudflare',
      route53: 'letsencrypt-prod-dns01-route53',
      hetzner: 'letsencrypt-prod-dns01-hetzner',
      cloudns: 'letsencrypt-prod-dns01-cloudns',
    },
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

  it('chooses DNS-01 wildcard issuer for Cloudflare primary provider', () => {
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
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-cloudflare');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for Route53 primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'route53', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-route53');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for Hetzner primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'hetzner', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-hetzner');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('chooses DNS-01 wildcard issuer for ClouDNS primary provider', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'cloudns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: defaults,
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-cloudns');
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
  });

  it('falls back to HTTP-01 when wildcard requested but no DNS-01 provider present', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'rndc', enabled: 1, role: 'primary' },
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

  it('uses fallback issuer when provider type has no configured dns01 issuer', () => {
    const input: IssuerSelectorInput = {
      dnsMode: 'primary',
      activeServers: [
        { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
      ],
      wildcardRequested: true,
      environment: 'production',
      issuers: { ...defaults, dns01Issuers: {} },
    };
    const result = selectIssuerForDomain(input);
    expect(result.issuerName).toBe('letsencrypt-prod-http01'); // fallbackIssuer
    expect(result.challengeType).toBe('dns01');
    expect(result.wildcardCapable).toBe(true);
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
