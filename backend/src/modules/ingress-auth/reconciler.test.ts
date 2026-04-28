import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./service.js', () => ({
  decryptClientSecret: vi.fn(() => 'plaintext-secret'),
  getOrCreateClientCookieSecret: vi.fn().mockResolvedValue('cookie-secret-32-bytes-long-fake_'),
}));

import { reconcileClient } from './reconciler.js';

const CLIENT_ID = 'c-1';
const NAMESPACE = 'client-c1';

const ENABLED_ROW = {
  id: 'cfg-1',
  ingressRouteId: 'ir-1',
  hostname: 'app.example.com',
  enabled: true,
  issuerUrl: 'https://idp.example.com/',
  clientId: 'oauth-client-id',
  clientSecretEncrypted: 'enc:secret',
  authMethod: 'client_secret_basic',
  responseType: 'code',
  usePkce: true,
  scopes: 'openid profile email',
  allowedEmails: null,
  allowedEmailDomains: null,
  allowedGroups: null,
  claimRules: [{ claim: 'membership', operator: 'contains', value: 'paid' }],
  passAuthorizationHeader: true,
  passAccessToken: true,
  passIdToken: true,
  passUserHeaders: true,
  setXauthrequest: true,
  cookieDomain: null,
  cookieRefreshSeconds: 3600,
  cookieExpireSeconds: 86400,
  lastError: null,
  lastReconciledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeMocks(opts: {
  enabled: ReadonlyArray<typeof ENABLED_ROW>;
  proxyState?: { provisioned: boolean } | null;
  deploymentExists?: boolean;
  serviceExists?: boolean;
  configMapExists?: boolean;
  secretExists?: boolean;
}) {
  const calls: Record<string, Array<unknown>> = {
    create: [],
    replace: [],
    delete: [],
    read: [],
  };

  // Drizzle DB. Return canned shapes per call:
  //   1. clients select → namespace
  //   2. ingressAuthConfigs join → enabled list
  //   3. clientOauth2ProxyState → existing state
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => {
      selectCalls += 1;
      const idx = selectCalls;
      return {
        from: vi.fn(() => {
          const chain = {
            where: vi.fn().mockResolvedValue(
              idx === 1
                ? [{ ns: NAMESPACE }]
                : opts.proxyState === null
                  ? []
                  : [opts.proxyState],
            ),
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(
                  opts.enabled.map((r) => ({ cfg: r, hostname: r.hostname })),
                ),
              }),
            }),
          };
          return chain;
        }),
      };
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  } as never;

  const notFound = (): Error => {
    const e = new Error('HTTP-Code: 404 Message: Not Found');
    (e as { statusCode?: number }).statusCode = 404;
    return e;
  };

  const core = {
    readNamespacedService: vi.fn(async () => {
      calls.read.push({ kind: 'service' });
      if (opts.serviceExists) {
        return { spec: { clusterIP: '10.43.1.2' }, metadata: { resourceVersion: '1' } };
      }
      throw notFound();
    }),
    replaceNamespacedConfigMap: vi.fn(async (args: unknown) => {
      if (!opts.configMapExists) throw notFound();
      calls.replace.push({ kind: 'configmap', args });
    }),
    createNamespacedConfigMap: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'configmap', args });
    }),
    replaceNamespacedSecret: vi.fn(async (args: unknown) => {
      if (!opts.secretExists) throw notFound();
      calls.replace.push({ kind: 'secret', args });
    }),
    createNamespacedSecret: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'secret', args });
    }),
    replaceNamespacedService: vi.fn(async (args: unknown) => {
      calls.replace.push({ kind: 'service', args });
    }),
    createNamespacedService: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'service', args });
    }),
    deleteNamespacedConfigMap: vi.fn(async () => calls.delete.push({ kind: 'configmap' })),
    deleteNamespacedSecret: vi.fn(async () => calls.delete.push({ kind: 'secret' })),
    deleteNamespacedService: vi.fn(async () => calls.delete.push({ kind: 'service' })),
  };

  const apps = {
    readNamespacedDeployment: vi.fn(async () => {
      calls.read.push({ kind: 'deployment' });
      if (opts.deploymentExists) {
        return { metadata: { resourceVersion: '7' } };
      }
      throw notFound();
    }),
    replaceNamespacedDeployment: vi.fn(async (args: unknown) => {
      calls.replace.push({ kind: 'deployment', args });
    }),
    createNamespacedDeployment: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'deployment', args });
    }),
    deleteNamespacedDeployment: vi.fn(async () => calls.delete.push({ kind: 'deployment' })),
  };

  const networking = {} as never;

  return { db, k8s: { core, apps, networking }, calls } as never;
}

describe('reconcileClient — provisioning path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates ConfigMap, Secret, Service, Deployment on first enable', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    const result = await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('provisioned');
    expect(result.error).toBeNull();
    expect(result.enabledIngresses).toBe(1);
    // 4 creates expected: configmap, secret, service, deployment
    const creates = (m.calls.create as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(creates).toEqual(['configmap', 'deployment', 'secret', 'service']);
  });

  it('updates resources when proxy already provisioned', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: true },
      deploymentExists: true,
      serviceExists: true,
      configMapExists: true,
      secretExists: true,
    });
    const result = await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('updated');
    const replaces = (m.calls.replace as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(replaces).toEqual(['configmap', 'deployment', 'secret', 'service']);
  });

  it('serialises claim_rules into the rules.json ConfigMap key', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const cm = (m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>).find(
      (c) => c.kind === 'configmap',
    )!;
    expect(cm.args.body.data['rules.json']).toContain('"membership"');
    expect(cm.args.body.data['rules.json']).toContain('"contains"');
  });

  it('serialises oauth2_proxy.cfg with PKCE + identity flags', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const cm = (m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>).find(
      (c) => c.kind === 'configmap',
    )!;
    const cfg = cm.args.body.data['oauth2_proxy.cfg']!;
    expect(cfg).toContain('code_challenge_method="S256"');
    expect(cfg).toContain('pass_authorization_header="true"');
    expect(cfg).toContain('set_xauthrequest="true"');
    expect(cfg).toContain('client_id="oauth-client-id"');
    expect(cfg).toContain('client_secret="plaintext-secret"');
  });
});

describe('reconcileClient — teardown path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes resources when no enabled ingress remains', async () => {
    const m = makeMocks({
      enabled: [],
      proxyState: { provisioned: true },
    });
    const result = await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('torn_down');
    const deletes = (m.calls.delete as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(deletes).toEqual(['configmap', 'deployment', 'secret', 'service']);
  });

  it('is a noop when nothing was provisioned and no enabled rows exist', async () => {
    const m = makeMocks({
      enabled: [],
      proxyState: { provisioned: false },
    });
    const result = await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('noop');
    expect(m.calls.delete).toEqual([]);
  });
});
