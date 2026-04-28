import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers-service.js', () => ({
  decryptProviderSecret: vi.fn(() => 'plaintext-secret'),
}));
vi.mock('./service.js', () => ({
  getOrCreateClientCookieSecret: vi.fn().mockResolvedValue('cookie-secret-32-bytes-long-fake_'),
  listEnabledForClient: vi.fn(),
}));

import { reconcileClient } from './reconciler.js';
import { listEnabledForClient } from './service.js';

const listEnabledMock = listEnabledForClient as unknown as ReturnType<typeof vi.fn>;

const CLIENT_ID = 'c-1';
const NAMESPACE = 'client-c1';

const ENABLED_ROW = {
  cfg: {
    id: 'cfg-1',
    ingressRouteId: 'ir-1',
    enabled: true,
    providerId: 'p-1',
    scopesOverride: null,
    postLoginRedirectUrl: null,
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
  },
  provider: {
    id: 'p-1',
    clientId: CLIENT_ID,
    name: 'Test provider',
    issuerUrl: 'https://idp.example.com/',
    oauthClientId: 'oauth-client-id',
    oauthClientSecretEncrypted: 'enc:secret',
    authMethod: 'client_secret_basic',
    responseType: 'code',
    usePkce: true,
    defaultScopes: 'openid profile email',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  hostname: 'app.example.com',
};

function makeMocks(opts: {
  enabled: ReadonlyArray<typeof ENABLED_ROW>;
  proxyState?: { provisioned: boolean } | null;
  deploymentExists?: boolean;
  serviceExists?: boolean;
  configMapExists?: boolean;
  secretExists?: boolean;
  passthroughIngressExists?: boolean;
  /** Tenant Ingress TLS entries: `secretName → [hosts]`. Missing → tenant 404. */
  tenantTls?: Record<string, string[]>;
}) {
  const calls: Record<string, Array<unknown>> = {
    create: [],
    replace: [],
    delete: [],
    read: [],
  };

  // Mocked listEnabledForClient → return canned set.
  listEnabledMock.mockResolvedValue(opts.enabled);

  // Drizzle DB. Sequence:
  //   1. clients select → namespace
  //   2. clientOauth2ProxyState (only on teardown path)
  let selectCalls = 0;
  const db = {
    select: vi.fn(() => {
      selectCalls += 1;
      const idx = selectCalls;
      return {
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(
            idx === 1
              ? [{ ns: NAMESPACE }]
              : opts.proxyState === null
                ? []
                : [opts.proxyState],
          ),
        })),
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

  const networking = {
    readNamespacedIngress: vi.fn(async (args: { name: string }) => {
      calls.read.push({ kind: 'ingress', name: args.name });
      // Tenant Ingress lookup for TLS secrets.
      if (args.name === `${NAMESPACE}-ingress`) {
        if (!opts.tenantTls) throw notFound();
        return {
          spec: {
            tls: Object.entries(opts.tenantTls).map(([secretName, hosts]) => ({
              secretName,
              hosts,
            })),
          },
        };
      }
      // Passthrough Ingress lookup.
      if (args.name === 'oauth2-proxy-passthrough') {
        if (!opts.passthroughIngressExists) throw notFound();
        return { metadata: { resourceVersion: '11' } };
      }
      throw notFound();
    }),
    createNamespacedIngress: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'ingress', args });
    }),
    replaceNamespacedIngress: vi.fn(async (args: unknown) => {
      calls.replace.push({ kind: 'ingress', args });
    }),
    deleteNamespacedIngress: vi.fn(async () => calls.delete.push({ kind: 'ingress' })),
  };

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
    const creates = (m.calls.create as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(creates).toEqual(['configmap', 'deployment', 'ingress', 'secret', 'service']);
  });

  it('updates resources when proxy already provisioned', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: true },
      deploymentExists: true,
      serviceExists: true,
      configMapExists: true,
      secretExists: true,
      passthroughIngressExists: true,
    });
    const result = await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('updated');
    const replaces = (m.calls.replace as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(replaces).toEqual(['configmap', 'deployment', 'ingress', 'secret', 'service']);
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
    // Booleans must be unquoted in TOML.
    expect(cfg).toContain('pass_authorization_header=true');
    expect(cfg).toContain('set_xauthrequest=true');
    expect(cfg).toContain('reverse_proxy=true');
    expect(cfg).toContain('client_id="oauth-client-id"');
    expect(cfg).toContain('client_secret="plaintext-secret"');
    // Trailing slash must be stripped from issuer URL.
    expect(cfg).toContain('oidc_issuer_url="https://idp.example.com"');
    expect(cfg).not.toContain('oidc_issuer_url="https://idp.example.com/"');
  });

  it('creates a passthrough Ingress for /oauth2/* with no auth-* annotations', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
      tenantTls: { 'tls-app-example': ['app.example.com'] },
    });
    await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const ingressCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { metadata: { annotations?: Record<string, string> }; spec: { rules: Array<{ host: string; http: { paths: Array<{ path: string; backend: { service: { name: string; port: { number: number } } } }> } }>; tls?: Array<{ hosts: string[]; secretName: string }> } } };
      }>
    ).find((c) => c.kind === 'ingress')!;
    expect(ingressCreate).toBeDefined();
    const annotations = ingressCreate.args.body.metadata.annotations ?? {};
    // Critical: passthrough Ingress MUST NOT carry the auth-request gate.
    expect(annotations['nginx.ingress.kubernetes.io/auth-url']).toBeUndefined();
    expect(annotations['nginx.ingress.kubernetes.io/auth-signin']).toBeUndefined();
    const rule = ingressCreate.args.body.spec.rules[0]!;
    expect(rule.host).toBe('app.example.com');
    const path = rule.http.paths[0]!;
    expect(path.path).toBe('/oauth2');
    expect(path.backend.service.name).toBe('oauth2-proxy');
    expect(path.backend.service.port.number).toBe(4180);
    // TLS secret copied from tenant Ingress.
    expect(ingressCreate.args.body.spec.tls).toEqual([
      { secretName: 'tls-app-example', hosts: ['app.example.com'] },
    ]);
  });

  it('passthrough Ingress lists every protected hostname when client has multiple', async () => {
    const secondRow = {
      ...ENABLED_ROW,
      cfg: { ...ENABLED_ROW.cfg, id: 'cfg-2', ingressRouteId: 'ir-2' },
      hostname: 'admin.example.com',
    };
    const m = makeMocks({
      enabled: [ENABLED_ROW, secondRow],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
      tenantTls: {
        'tls-app-example': ['app.example.com'],
        'tls-admin-example': ['admin.example.com'],
      },
    });
    await reconcileClient(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const ingressCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { rules: Array<{ host: string }>; tls?: Array<{ secretName: string; hosts: string[] }> } } };
      }>
    ).find((c) => c.kind === 'ingress')!;
    const hosts = ingressCreate.args.body.spec.rules.map((r) => r.host).sort();
    expect(hosts).toEqual(['admin.example.com', 'app.example.com']);
    const tlsSecrets = (ingressCreate.args.body.spec.tls ?? [])
      .map((t) => t.secretName)
      .sort();
    expect(tlsSecrets).toEqual(['tls-admin-example', 'tls-app-example']);
  });

  it('uses scopesOverride when set, falls back to provider defaultScopes otherwise', async () => {
    const overrideRow = {
      ...ENABLED_ROW,
      cfg: { ...ENABLED_ROW.cfg, scopesOverride: 'openid profile email groups' },
    };
    const m = makeMocks({
      enabled: [overrideRow],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileClient({ db: m.db, k8s: m.k8s, encryptionKey: 'k' }, CLIENT_ID);
    const cm = (m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>).find(
      (c) => c.kind === 'configmap',
    )!;
    expect(cm.args.body.data['oauth2_proxy.cfg']!).toContain('scope="openid profile email groups"');
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
    expect(deletes).toEqual(['configmap', 'deployment', 'ingress', 'secret', 'service']);
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
