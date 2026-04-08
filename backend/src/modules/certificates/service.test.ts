import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── tls-settings mock ────────────────────────────────────────────────────
vi.mock('../tls-settings/service.js', () => ({
  isAutoTlsEnabled: vi.fn().mockResolvedValue(true),
  getClusterIssuerName: vi.fn().mockResolvedValue('letsencrypt-prod-http01'),
}));

// ─── dns-servers/service.ts mock ──────────────────────────────────────────
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: vi.fn().mockResolvedValue([]),
}));

// ─── DB mock with queued SELECT results ──────────────────────────────────
let selectResults: unknown[][];
let selectCallIndex: number;

function createMockDb() {
  selectCallIndex = 0;

  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[selectCallIndex] ?? [];
    selectCallIndex += 1;
    return Promise.resolve(result);
  });

  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return { select: selectFn } as unknown as ReturnType<typeof createMockDb>;
}

// ─── K8s mock ─────────────────────────────────────────────────────────────
function createMockK8s(): K8sClients & {
  _createCustom: ReturnType<typeof vi.fn>;
  _replaceCustom: ReturnType<typeof vi.fn>;
  _deleteCustom: ReturnType<typeof vi.fn>;
  _listCustom: ReturnType<typeof vi.fn>;
  _getCustom: ReturnType<typeof vi.fn>;
} {
  const createCustom = vi.fn().mockResolvedValue({});
  const replaceCustom = vi.fn().mockResolvedValue({});
  const deleteCustom = vi.fn().mockResolvedValue({});
  const listCustom = vi.fn().mockResolvedValue({ items: [] });
  const getCustom = vi.fn().mockResolvedValue({});

  return {
    custom: {
      createNamespacedCustomObject: createCustom,
      replaceNamespacedCustomObject: replaceCustom,
      deleteNamespacedCustomObject: deleteCustom,
      listNamespacedCustomObject: listCustom,
      getNamespacedCustomObject: getCustom,
    },
    core: {},
    apps: {},
    networking: {},
    _createCustom: createCustom,
    _replaceCustom: replaceCustom,
    _deleteCustom: deleteCustom,
    _listCustom: listCustom,
    _getCustom: getCustom,
  } as never;
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

// Import after mocks
const service = await import('./service.js');
const tlsSettings = await import('../tls-settings/service.js');
const dnsServersService = await import('../dns-servers/service.js');

beforeEach(() => {
  selectResults = [];
  selectCallIndex = 0;
  vi.mocked(tlsSettings.isAutoTlsEnabled).mockResolvedValue(true);
  vi.mocked(tlsSettings.getClusterIssuerName).mockResolvedValue('letsencrypt-prod-http01');
  vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([]);
  process.env.CERT_ENVIRONMENT = 'production';
});

// ═══════════════════════════════════════════════════════════════════════════
// ensureDomainCertificate
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureDomainCertificate', () => {
  const domain = {
    id: 'd1',
    clientId: 'c1',
    domainName: 'acme.com',
    dnsMode: 'cname',
    dnsGroupId: null,
  };
  const client = { id: 'c1', kubernetesNamespace: 'client-acme' };

  it('skips provisioning entirely when auto-TLS is disabled', async () => {
    vi.mocked(tlsSettings.isAutoTlsEnabled).mockResolvedValue(false);
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('auto-TLS disabled');
    expect(k8s._createCustom).not.toHaveBeenCalled();
  });

  it('creates an HTTP-01 per-hostname Certificate CR for cname mode', async () => {
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());

    expect(result.skipped).toBe(false);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    expect(result.wildcard).toBe(false);
    expect(k8s._createCustom).toHaveBeenCalledOnce();

    const call = k8s._createCustom.mock.calls[0][0];
    expect(call.namespace).toBe('client-acme');
    expect(call.body.metadata.name).toBe('acme-com-cert');
    expect(call.body.spec.secretName).toBe('acme-com-tls');
    expect(call.body.spec.dnsNames).toEqual(['acme.com']);
    expect(call.body.spec.issuerRef.name).toBe('letsencrypt-prod-http01');
  });

  it('creates a wildcard DNS-01 Certificate CR for primary + PowerDNS', async () => {
    vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([
      { id: 's1', providerType: 'powerdns', enabled: 1, role: 'primary' } as never,
    ]);
    selectResults = [[{ ...domain, dnsMode: 'primary' }], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());

    expect(result.skipped).toBe(false);
    expect(result.wildcard).toBe(true);
    expect(result.issuerName).toBe('letsencrypt-prod-dns01-powerdns');

    const call = k8s._createCustom.mock.calls[0][0];
    expect(call.body.spec.dnsNames).toEqual(['acme.com', '*.acme.com']);
    expect(call.body.spec.issuerRef.name).toBe('letsencrypt-prod-dns01-powerdns');
    expect(call.body.metadata.name).toBe('acme-com-wildcard-cert');
    expect(call.body.spec.secretName).toBe('acme-com-wildcard-tls');
  });

  it('falls back to HTTP-01 when primary mode but no PowerDNS server available', async () => {
    vi.mocked(dnsServersService.getActiveServersForDomain).mockResolvedValue([
      { id: 's1', providerType: 'cloudflare', enabled: 1, role: 'primary' } as never,
    ]);
    selectResults = [[{ ...domain, dnsMode: 'primary' }], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());

    expect(result.wildcard).toBe(false);
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
  });

  it('uses local-ca-issuer in development environment', async () => {
    process.env.CERT_ENVIRONMENT = 'development';
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());

    expect(result.issuerName).toBe('local-ca-issuer');
    const call = k8s._createCustom.mock.calls[0][0];
    expect(call.body.spec.issuerRef.name).toBe('local-ca-issuer');
  });

  it('replaces an existing Certificate on 409 instead of failing', async () => {
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Conflict'), { statusCode: 409 }),
    );

    const result = await service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger());
    expect(result.skipped).toBe(false);
    expect(k8s._replaceCustom).toHaveBeenCalledOnce();
  });

  it('throws on non-409 k8s errors', async () => {
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );

    await expect(
      service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger()),
    ).rejects.toMatchObject({ code: 'CERT_PROVISIONING_FAILED' });
  });

  it('throws DOMAIN_NOT_FOUND when the domain id is unknown', async () => {
    selectResults = [[]];
    const db = createMockDb();
    const k8s = createMockK8s();

    await expect(
      service.ensureDomainCertificate(db as never, k8s, 'ghost', makeLogger()),
    ).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND', status: 404 });
  });

  it('throws CLIENT_NOT_FOUND when the client row is missing', async () => {
    selectResults = [[domain], []];
    const db = createMockDb();
    const k8s = createMockK8s();

    await expect(
      service.ensureDomainCertificate(db as never, k8s, 'd1', makeLogger()),
    ).rejects.toMatchObject({ code: 'CLIENT_NOT_FOUND', status: 404 });
  });

  it('skips provisioning when k8s client is undefined (no-k8s mode)', async () => {
    selectResults = [[domain], [client]];
    const db = createMockDb();

    const result = await service.ensureDomainCertificate(
      db as never,
      undefined,
      'd1',
      makeLogger(),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('no k8s client');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deleteDomainCertificate
// ═══════════════════════════════════════════════════════════════════════════

describe('deleteDomainCertificate', () => {
  it('deletes Certificate CR + TLS Secret for the wildcard name', async () => {
    const domain = { id: 'd1', domainName: 'acme.com' };
    const client = { id: 'c1', kubernetesNamespace: 'client-acme' };
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();
    // Also need deleteNamespacedSecret for the TLS secret cleanup
    (k8s as never as { core: { deleteNamespacedSecret: ReturnType<typeof vi.fn> } }).core = {
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    };

    await service.deleteDomainCertificate(db as never, k8s, 'd1', makeLogger());
    expect(k8s._deleteCustom).toHaveBeenCalled();
  });

  it('tolerates 404 on Certificate delete (already gone)', async () => {
    const domain = { id: 'd1', domainName: 'acme.com' };
    const client = { id: 'c1', kubernetesNamespace: 'client-acme' };
    selectResults = [[domain], [client]];
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s as never as { core: { deleteNamespacedSecret: ReturnType<typeof vi.fn> } }).core = {
      deleteNamespacedSecret: vi.fn().mockResolvedValue({}),
    };
    (k8s._deleteCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Not found'), { statusCode: 404 }),
    );

    // Should not throw
    await service.deleteDomainCertificate(db as never, k8s, 'd1', makeLogger());
  });

  it('no-ops on missing domain', async () => {
    selectResults = [[]];
    const db = createMockDb();
    const k8s = createMockK8s();

    // Should not throw — delete is idempotent
    await service.deleteDomainCertificate(db as never, k8s, 'ghost', makeLogger());
    expect(k8s._deleteCustom).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// certificateNameFor / tlsSecretNameFor
// ═══════════════════════════════════════════════════════════════════════════

describe('hostnameIsCoveredByDomainCert', () => {
  it('matches the apex when hostname === domain', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    expect(hostnameIsCoveredByDomainCert('acme.com', 'acme.com', false)).toBe(true);
    expect(hostnameIsCoveredByDomainCert('acme.com', 'acme.com', true)).toBe(true);
  });

  it('is case-insensitive', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    expect(hostnameIsCoveredByDomainCert('Acme.COM', 'acme.com', false)).toBe(true);
  });

  it('covers a single-label subdomain when wildcard=true', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    expect(hostnameIsCoveredByDomainCert('api.acme.com', 'acme.com', true)).toBe(true);
    expect(hostnameIsCoveredByDomainCert('webmail.acme.com', 'acme.com', true)).toBe(true);
  });

  it('rejects a single-label subdomain when wildcard=false', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    expect(hostnameIsCoveredByDomainCert('api.acme.com', 'acme.com', false)).toBe(false);
  });

  it('rejects deeper subdomains even with wildcard (non-recursive)', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    // Per RFC 6125, *.acme.com does NOT match api.v1.acme.com
    expect(hostnameIsCoveredByDomainCert('api.v1.acme.com', 'acme.com', true)).toBe(false);
  });

  it('rejects hostnames under a different domain', async () => {
    const { hostnameIsCoveredByDomainCert } = await import('./service.js');
    expect(hostnameIsCoveredByDomainCert('api.other.com', 'acme.com', true)).toBe(false);
    expect(hostnameIsCoveredByDomainCert('acmex.com', 'acme.com', true)).toBe(false);
  });
});

describe('cert naming', () => {
  it('produces stable names for a domain', async () => {
    const { certificateNameFor, tlsSecretNameFor } = await import('./service.js');
    expect(certificateNameFor('acme.com', false)).toBe('acme-com-cert');
    expect(tlsSecretNameFor('acme.com', false)).toBe('acme-com-tls');
  });

  it('uses a -wildcard- suffix when wildcard=true', async () => {
    const { certificateNameFor, tlsSecretNameFor } = await import('./service.js');
    expect(certificateNameFor('acme.com', true)).toBe('acme-com-wildcard-cert');
    expect(tlsSecretNameFor('acme.com', true)).toBe('acme-com-wildcard-tls');
  });

  it('truncates and sanitizes long domain names', async () => {
    const { certificateNameFor } = await import('./service.js');
    const long = 'really-long-domain-name-to-test-truncation.example.com';
    const result = certificateNameFor(long, false);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toMatch(/^[a-z0-9-]+$/);
    expect(result.endsWith('-cert')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ensureMailServerCertificate
// ═══════════════════════════════════════════════════════════════════════════

describe('ensureMailServerCertificate', () => {
  const MAIL_NAMESPACE = 'mail';

  it('creates a Certificate CR in the mail namespace for the given hostname', async () => {
    const db = createMockDb();
    const k8s = createMockK8s();
    const result = await service.ensureMailServerCertificate(
      db as never,
      k8s,
      'mail.platform.com',
      makeLogger(),
    );

    expect(result.skipped).toBe(false);
    expect(result.namespace).toBe(MAIL_NAMESPACE);
    expect(result.secretName).toBe('stalwart-tls');

    const call = k8s._createCustom.mock.calls[0][0];
    expect(call.namespace).toBe(MAIL_NAMESPACE);
    expect(call.body.metadata.name).toBe('stalwart-mail-cert');
    expect(call.body.spec.secretName).toBe('stalwart-tls');
    expect(call.body.spec.dnsNames).toEqual(['mail.platform.com']);
  });

  it('uses the HTTP-01 issuer in production environment (mail hostname is public, not customer)', async () => {
    process.env.CERT_ENVIRONMENT = 'production';
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureMailServerCertificate(
      db as never,
      k8s,
      'mail.platform.com',
      makeLogger(),
    );
    expect(result.issuerName).toBe('letsencrypt-prod-http01');
    const call = k8s._createCustom.mock.calls[0][0];
    expect(call.body.spec.issuerRef.name).toBe('letsencrypt-prod-http01');
  });

  it('uses local-ca-issuer in development environment', async () => {
    process.env.CERT_ENVIRONMENT = 'development';
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureMailServerCertificate(
      db as never,
      k8s,
      'mail.dind.local',
      makeLogger(),
    );
    expect(result.issuerName).toBe('local-ca-issuer');
  });

  it('replaces an existing Certificate on 409', async () => {
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Conflict'), { statusCode: 409 }),
    );

    const result = await service.ensureMailServerCertificate(
      db as never,
      k8s,
      'mail.platform.com',
      makeLogger(),
    );
    expect(result.skipped).toBe(false);
    expect(k8s._replaceCustom).toHaveBeenCalledOnce();
  });

  it('skips and returns reason when auto-TLS is disabled', async () => {
    vi.mocked(tlsSettings.isAutoTlsEnabled).mockResolvedValue(false);
    const db = createMockDb();
    const k8s = createMockK8s();

    const result = await service.ensureMailServerCertificate(
      db as never,
      k8s,
      'mail.platform.com',
      makeLogger(),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('auto-TLS disabled');
    expect(k8s._createCustom).not.toHaveBeenCalled();
  });

  it('skips when no k8s client is available', async () => {
    const db = createMockDb();
    const result = await service.ensureMailServerCertificate(
      db as never,
      undefined,
      'mail.platform.com',
      makeLogger(),
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('no k8s client');
  });

  it('throws CERT_PROVISIONING_FAILED on non-409 errors', async () => {
    const db = createMockDb();
    const k8s = createMockK8s();
    (k8s._createCustom as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { statusCode: 403 }),
    );

    await expect(
      service.ensureMailServerCertificate(
        db as never,
        k8s,
        'mail.platform.com',
        makeLogger(),
      ),
    ).rejects.toMatchObject({ code: 'CERT_PROVISIONING_FAILED' });
  });

  it('rejects invalid hostnames (empty, whitespace, starts with dot)', async () => {
    const db = createMockDb();
    const k8s = createMockK8s();

    for (const invalid of ['', '   ', '.mail.example.com', 'mail..com']) {
      await expect(
        service.ensureMailServerCertificate(
          db as never,
          k8s,
          invalid,
          makeLogger(),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    }
  });
});
