import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeUrlHealth, type UrlHealthDeps } from './url-health.js';

/**
 * Tests the pure probe function against mocked DNS + k8s deps. The real
 * resolvers land in the default-deps factory, which the route passes in.
 */

function mockDeps(overrides: Partial<UrlHealthDeps> = {}): UrlHealthDeps {
  return {
    resolveDns: vi.fn().mockResolvedValue({ status: 'resolved', addresses: ['1.2.3.4'] }),
    readCertificate: vi.fn().mockResolvedValue({
      status: 'ready',
      reason: null,
      notAfter: '2026-07-01T00:00:00Z',
      secretName: 'platform-dev-tls',
    }),
    now: () => new Date('2026-04-20T00:00:00Z'),
    ...overrides,
  };
}

describe('probeUrlHealth', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns resolved DNS + ready SSL when everything is happy', async () => {
    const deps = mockDeps();
    const result = await probeUrlHealth({
      host: 'admin.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.dns.status).toBe('resolved');
    expect(result.dns.addresses).toEqual(['1.2.3.4']);
    expect(result.ssl.status).toBe('ready');
    expect(result.ssl.notAfter).toBe('2026-07-01T00:00:00Z');
    expect(result.host).toBe('admin.example.com');
  });

  it('reports DNS unresolved when the resolver says so', async () => {
    const deps = mockDeps({
      resolveDns: vi.fn().mockResolvedValue({ status: 'unresolved', addresses: [] }),
    });
    const result = await probeUrlHealth({
      host: 'nonexistent.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.dns.status).toBe('unresolved');
    expect(result.dns.reason).toMatch(/(no records|nxdomain|not found)/i);
  });

  it('reports SSL pending when cert-manager is still issuing', async () => {
    const deps = mockDeps({
      readCertificate: vi.fn().mockResolvedValue({
        status: 'pending',
        reason: 'Order created',
        notAfter: null,
        secretName: 'platform-tls',
      }),
    });
    const result = await probeUrlHealth({
      host: 'admin.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.ssl.status).toBe('pending');
    expect(result.ssl.reason).toBe('Order created');
  });

  it('reports SSL failed with reason', async () => {
    const deps = mockDeps({
      readCertificate: vi.fn().mockResolvedValue({
        status: 'failed',
        reason: 'HTTP-01 challenge failed: NXDOMAIN',
        notAfter: null,
        secretName: 'platform-tls',
      }),
    });
    const result = await probeUrlHealth({
      host: 'admin.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.ssl.status).toBe('failed');
    expect(result.ssl.reason).toContain('NXDOMAIN');
  });

  it('reports SSL missing when no Certificate resource exists', async () => {
    const deps = mockDeps({
      readCertificate: vi.fn().mockResolvedValue(null),
    });
    const result = await probeUrlHealth({
      host: 'admin.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.ssl.status).toBe('missing');
  });

  it('flags an SSL cert that is within 30 days of expiry', async () => {
    const deps = mockDeps({
      now: () => new Date('2026-06-15T00:00:00Z'),
      readCertificate: vi.fn().mockResolvedValue({
        status: 'ready',
        reason: null,
        notAfter: '2026-07-01T00:00:00Z', // 16 days from now
        secretName: 'platform-tls',
      }),
    });
    const result = await probeUrlHealth({
      host: 'admin.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    // Still "ready" (not failed) but daysUntilExpiry surfaced
    expect(result.ssl.status).toBe('ready');
    expect(result.ssl.daysUntilExpiry).toBe(16);
    expect(result.ssl.expiringSoon).toBe(true);
  });

  it('skips probes entirely when the URL is unset (host = null)', async () => {
    const deps = mockDeps();
    const result = await probeUrlHealth({
      host: null,
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.dns.status).toBe('not-configured');
    expect(result.ssl.status).toBe('not-configured');
    expect(deps.resolveDns).not.toHaveBeenCalled();
    expect(deps.readCertificate).not.toHaveBeenCalled();
  });

  it('surfaces a DNS timeout distinctly from NXDOMAIN', async () => {
    const deps = mockDeps({
      resolveDns: vi.fn().mockResolvedValue({ status: 'timeout', addresses: [], reason: 'DNS lookup timed out after 3s' }),
    });
    const result = await probeUrlHealth({
      host: 'slow.example.com',
      certSecretName: 'platform-tls',
      certNamespace: 'platform',
    }, deps);
    expect(result.dns.status).toBe('timeout');
    expect(result.dns.reason).toMatch(/timed? out/i);
  });
});
