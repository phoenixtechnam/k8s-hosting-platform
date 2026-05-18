import { describe, it, expect, vi } from 'vitest';
import {
  reconcileWebmailCertificates,
  readCertReadyStatus,
  reconcilePerTenantWebmailEngineRouting,
  WEBMAIL_ENGINE_LABEL,
} from './webmail-reconciler.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// Mock the active-engine lookup so the test controls the engine
// directly without booting platform_settings.
vi.mock('../webmail-settings/service.js', () => ({
  getDefaultWebmailEngine: vi.fn().mockResolvedValue('bulwark'),
  getMailServerHostname: vi.fn().mockResolvedValue('mail.example.com'),
}));

// ─── Mock the cert-manager Certificate CR fetch ────────────────────

function makeK8sTenant(certs: Record<string, { conditions: { type: string; status: string; message?: string; reason?: string }[] } | null>): K8sClients {
  return {
    custom: {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { name: string }) => {
        const cert = certs[args.name];
        if (!cert) {
          const err = new Error('Not Found') as Error & { statusCode?: number };
          err.statusCode = 404;
          throw err;
        }
        return Promise.resolve({ status: cert });
      }),
    },
  } as unknown as K8sClients;
}

function makeDb(rows: Array<{
  id: string;
  domainName: string;
  tenantNamespace: string;
  webmailStatus: string;
  webmailEnabled: number;
}>) {
  // Track UPDATE calls so the test can assert them.
  const updateCalls: Array<{ id: string; values: Record<string, unknown> }> = [];

  const whereFn = vi.fn().mockResolvedValue(rows);
  const innerJoin2 = vi.fn().mockReturnValue({ where: whereFn });
  const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 });
  const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoin1 });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockImplementation((cond: unknown) => {
    // Capture id from the last setValues call.
    const last = updateCalls[updateCalls.length - 1];
    if (last) last.values._whereCond = cond;
    return Promise.resolve();
  });
  const updateSet = vi.fn().mockImplementation((values: Record<string, unknown>) => {
    updateCalls.push({ id: '?', values });
    return { where: updateWhere };
  });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { select: selectFn, update: updateFn } as unknown as Parameters<typeof reconcileWebmailCertificates>[0],
    updateCalls,
  };
}

describe('readCertReadyStatus', () => {
  it('returns the Ready condition when cert-manager has issued the cert', async () => {
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': { conditions: [{ type: 'Ready', status: 'True' }] },
    });
    const cond = await readCertReadyStatus(k8s, 'tenant-x', 'webmail.example.com');
    expect(cond?.status).toBe('True');
  });

  it('returns the Ready condition with status=False when cert-manager rejected the cert', async () => {
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': {
        conditions: [{ type: 'Ready', status: 'False', reason: 'Failed', message: 'ACME challenge timeout' }],
      },
    });
    const cond = await readCertReadyStatus(k8s, 'tenant-x', 'webmail.example.com');
    expect(cond?.status).toBe('False');
    expect(cond?.message).toContain('ACME challenge timeout');
  });

  it('returns null when the Certificate CR does not exist', async () => {
    const k8s = makeK8sTenant({});
    const cond = await readCertReadyStatus(k8s, 'tenant-x', 'webmail.gone.com');
    expect(cond).toBeNull();
  });
});

