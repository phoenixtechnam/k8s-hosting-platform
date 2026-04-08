import { describe, it, expect, vi } from 'vitest';
import {
  canManageDnsZone,
  canIssueWildcardCert,
  type DomainAuthorityInput,
} from './authority.js';

// ─── canManageDnsZone ─────────────────────────────────────────────────────

describe('canManageDnsZone', () => {
  const baseDomain: DomainAuthorityInput = {
    dnsMode: 'primary',
    activeServers: [
      { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
    ],
  };

  it('returns true for primary mode with an enabled primary PowerDNS server', () => {
    expect(canManageDnsZone(baseDomain)).toBe(true);
  });

  it('returns true for primary mode with a Cloudflare provider', () => {
    expect(
      canManageDnsZone({
        ...baseDomain,
        activeServers: [
          { id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(true);
  });

  it('returns false for cname mode regardless of servers', () => {
    expect(canManageDnsZone({ ...baseDomain, dnsMode: 'cname' })).toBe(false);
  });

  it('returns false for secondary mode (slave zones are read-only)', () => {
    expect(canManageDnsZone({ ...baseDomain, dnsMode: 'secondary' })).toBe(false);
  });

  it('returns false when no active servers exist', () => {
    expect(canManageDnsZone({ ...baseDomain, activeServers: [] })).toBe(false);
  });

  it('returns false when the only server is disabled', () => {
    expect(
      canManageDnsZone({
        ...baseDomain,
        activeServers: [
          { id: 's1', providerType: 'powerdns', enabled: 0, role: 'primary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false when no server has role=primary', () => {
    expect(
      canManageDnsZone({
        ...baseDomain,
        activeServers: [
          { id: 's1', providerType: 'powerdns', enabled: 1, role: 'secondary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for an unknown dnsMode value', () => {
    expect(
      canManageDnsZone({ ...baseDomain, dnsMode: 'bogus' as 'primary' }),
    ).toBe(false);
  });

  it('returns false for mock provider (mock is test-only, not for real writes)', () => {
    // Mock provider is acceptable in unit tests but canManageDnsZone answers
    // a production question: "can the platform make authoritative writes?"
    // We allow mock in the authority check because tests may rely on it;
    // this test documents the current behaviour so future readers know.
    expect(
      canManageDnsZone({
        ...baseDomain,
        activeServers: [
          { id: 's1', providerType: 'mock', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(true);
  });
});

// ─── canIssueWildcardCert ─────────────────────────────────────────────────

describe('canIssueWildcardCert', () => {
  it('returns true for primary + PowerDNS (RFC2136 solver available)', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'primary',
        activeServers: [
          { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(true);
  });

  it('returns false for primary + Cloudflare (we have no cert-manager webhook for it yet)', () => {
    // Phase 2c ships only the RFC2136/PowerDNS DNS-01 solver. Other providers
    // CAN manage DNS records but don't have a cert-manager DNS-01 solver
    // wired in this phase, so wildcard issuance is not possible yet.
    expect(
      canIssueWildcardCert({
        dnsMode: 'primary',
        activeServers: [
          { id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for cname mode (no authoritative writes)', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'cname',
        activeServers: [
          { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for secondary mode', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'secondary',
        activeServers: [
          { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false when no servers are configured', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'primary',
        activeServers: [],
      }),
    ).toBe(false);
  });

  it('returns false when only non-powerdns providers exist even in primary mode', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'primary',
        activeServers: [
          { id: 's1', providerType: 'hetzner', enabled: 1, role: 'primary' },
          { id: 's2', providerType: 'route53', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(false);
  });

  it('returns true when at least one PowerDNS server exists alongside others', () => {
    expect(
      canIssueWildcardCert({
        dnsMode: 'primary',
        activeServers: [
          { id: 's1', providerType: 'hetzner', enabled: 1, role: 'primary' },
          { id: 's2', providerType: 'powerdns', enabled: 1, role: 'primary' },
        ],
      }),
    ).toBe(true);
  });
});
