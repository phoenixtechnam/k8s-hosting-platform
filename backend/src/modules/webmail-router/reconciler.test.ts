import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reconcileWebmailIngress,
  reconcileBulwarkOrigin,
  serviceNameForEngine,
  originFromUrl,
} from './reconciler.js';
import type { Database } from '../../db/index.js';

vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailEngine: vi.fn(),
  getDefaultWebmailUrl: vi.fn(),
}));

vi.mock('../../shared/k8s-patch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/k8s-patch.js')>();
  return { ...actual, applyRaw: vi.fn().mockResolvedValue({}) };
});

import { getDefaultWebmailEngine, getDefaultWebmailUrl } from '../webmail-settings/service.js';
import { applyRaw } from '../../shared/k8s-patch.js';

function makeCustom(currentService: string | null, fluxAnnotated = true) {
  const metadata = fluxAnnotated
    ? { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } }
    : { annotations: {} };
  const irBody = currentService === null
    ? { metadata, spec: { routes: [{ services: [] }] } }
    : { metadata, spec: { routes: [{ services: [{ name: currentService, port: 80 }] }] } };
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

  it('re-patches when the Flux reconcile=disabled annotation is missing even if service matches', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    // Service already correct, but annotation missing — must re-patch
    // to lock the resource against Flux reconciliation.
    const custom = makeCustom('bulwark-impersonator', false);
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result?.patched).toBe(true);
    const body = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { metadata: { annotations: Record<string, string> } };
    };
    expect(body.body.metadata.annotations).toEqual({
      'kustomize.toolkit.fluxcd.io/reconcile': 'disabled',
    });
  });

  it('preserves existing route fields (e.g. middlewares) when patching', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: { annotations: { 'kustomize.toolkit.fluxcd.io/reconcile': 'disabled' } },
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

describe('originFromUrl', () => {
  it('strips path + trailing slash', () => {
    expect(originFromUrl('https://webmail.example.com/')).toBe('https://webmail.example.com');
    expect(originFromUrl('https://webmail.example.com/some/path')).toBe(
      'https://webmail.example.com',
    );
  });

  it('preserves explicit non-default ports', () => {
    expect(originFromUrl('https://webmail.example.com:8443/')).toBe(
      'https://webmail.example.com:8443',
    );
  });

  it('returns null for unparseable input', () => {
    expect(originFromUrl('not a url')).toBeNull();
    expect(originFromUrl('')).toBeNull();
    expect(originFromUrl(undefined)).toBeNull();
    expect(originFromUrl(null)).toBeNull();
  });
});

describe('reconcileBulwarkOrigin', () => {
  function makeApps(currentOrigin: string | null) {
    return {
      readNamespacedDeployment: vi.fn().mockResolvedValue({
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: 'impersonator',
                  env: currentOrigin
                    ? [{ name: 'PUBLIC_ORIGIN', value: currentOrigin }]
                    : [],
                },
              ],
            },
          },
        },
      }),
    };
  }
  const kc = {} as never;

  beforeEach(() => {
    vi.mocked(getDefaultWebmailUrl).mockReset();
    vi.mocked(applyRaw).mockReset();
    vi.mocked(applyRaw).mockResolvedValue({});
  });

  it('SSA-applies the new origin when the current value differs', async () => {
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://webmail.example.com/');
    const apps = makeApps('https://bulwark.example.com');
    const log = makeLog();

    const result = await reconcileBulwarkOrigin({} as Database, kc, apps as never, log);

    expect(result).toEqual({
      expectedOrigin: 'https://webmail.example.com',
      previousOrigin: 'https://bulwark.example.com',
      patched: true,
    });
    expect(applyRaw).toHaveBeenCalledOnce();
    const [, target, body, opts] = vi.mocked(applyRaw).mock.calls[0];
    expect(target.name).toBe('bulwark');
    expect(target.namespace).toBe('mail');
    expect(opts.fieldManager).toBe('platform-api-webmail-router');
    expect(opts.force).toBe(true);
    const typedBody = body as {
      spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } };
    };
    expect(typedBody.spec.template.spec.containers[0].env).toEqual([
      { name: 'PUBLIC_ORIGIN', value: 'https://webmail.example.com' },
    ]);
  });

  it('no-ops when the env already matches', async () => {
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://webmail.example.com');
    const apps = makeApps('https://webmail.example.com');
    const log = makeLog();

    const result = await reconcileBulwarkOrigin({} as Database, kc, apps as never, log);

    expect(result).toEqual({
      expectedOrigin: 'https://webmail.example.com',
      previousOrigin: 'https://webmail.example.com',
      patched: false,
    });
    expect(applyRaw).not.toHaveBeenCalled();
  });

  it('returns null when the webmail URL is unparseable (skips patch)', async () => {
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('garbage');
    const apps = makeApps('https://webmail.example.com');
    const log = makeLog();

    const result = await reconcileBulwarkOrigin({} as Database, kc, apps as never, log);

    expect(result).toBeNull();
    expect(applyRaw).not.toHaveBeenCalled();
  });

  it('returns null when Bulwark Deployment is missing (non-fatal)', async () => {
    vi.mocked(getDefaultWebmailUrl).mockResolvedValue('https://webmail.example.com');
    const apps = {
      readNamespacedDeployment: vi.fn().mockRejectedValue(
        Object.assign(new Error('not found'), { statusCode: 404 }),
      ),
    };
    const log = makeLog();

    const result = await reconcileBulwarkOrigin({} as Database, kc, apps as never, log);

    expect(result).toBeNull();
    expect(applyRaw).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
