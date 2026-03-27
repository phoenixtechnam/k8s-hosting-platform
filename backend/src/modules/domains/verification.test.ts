import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyNsDelegation, verifyCnameRecord, verifyDomain } from './verification.js';

// Mock dns.promises
vi.mock('node:dns/promises', () => ({
  default: {
    resolveNs: vi.fn(),
    resolveCname: vi.fn(),
  },
}));

// Mock dns-servers service (for secondary/AXFR checks)
vi.mock('../dns-servers/service.js', () => ({
  getActiveServers: vi.fn().mockResolvedValue([]),
  getProviderForServer: vi.fn(),
}));

import dns from 'node:dns/promises';
import { getActiveServers, getProviderForServer } from '../dns-servers/service.js';

const mockResolveNs = vi.mocked(dns.resolveNs);
const mockResolveCname = vi.mocked(dns.resolveCname);
const mockGetActiveServers = vi.mocked(getActiveServers);
const mockGetProviderForServer = vi.mocked(getProviderForServer);

const mockDb = {} as Parameters<typeof verifyDomain>[3];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyNsDelegation', () => {
  it('should pass when expected nameservers are present', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com', 'ns2.platform.com']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('pass');
    expect(result.type).toBe('ns_delegation');
  });

  it('should pass with trailing dots normalized', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com.', 'ns2.platform.com.']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('pass');
  });

  it('should fail when expected nameservers are missing', async () => {
    mockResolveNs.mockResolvedValue(['ns1.other.com', 'ns2.other.com']);

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com', 'ns2.platform.com']);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Expected NS');
  });

  it('should fail gracefully on DNS timeout/error', async () => {
    mockResolveNs.mockRejectedValue(new Error('ETIMEOUT'));

    const result = await verifyNsDelegation('example.com', ['ns1.platform.com']);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('NS lookup failed');
    expect(result.detail).toContain('ETIMEOUT');
  });
});

describe('verifyCnameRecord', () => {
  it('should pass when CNAME points to expected target', async () => {
    mockResolveCname.mockResolvedValue(['ingress.platform.com']);

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('pass');
    expect(result.type).toBe('cname_record');
  });

  it('should fail when CNAME points elsewhere', async () => {
    mockResolveCname.mockResolvedValue(['other.host.com']);

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Expected CNAME target');
  });

  it('should fail gracefully on DNS timeout/error', async () => {
    mockResolveCname.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await verifyCnameRecord('example.com', 'ingress.platform.com');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('CNAME lookup failed');
    expect(result.detail).toContain('ENOTFOUND');
  });
});

describe('verifyDomain', () => {
  const platformConfig = {
    nameservers: ['ns1.platform.com', 'ns2.platform.com'],
    ingressHostname: 'ingress.platform.com',
  };

  it('should dispatch NS check for primary mode', async () => {
    mockResolveNs.mockResolvedValue(['ns1.platform.com', 'ns2.platform.com']);

    const result = await verifyDomain('example.com', 'primary', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('ns_delegation');
  });

  it('should dispatch CNAME check for cname mode', async () => {
    mockResolveCname.mockResolvedValue(['ingress.platform.com']);

    const result = await verifyDomain('example.com', 'cname', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('cname_record');
  });

  it('should dispatch AXFR check for secondary mode', async () => {
    const mockProvider = {
      getZoneAxfrStatus: vi.fn().mockResolvedValue({ synced: true, lastSoaSerial: 2024010101 }),
    };
    mockGetActiveServers.mockResolvedValue([{ id: 's1' }] as Awaited<ReturnType<typeof getActiveServers>>);
    mockGetProviderForServer.mockReturnValue(mockProvider as unknown as ReturnType<typeof getProviderForServer>);

    const result = await verifyDomain('example.com', 'secondary', platformConfig, mockDb);
    expect(result.verified).toBe(true);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].type).toBe('axfr_sync');
  });

  it('should return verified=false when check fails', async () => {
    mockResolveNs.mockResolvedValue(['ns1.other.com']);

    const result = await verifyDomain('example.com', 'primary', platformConfig, mockDb);
    expect(result.verified).toBe(false);
  });

  it('should return verified=false for secondary when no servers available', async () => {
    mockGetActiveServers.mockResolvedValue([]);

    const result = await verifyDomain('example.com', 'secondary', platformConfig, mockDb);
    expect(result.verified).toBe(false);
    expect(result.checks[0].type).toBe('axfr_sync');
  });
});
