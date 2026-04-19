import { describe, it, expect, vi } from 'vitest';
import { reconcileIngressHosts, extractHost } from './ingress-reconciler.js';
import type { IngressReconcileDeps } from './ingress-reconciler.js';

describe('extractHost', () => {
  it('extracts host from standard https URL', () => {
    expect(extractHost('https://admin.example.com')).toBe('admin.example.com');
  });
  it('extracts host from URL with port', () => {
    expect(extractHost('http://admin.k8s-platform.test:2010')).toBe('admin.k8s-platform.test');
  });
  it('extracts host from URL with path', () => {
    expect(extractHost('https://admin.example.com/panel')).toBe('admin.example.com');
  });
  it('normalizes uppercase hostnames to lowercase', () => {
    expect(extractHost('https://ADMIN.Example.COM')).toBe('admin.example.com');
  });
  it('returns null for empty string', () => {
    expect(extractHost('')).toBeNull();
  });
  it('returns null for null/undefined', () => {
    expect(extractHost(null)).toBeNull();
    expect(extractHost(undefined)).toBeNull();
  });
  it('returns null for malformed URL', () => {
    expect(extractHost('not-a-url')).toBeNull();
    expect(extractHost('://missing-scheme')).toBeNull();
  });
  it('rejects IPv4 literals (cert-manager cannot issue for bare IPs)', () => {
    expect(extractHost('https://192.168.1.1')).toBeNull();
    expect(extractHost('http://10.0.0.1:2010')).toBeNull();
  });
  it('rejects IPv6 literals', () => {
    expect(extractHost('https://[::1]')).toBeNull();
    expect(extractHost('https://[2001:db8::1]')).toBeNull();
  });
  it('rejects localhost and other single-label names', () => {
    expect(extractHost('https://localhost')).toBeNull();
    expect(extractHost('https://intranet')).toBeNull();
  });
  it('accepts nested subdomains', () => {
    expect(extractHost('https://a.b.c.example.com')).toBe('a.b.c.example.com');
  });
  it('rejects labels that start or end with a hyphen', () => {
    expect(extractHost('https://-invalid.example.com')).toBeNull();
    expect(extractHost('https://invalid-.example.com')).toBeNull();
  });
});

function mockDeps(currentSpec?: {
  rules: Array<{ host: string; serviceName: string }>;
  tlsHosts: string[];
  tlsSecret: string;
}): IngressReconcileDeps {
  return {
    readCurrent: vi.fn().mockResolvedValue(currentSpec ?? null),
    serverSideApply: vi.fn().mockResolvedValue(undefined),
  };
}

describe('reconcileIngressHosts', () => {
  it('applies fresh rules when both panel URLs are set and Ingress exists with different hosts', async () => {
    const deps = mockDeps({
      rules: [
        { host: 'old-admin.example.com', serviceName: 'admin-panel' },
        { host: 'old-client.example.com', serviceName: 'client-panel' },
      ],
      tlsHosts: ['old-admin.example.com', 'old-client.example.com'],
      tlsSecret: 'platform-tls',
    });
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.new.example.com',
      clientPanelUrl: 'https://my.new.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(true);
    expect(deps.serverSideApply).toHaveBeenCalledTimes(1);
    const applied = (deps.serverSideApply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(applied.spec.rules).toEqual([
      expect.objectContaining({ host: 'admin.new.example.com' }),
      expect.objectContaining({ host: 'my.new.example.com' }),
    ]);
    expect(applied.spec.tls[0].hosts).toEqual(['admin.new.example.com', 'my.new.example.com']);
    expect(applied.spec.tls[0].secretName).toBe('platform-tls');
  });

  it('is a no-op when desired hosts match the live Ingress', async () => {
    const deps = mockDeps({
      rules: [
        { host: 'admin.example.com', serviceName: 'admin-panel' },
        { host: 'my.example.com', serviceName: 'client-panel' },
      ],
      tlsHosts: ['admin.example.com', 'my.example.com'],
      tlsSecret: 'platform-tls',
    });
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      clientPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(false);
    expect(deps.serverSideApply).not.toHaveBeenCalled();
  });

  it('bootstraps the Ingress when it does not exist yet', async () => {
    const deps = mockDeps();
    const result = await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      clientPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(true);
    expect(deps.serverSideApply).toHaveBeenCalledTimes(1);
  });

  it('skips reconcile if neither URL is set — never produces an empty-rules Ingress', async () => {
    const deps = mockDeps({
      rules: [{ host: 'admin.example.com', serviceName: 'admin-panel' }],
      tlsHosts: ['admin.example.com'],
      tlsSecret: 'platform-tls',
    });
    const result = await reconcileIngressHosts({
      adminPanelUrl: null,
      clientPanelUrl: null,
      tlsSecretName: 'platform-tls',
    }, deps);
    expect(result.changed).toBe(false);
    expect(deps.serverSideApply).not.toHaveBeenCalled();
  });

  it('omits a rule (and its TLS host) if only one URL is set', async () => {
    const deps = mockDeps();
    await reconcileIngressHosts({
      adminPanelUrl: 'https://admin.example.com',
      clientPanelUrl: null,
      tlsSecretName: 'platform-tls',
    }, deps);
    const applied = (deps.serverSideApply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(applied.spec.rules).toHaveLength(1);
    expect(applied.spec.rules[0].host).toBe('admin.example.com');
    expect(applied.spec.tls[0].hosts).toEqual(['admin.example.com']);
  });

  it('ignores a malformed URL instead of producing a host-less rule', async () => {
    const deps = mockDeps();
    await reconcileIngressHosts({
      adminPanelUrl: 'not-a-url',
      clientPanelUrl: 'https://my.example.com',
      tlsSecretName: 'platform-tls',
    }, deps);
    const applied = (deps.serverSideApply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(applied.spec.rules).toHaveLength(1);
    expect(applied.spec.rules[0].host).toBe('my.example.com');
  });
});
