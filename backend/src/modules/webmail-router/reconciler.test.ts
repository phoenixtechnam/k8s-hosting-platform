import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  reconcileWebmailIngress,
  reconcileEngineDeployments,
  serviceNameForEngine,
  WEBMAIL_ENGINE_DISABLED_ANNOTATION,
} from './reconciler.js';
import type { Database } from '../../db/index.js';

vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailEngine: vi.fn(),
}));

import { getDefaultWebmailEngine } from '../webmail-settings/service.js';

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
  it('maps bulwark → bulwark (upstream /api/auth/impersonate, no sidecar)', () => {
    expect(serviceNameForEngine('bulwark')).toBe('bulwark');
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
      expectedService: 'bulwark',
      previousService: 'roundcube',
      patched: true,
    });
    expect(custom.patchNamespacedCustomObject).toHaveBeenCalledOnce();
    const callArgs = custom.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { spec: { routes: Array<{ services: Array<{ name: string; port: number }> }> } };
    };
    expect(callArgs.body.spec.routes[0].services[0].name).toBe('bulwark');
    expect(callArgs.body.spec.routes[0].services[0].port).toBe(80);
  });

  it('no-ops when IR already targets the active engine', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const custom = makeCustom('bulwark');
    const log = makeLog();

    const result = await reconcileWebmailIngress(db, custom as never, log);

    expect(result).toEqual({
      engine: 'bulwark',
      expectedService: 'bulwark',
      previousService: 'bulwark',
      patched: false,
    });
    expect(custom.patchNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('flips bulwark → roundcube symmetrically', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const custom = makeCustom('bulwark');
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
    const custom = makeCustom('bulwark', false);
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
    expect(body.body.spec.routes[0].services[0].name).toBe('bulwark');
  });
});

describe('reconcileEngineDeployments', () => {
  function makeApps(opts: {
    activeName: string;
    activeReplicas?: number;
    activeAnnotated?: boolean;
    inactiveName: string;
    inactiveReplicas?: number;
    inactiveAnnotated?: boolean;
    activeMissing?: boolean;
    inactiveMissing?: boolean;
  }) {
    const readNs = vi.fn(({ name }: { name: string }) => {
      if (name === opts.activeName) {
        if (opts.activeMissing) {
          return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        }
        return Promise.resolve({
          metadata: {
            annotations: opts.activeAnnotated
              ? { [WEBMAIL_ENGINE_DISABLED_ANNOTATION]: 'true' }
              : {},
          },
          spec: { replicas: opts.activeReplicas ?? 1 },
        });
      }
      if (name === opts.inactiveName) {
        if (opts.inactiveMissing) {
          return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
        }
        return Promise.resolve({
          metadata: {
            annotations: opts.inactiveAnnotated
              ? { [WEBMAIL_ENGINE_DISABLED_ANNOTATION]: 'true' }
              : {},
          },
          spec: { replicas: opts.inactiveReplicas ?? 1 },
        });
      }
      return Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 }));
    });
    return {
      readNamespacedDeployment: readNs,
      replaceNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
      patchNamespacedDeployment: vi.fn().mockResolvedValue({}),
    };
  }

  beforeEach(() => {
    vi.mocked(getDefaultWebmailEngine).mockReset();
  });

  it('engine=roundcube: scales bulwark to 0 + annotates; leaves roundcube alone', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 1,
      activeAnnotated: false,
      inactiveName: 'bulwark',
      inactiveReplicas: 1,
      inactiveAnnotated: false,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.engine).toBe('roundcube');
    expect(result?.activeDeployment.name).toBe('roundcube');
    expect(result?.inactiveDeployment.name).toBe('bulwark');
    expect(result?.activeAnnotationCleared).toBe(false); // wasn't annotated
    expect(result?.inactiveScaledToZero).toBe(true);
    expect(result?.inactiveAnnotated).toBe(true);
    expect(apps.replaceNamespacedDeploymentScale).toHaveBeenCalledOnce();
    const scaleCall = apps.replaceNamespacedDeploymentScale.mock.calls[0][0] as {
      name: string;
      body: { spec: { replicas: number } };
    };
    expect(scaleCall.name).toBe('bulwark');
    expect(scaleCall.body.spec.replicas).toBe(0);
  });

  it('engine=bulwark: scales roundcube to 0 + annotates; leaves bulwark alone', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('bulwark');
    const apps = makeApps({
      activeName: 'bulwark',
      activeReplicas: 1,
      inactiveName: 'roundcube',
      inactiveReplicas: 1,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.engine).toBe('bulwark');
    expect(result?.activeDeployment.name).toBe('bulwark');
    expect(result?.inactiveDeployment.name).toBe('roundcube');
    const scaleCall = apps.replaceNamespacedDeploymentScale.mock.calls[0][0] as {
      name: string;
    };
    expect(scaleCall.name).toBe('roundcube');
  });

  it('clears the disabled annotation from the active engine on engine flip', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 0, // was inactive previously
      activeAnnotated: true, // ← carries the annotation from the prior flip
      inactiveName: 'bulwark',
      inactiveReplicas: 1,
      inactiveAnnotated: false,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.activeAnnotationCleared).toBe(true);
    // The JSON-patch must be a remove operation for the annotation key.
    const patchCalls = apps.patchNamespacedDeployment.mock.calls;
    const removeCall = patchCalls.find((c: unknown[]) => {
      const arg = c[0] as { name: string; body: ReadonlyArray<{ op: string }> | unknown };
      return arg.name === 'roundcube' && Array.isArray(arg.body) && arg.body[0]?.op === 'remove';
    });
    expect(removeCall).toBeDefined();
  });

  it('skips scaling when inactive Deployment is missing (404 is non-fatal)', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      inactiveName: 'bulwark',
      inactiveMissing: true,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.inactiveScaledToZero).toBe(false);
    expect(result?.inactiveAnnotated).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('no-ops when inactive is already scaled to 0 + annotated', async () => {
    vi.mocked(getDefaultWebmailEngine).mockResolvedValue('roundcube');
    const apps = makeApps({
      activeName: 'roundcube',
      activeReplicas: 1,
      activeAnnotated: false,
      inactiveName: 'bulwark',
      inactiveReplicas: 0,
      inactiveAnnotated: true,
    });
    const log = makeLog();

    const result = await reconcileEngineDeployments({} as Database, apps as never, log);

    expect(result?.inactiveScaledToZero).toBe(false);
    expect(result?.inactiveAnnotated).toBe(false);
    expect(apps.replaceNamespacedDeploymentScale).not.toHaveBeenCalled();
    expect(apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });
});
