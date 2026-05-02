import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted spies so vi.mock factories can reference them.
const { activeServersSpy, providerSpy, deleteZoneSpy } = vi.hoisted(() => ({
  activeServersSpy: vi.fn(),
  providerSpy: vi.fn(),
  deleteZoneSpy: vi.fn(async (_name: string) => undefined),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

vi.mock('../../dns-servers/service.js', () => ({
  getActiveServersForDomain: activeServersSpy,
  getProviderForServer: providerSpy,
}));

import { dnsZoneCleanupHook } from './dns-zone-cleanup.js';
import type { HookCtx } from '../registry/index.js';

function makeCtx(domains: Array<{ id: string; domainName: string }>): HookCtx {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => domains,
        }),
      }),
    } as never,
    k8s: {} as never,
    clientId: 'c1',
    namespace: 'client-test',
    transitionId: 't1',
    transition: 'deleted',
    attempt: 1,
  };
}

describe('dns-zone-cleanup hook', () => {
  beforeEach(() => {
    activeServersSpy.mockReset();
    providerSpy.mockReset();
    deleteZoneSpy.mockReset().mockResolvedValue(undefined);
    providerSpy.mockReturnValue({ deleteZone: deleteZoneSpy });
  });

  it('noop on non-deleted transitions', async () => {
    const ctx = { ...makeCtx([]), transition: 'suspended' as const };
    const r = await dnsZoneCleanupHook.run(ctx);
    expect(r.status).toBe('noop');
    expect(deleteZoneSpy).not.toHaveBeenCalled();
  });

  it('noop when client has no domains', async () => {
    activeServersSpy.mockResolvedValue([]);
    const r = await dnsZoneCleanupHook.run(makeCtx([]));
    expect(r.status).toBe('noop');
    expect(deleteZoneSpy).not.toHaveBeenCalled();
  });

  it('deletes the zone on every active server for every domain', async () => {
    activeServersSpy.mockImplementation(async (_db: unknown, _domainId: string) => [
      { id: 'srv-a', displayName: 'Primary PowerDNS' },
      { id: 'srv-b', displayName: 'Secondary PowerDNS' },
    ]);
    const r = await dnsZoneCleanupHook.run(makeCtx([
      { id: 'd1', domainName: 'example.com' },
      { id: 'd2', domainName: 'foo.test' },
    ]));
    expect(r.status).toBe('ok');
    expect(deleteZoneSpy).toHaveBeenCalledTimes(4); // 2 domains × 2 servers
    expect(deleteZoneSpy).toHaveBeenCalledWith('example.com');
    expect(deleteZoneSpy).toHaveBeenCalledWith('foo.test');
  });

  it('returns retry envelope when one server fails', async () => {
    activeServersSpy.mockResolvedValue([
      { id: 'srv-a', displayName: 'PowerDNS' },
    ]);
    deleteZoneSpy.mockRejectedValueOnce(new Error('CLOUDFLARE_RATE_LIMIT'));
    const r = await dnsZoneCleanupHook.run(makeCtx([
      { id: 'd1', domainName: 'example.com' },
    ]));
    expect(r.status).toBe('retry');
    expect(r.envelope?.title).toBe('DNS zone cleanup partial');
    expect(r.envelope?.raw).toContain('CLOUDFLARE_RATE_LIMIT');
  });

  it('mixed success: domain A clean, domain B fails — partial retry envelope', async () => {
    activeServersSpy.mockResolvedValue([{ id: 'srv-a', displayName: 'PowerDNS' }]);
    // First domain clean, second domain's deleteZone throws.
    deleteZoneSpy.mockImplementation(async (name: string) => {
      if (name === 'flaky.example') throw new Error('PROVIDER_5XX');
    });
    const r = await dnsZoneCleanupHook.run(makeCtx([
      { id: 'd-clean', domainName: 'clean.example' },
      { id: 'd-flaky', domainName: 'flaky.example' },
    ]));
    expect(r.status).toBe('retry');
    expect(r.detail).toContain('1 zone(s) deleted; 1 failure(s)');
    expect(r.envelope?.raw).toContain('flaky.example');
    expect(r.envelope?.raw).not.toContain('clean.example');
  });

  it('continues to other domains if active-server lookup fails for one', async () => {
    activeServersSpy.mockImplementation(async (_db: unknown, domainId: string) => {
      if (domainId === 'd-bad') throw new Error('bad-domain');
      return [{ id: 'srv-ok', displayName: 'PowerDNS' }];
    });
    const r = await dnsZoneCleanupHook.run(makeCtx([
      { id: 'd-bad', domainName: 'bad.example' },
      { id: 'd-good', domainName: 'good.example' },
    ]));
    expect(r.status).toBe('retry');
    expect(deleteZoneSpy).toHaveBeenCalledTimes(1);
    expect(deleteZoneSpy).toHaveBeenCalledWith('good.example');
    expect(r.envelope?.raw).toContain('bad.example');
  });
});