describe('reconcileWebmailCertificates', () => {
  it('promotes pending → ready when cert-manager reports Ready=True', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        tenantNamespace: 'tenant-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': { conditions: [{ type: 'Ready', status: 'True' }] },
    });

    const result = await reconcileWebmailCertificates(db, k8s);

    expect(result.scanned).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.errors).toBe(0);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].values.webmailStatus).toBe('ready');
    expect(updateCalls[0].values.webmailStatusMessage).toBeNull();
  });

  it('promotes ready_no_tls → ready when cert finally issues', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        tenantNamespace: 'tenant-x',
        webmailStatus: 'ready_no_tls',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': { conditions: [{ type: 'Ready', status: 'True' }] },
    });

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.promoted).toBe(1);
    expect(updateCalls[0].values.webmailStatus).toBe('ready');
  });

  it('demotes pending → ready_no_tls when cert-manager actively rejects the cert', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        tenantNamespace: 'tenant-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': {
        conditions: [{ type: 'Ready', status: 'False', message: 'ACME timeout' }],
      },
    });

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.promoted).toBe(0);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].values.webmailStatus).toBe('ready_no_tls');
    expect(updateCalls[0].values.webmailStatusMessage).toContain('ACME timeout');
  });

  it('leaves status alone when the Certificate CR is not found (still issuing)', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        tenantNamespace: 'tenant-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sTenant({});

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.promoted).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('skips rows where webmail_enabled=0 even if status is pending', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        tenantNamespace: 'tenant-x',
        webmailStatus: 'pending',
        webmailEnabled: 0,
      },
    ]);
    const k8s = makeK8sTenant({
      'webmail-example-com-cert': { conditions: [{ type: 'Ready', status: 'True' }] },
    });

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.promoted).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('does NOT touch ready rows', async () => {
    // SELECT in reconcileWebmailCertificates filters via inArray on
    // ['pending', 'ready_no_tls'] — `ready` rows are never returned
    // by the query, so nothing should be updated.
    const { db, updateCalls } = makeDb([]);
    const k8s = makeK8sTenant({});

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.scanned).toBe(0);
    expect(updateCalls.length).toBe(0);
  });
});

// ─── reconcilePerTenantWebmailEngineRouting ───────────────────────
//
// 2026-05-18: verify the per-tenant Ingress reconciler flips the
// ExternalName Service to the active engine when the label has
// drifted, and is a cheap no-op when the label already matches.

function makePerTenantDb(rows: Array<{
  id: string;
  domainName: string;
  tenantNamespace: string;
  webmailEnabled: number;
}>) {
  const whereFn = vi.fn().mockResolvedValue(rows);
  const innerJoin2 = vi.fn().mockReturnValue({ where: whereFn });
  const innerJoin1 = vi.fn().mockReturnValue({ innerJoin: innerJoin2 });
  const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoin1 });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn } as unknown as Parameters<typeof reconcilePerTenantWebmailEngineRouting>[0];
}

function makePerTenantK8s(opts: {
  serviceLabel?: string | null;
  serviceExternalName?: string;
  readShouldFail?: 'notFound' | 'transient';
}) {
  const patchSpy = vi.fn().mockResolvedValue({});
  const readSpy = vi.fn().mockImplementation(() => {
    if (opts.readShouldFail === 'notFound') {
      const err = new Error('Not Found') as Error & { statusCode?: number };
      err.statusCode = 404;
      throw err;
    }
    if (opts.readShouldFail === 'transient') {
      throw new Error('connection reset');
    }
    return Promise.resolve({
      metadata: {
        labels: opts.serviceLabel !== null
          ? { [WEBMAIL_ENGINE_LABEL]: opts.serviceLabel ?? 'roundcube' }
          : {},
      },
      spec: { externalName: opts.serviceExternalName ?? 'roundcube.mail.svc.cluster.local' },
    });
  });

  const k8s = {
    core: {
      readNamespacedService: readSpy,
      patchNamespacedService: patchSpy,
    },
  } as unknown as K8sClients;

  return { k8s, patchSpy, readSpy };
}

