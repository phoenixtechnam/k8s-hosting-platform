import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers-service.js', () => ({
  decryptProviderSecret: vi.fn(() => 'plaintext-secret'),
}));
vi.mock('./service.js', () => ({
  getOrCreateTenantCookieSecret: vi.fn().mockResolvedValue('cookie-secret-32-bytes-long-fake_'),
  listEnabledForTenant: vi.fn(),
}));

import { reconcileTenant } from './reconciler.js';
import { listEnabledForTenant } from './service.js';

const listEnabledMock = listEnabledForTenant as unknown as ReturnType<typeof vi.fn>;

const CLIENT_ID = 'c-1';
const NAMESPACE = 'tenant-c1';

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
    oauthClientId: 'oauth-tenant-id',
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

  // Mocked listEnabledForTenant → return canned set.
  listEnabledMock.mockResolvedValue(opts.enabled);

  // Drizzle DB. Sequence:
  //   1. tenants select → namespace
  //   2. tenantOauth2ProxyState (only on teardown path)
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
    // Kept for type compatibility; the reconciler no longer touches
    // Ingress objects (Phase 2 part 5 migrated the passthrough Ingress
    // to a Traefik IngressRoute on the `custom` API tenant).
    readNamespacedIngress: vi.fn(async () => { throw notFound(); }),
    createNamespacedIngress: vi.fn(),
    replaceNamespacedIngress: vi.fn(),
    deleteNamespacedIngress: vi.fn(),
  };

  // CustomObjectsApi mock — handles IngressRoute create / replace /
  // delete for the passthrough resource. Existence flagged by
  // opts.passthroughIngressExists.
  const custom = {
    getNamespacedCustomObject: vi.fn(async (args: { plural: string; name: string }) => {
      calls.read.push({ kind: args.plural, name: args.name });
      if (args.plural === 'ingressroutes' && args.name === 'oauth2-proxy-passthrough') {
        if (!opts.passthroughIngressExists) throw notFound();
        return { metadata: { resourceVersion: '11' } };
      }
      throw notFound();
    }),
    createNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.create.push({ kind: 'ingressroute', args });
    }),
    replaceNamespacedCustomObject: vi.fn(async (args: unknown) => {
      calls.replace.push({ kind: 'ingressroute', args });
    }),
    deleteNamespacedCustomObject: vi.fn(async () => calls.delete.push({ kind: 'ingressroute' })),
    listNamespacedCustomObject: vi.fn(async () => ({ items: [] })),
  };

  // Reference opts.tenantTls so the option remains available for tests
  // that previously relied on it; the value is no longer needed because
  // Traefik's TLSStore picks up the cert from the tenant IngressRoute
  // by SNI, not from a per-Ingress lookup.
  void opts.tenantTls;

  return { db, k8s: { core, apps, networking, custom }, calls } as never;
}

