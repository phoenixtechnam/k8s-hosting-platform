import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileWebmailIngress, serviceNameForEngine } from './reconciler.js';
import type { Database } from '../../db/index.js';

vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailEngine: vi.fn(),
}));

import { getDefaultWebmailEngine } from '../webmail-settings/service.js';

function makeCustom(currentService: string | null) {
  const irBody = currentService === null
    ? { spec: { routes: [{ services: [] }] } }
    : { spec: { routes: [{ services: [{ name: currentService, port: 80 }] }] } };
  return {
    getNamespacedCustomObject: vi.fn().mockResolvedValue(irBody),
    patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  };
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const db = {} as unknown as Database;

describe('serviceNameForEngine', () => {
  it('maps roundcube → roundcube', () => {
    expect(serviceNameForEngine('roundcube')).toBe('roundcube');
  });
  it('maps bulwark → bulwark-impersonator', () => {
    expect(serviceNameForEngine('bulwark')).toBe('bulwark-impersonator');
  });
});

describe('reconcileWebmailIngress', () => {
  beforeEach(() => {
    vi.mocked(getDefaultWebmailEngine).mockReset();
  });

  it('patches the IR when engine=bulwark and current target is roundcube', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = makeCustom('roundcube');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toEqual({
      engine: 'bulwark',
      expectedService: 'bulwark-impersonator',
      previousService: 'roundcube',
      patched: true,
    });
    expect(custom.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const callArgs = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ services: Array<{ name: string; port: number }> }> } };
    };
    expect(callArgs.body.spec.routes[0].services[0].name).toBe('bulwark-impersonator');
    expect(callArgs.body.spec.routes[0].services[0].port).toBe(80);
  });

  it('no-ops when IR already targets the active engine', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = makeCustom('bulwark-impersonator');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toEqual({
      engine: 'bulwark',
      expectedService: 'bulwark-impersonator',
      previousService: 'bulwark-impersonator',
      patched: false,
    });
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('flips bulwark → roundcube symmetrically', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const custom = makeCustom('bulwark-impersonator');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result?.patched).toBe(true);
    expect(result?.expectedService).toBe('roundcube');
    const callArgs = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ services: Array<{ name: string }> }> } };
    };
    expect(callArgs.body.spec.routes[0].services[0].name).toBe('roundcube');
  });

  it('returns null when the IR does not exist (non-fatal)', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const custom = {
      getNamespacedCustomObject: vi.fn().mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      ),
      patchNamespacedCustomObject: vi.fn(),
    };
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toBeNull();
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('preserves existing route fields (e.g. middlewares) when patching', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        spec: {
          routes: [
            {
              match: 'Host(`webmail.example.com`)',
              kind: 'Rule',
              middlewares: [{ name: 'compress', namespace: 'traefik' }],
              services: [{ name: 'roundcube', port: 80 }],
            },
          ],
        },
      }),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    };
    const log = makeLog();

    await reconcileWebmailIngress(db, custom as never, log);

    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: {
        spec: {
          routes: Array<{
            match: string;
            middlewares: Array<{ name: string; namespace: string }>;
            services: Array<{ name: string }>;
          }>;
        };
      };
    };
    expect(body.body.spec.routes[0].match).toBe('Host(`webmail.example.com`)');
    expect(body.body.spec.routes[0].middlewares).toEqual([
      { name: 'compress', namespace: 'traefik' },
    ]);
    expect(body.body.spec.routes[0].services[0].name).toBe('bulwark-impersonator');
  });
});