describe('reconcilePerTenantWebmailEngineRouting', () => {
  it('patches the ExternalName + engine label when the live label drifts from the active engine', async () => {
    const db = makePerTenantDb([
      { id: 'ed1', domainName: 'foo.com', tenantNamespace: 'tenant-foo', webmailEnabled: 1 },
    ]);
    const { k8s, patchSpy } = makePerTenantK8s({
      serviceLabel: 'roundcube',
      serviceExternalName: 'roundcube.mail.svc.cluster.local',
    });

    const result = await reconcilePerTenantWebmailEngineRouting(db, k8s);

    expect(result).toEqual({ scanned: 1, patched: 1, rebuilt: 0, errors: 0 });
    expect(patchSpy).toHaveBeenCalledTimes(1);
    const firstArg = patchSpy.mock.calls[0][0] as {
      namespace: string;
      name: string;
      body: { metadata: { labels: Record<string, string> }; spec: { externalName: string } };
    };
    expect(firstArg.namespace).toBe('tenant-foo');
    expect(firstArg.name).toBe('webmail-foo-com-upstream');
    expect(firstArg.body.spec.externalName).toBe('bulwark.mail.svc.cluster.local');
    expect(firstArg.body.metadata.labels[WEBMAIL_ENGINE_LABEL]).toBe('bulwark');
  });

  it('no-ops when the label already matches the active engine', async () => {
    const db = makePerTenantDb([
      { id: 'ed1', domainName: 'foo.com', tenantNamespace: 'tenant-foo', webmailEnabled: 1 },
    ]);
    const { k8s, patchSpy } = makePerTenantK8s({
      serviceLabel: 'bulwark',
      serviceExternalName: 'bulwark.mail.svc.cluster.local',
    });

    const result = await reconcilePerTenantWebmailEngineRouting(db, k8s);

    expect(result).toEqual({ scanned: 1, patched: 0, rebuilt: 0, errors: 0 });
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('patches when the label is missing entirely (pre-2026-05-18 tenants)', async () => {
    const db = makePerTenantDb([
      { id: 'ed1', domainName: 'legacy.com', tenantNamespace: 'tenant-l', webmailEnabled: 1 },
    ]);
    const { k8s, patchSpy } = makePerTenantK8s({
      serviceLabel: null,
      serviceExternalName: 'roundcube.mail.svc.cluster.local',
    });

    const result = await reconcilePerTenantWebmailEngineRouting(db, k8s);

    expect(result.patched).toBe(1);
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports rebuilt=1 + skips the patch when the ExternalName Service is missing', async () => {
    // The reconciler dynamically imports `ensureWebmailIngress` to
    // bootstrap — we mock the import path so the test doesn't need
    // a fully wired DB. The mock asserts it was called with the
    // correct emailDomainId.
    const ensureSpy = vi.fn().mockResolvedValue({ ingressCreated: true, status: 'ready' });
    vi.doMock('./service.js', () => ({ ensureWebmailIngress: ensureSpy }));

    const db = makePerTenantDb([
      { id: 'ed-missing', domainName: 'gone.com', tenantNamespace: 'tenant-g', webmailEnabled: 1 },
    ]);
    const { k8s, patchSpy } = makePerTenantK8s({ readShouldFail: 'notFound' });

    // Re-import the reconciler so the mock applies. Using
    // dynamic import avoids re-imports for unrelated tests.
    const mod = await import('./webmail-reconciler.js');
    const result = await mod.reconcilePerTenantWebmailEngineRouting(db, k8s);

    expect(result.rebuilt).toBe(1);
    expect(result.patched).toBe(0);
    expect(patchSpy).not.toHaveBeenCalled();
    expect(ensureSpy).toHaveBeenCalledWith(db, k8s, 'ed-missing');

    vi.doUnmock('./service.js');
  });

  it('captures transient read errors as errors=1 (does not abort the loop)', async () => {
    const db = makePerTenantDb([
      { id: 'ed1', domainName: 'broken.com', tenantNamespace: 'tenant-b', webmailEnabled: 1 },
      { id: 'ed2', domainName: 'ok.com', tenantNamespace: 'tenant-o', webmailEnabled: 1 },
    ]);

    let readCount = 0;
    const readSpy = vi.fn().mockImplementation(() => {
      readCount++;
      if (readCount === 1) throw new Error('transient');
      return Promise.resolve({
        metadata: { labels: { [WEBMAIL_ENGINE_LABEL]: 'bulwark' } },
        spec: { externalName: 'bulwark.mail.svc.cluster.local' },
      });
    });
    const patchSpy = vi.fn().mockResolvedValue({});
    const k8s = {
      core: { readNamespacedService: readSpy, patchNamespacedService: patchSpy },
    } as unknown as K8sClients;

    const result = await reconcilePerTenantWebmailEngineRouting(db, k8s);

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.patched).toBe(0); // second row already matched
  });
});