describe('reconcileTenant — provisioning path', () => {
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
    const result = await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('provisioned');
    expect(result.error).toBeNull();
    expect(result.enabledIngresses).toBe(1);
    const creates = (m.calls.create as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(creates).toEqual(['configmap', 'deployment', 'ingressroute', 'secret', 'service']);
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
    const result = await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('updated');
    const replaces = (m.calls.replace as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(replaces).toEqual(['configmap', 'deployment', 'ingressroute', 'secret', 'service']);
  });

  it('serialises claim_rules into the rules.json ConfigMap key', async () => {
    const m = makeMocks({
      enabled: [ENABLED_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileTenant(
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
    await reconcileTenant(
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
    expect(cfg).toContain('client_id="oauth-tenant-id"');
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
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const ingressCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { routes: Array<{ match: string; priority?: number; middlewares?: Array<{ name: string }>; services: Array<{ name: string; port: number }> }> } } };
      }>
    ).find((c) => c.kind === 'ingressroute')!;
    expect(ingressCreate).toBeDefined();
    const route = ingressCreate.args.body.spec.routes[0]!;
    // Critical: passthrough IngressRoute MUST NOT carry the OIDC
    // ForwardAuth Middleware (it IS oauth2-proxy's own redirect target).
    expect(route.middlewares).toBeUndefined();
    expect(route.match).toContain('app.example.com');
    expect(route.match).toContain('/oauth2');
    expect(route.priority).toBe(100);
    expect(route.services[0]).toEqual({ name: 'oauth2-proxy', port: 4180 });
  });

  it('passthrough IngressRoute lists every protected hostname when tenant has multiple', async () => {
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
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const ingressCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { routes: Array<{ match: string }> } } };
      }>
    ).find((c) => c.kind === 'ingressroute')!;
    const matchHosts = ingressCreate.args.body.spec.routes
      .map((r) => {
        const m = r.match.match(/Host\(`([^`]+)`\)/);
        return m?.[1] ?? '';
      })
      .sort();
    expect(matchHosts).toEqual(['admin.example.com', 'app.example.com']);
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
    await reconcileTenant({ db: m.db, k8s: m.k8s, encryptionKey: 'k' }, CLIENT_ID);
    const cm = (m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>).find(
      (c) => c.kind === 'configmap',
    )!;
    expect(cm.args.body.data['oauth2_proxy.cfg']!).toContain('scope="openid profile email groups"');
  });
});

describe('reconcileTenant — teardown path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes resources when no enabled ingress remains', async () => {
    const m = makeMocks({
      enabled: [],
      proxyState: { provisioned: true },
    });
    const result = await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('torn_down');
    const deletes = (m.calls.delete as Array<{ kind: string }>).map((c) => c.kind).sort();
    expect(deletes).toEqual(['configmap', 'deployment', 'ingressroute', 'secret', 'service']);
  });

  it('is a noop when nothing was provisioned and no enabled rows exist', async () => {
    const m = makeMocks({
      enabled: [],
      proxyState: { provisioned: false },
    });
    const result = await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    expect(result.action).toBe('noop');
    expect(m.calls.delete).toEqual([]);
  });
});

describe('reconcileTenant — claim-validator sidecar is conditional on claim rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const NO_RULES_ROW = {
    ...ENABLED_ROW,
    cfg: { ...ENABLED_ROW.cfg, claimRules: null },
  };

  it('omits the sidecar container when no enabled config has claim rules', async () => {
    const m = makeMocks({
      enabled: [NO_RULES_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const deployCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { template: { spec: { containers: Array<{ name: string }> } } } } };
      }>
    ).find((c) => c.kind === 'deployment')!;
    const containerNames = deployCreate.args.body.spec.template.spec.containers.map((c) => c.name);
    expect(containerNames).toEqual(['oauth2-proxy']);
    expect(containerNames).not.toContain('claim-validator');
  });

  it('omits the validator port from the Service when no rules are configured', async () => {
    const m = makeMocks({
      enabled: [NO_RULES_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const svcCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { ports: Array<{ name: string; port: number }> } } };
      }>
    ).find((c) => c.kind === 'service')!;
    const portNames = svcCreate.args.body.spec.ports.map((p) => p.name);
    expect(portNames).toEqual(['proxy']);
  });

  it('omits rules.json from the ConfigMap when no rules are configured', async () => {
    const m = makeMocks({
      enabled: [NO_RULES_ROW],
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const cm = (
      m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>
    ).find((c) => c.kind === 'configmap')!;
    expect(cm.args.body.data['oauth2_proxy.cfg']).toBeDefined();
    expect(cm.args.body.data['rules.json']).toBeUndefined();
  });

  it('includes sidecar + validator port + rules.json when at least one row has rules', async () => {
    // Mixed set: one row with rules, one without — sidecar still required.
    const mixed = [
      ENABLED_ROW,
      {
        ...NO_RULES_ROW,
        cfg: { ...NO_RULES_ROW.cfg, id: 'cfg-2', ingressRouteId: 'ir-2' },
        hostname: 'no-rules.example.com',
      },
    ];
    const m = makeMocks({
      enabled: mixed,
      proxyState: { provisioned: false },
      deploymentExists: false,
      serviceExists: false,
    });
    await reconcileTenant(
      { db: m.db, k8s: m.k8s, encryptionKey: 'k' },
      CLIENT_ID,
    );
    const deployCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { template: { spec: { containers: Array<{ name: string }> } } } } };
      }>
    ).find((c) => c.kind === 'deployment')!;
    const containerNames = deployCreate.args.body.spec.template.spec.containers.map((c) => c.name);
    expect(containerNames).toEqual(['oauth2-proxy', 'claim-validator']);

    const svcCreate = (
      m.calls.create as Array<{
        kind: string;
        args: { body: { spec: { ports: Array<{ name: string }> } } };
      }>
    ).find((c) => c.kind === 'service')!;
    expect(svcCreate.args.body.spec.ports.map((p) => p.name)).toEqual(['proxy', 'validator']);

    const cm = (
      m.calls.create as Array<{ kind: string; args: { body: { data: Record<string, string> } } }>
    ).find((c) => c.kind === 'configmap')!;
    // rules.json only carries the ruled config (cfg-1), not the empty one.
    expect(cm.args.body.data['rules.json']).toContain('"membership"');
    expect(cm.args.body.data['rules.json']).not.toContain('"cfg-2"');
  });
});
