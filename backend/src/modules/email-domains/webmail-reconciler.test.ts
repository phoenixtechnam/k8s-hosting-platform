import { describe, it, expect, vi } from 'vitest';
import { reconcileWebmailCertificates, readCertReadyStatus } from './webmail-reconciler.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Mock the cert-manager Certificate CR fetch ────────────────────

function makeK8sClient(certs: Record<string, { conditions: { type: string; status: string; message?: string; reason?: string }[] } | null>): K8sClients {
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
  clientNamespace: string;
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
    const k8s = makeK8sClient({
      'webmail-example-com-cert': { conditions: [{ type: 'Ready', status: 'True' }] },
    });
    const cond = await readCertReadyStatus(k8s, 'client-x', 'webmail.example.com');
    expect(cond?.status).toBe('True');
  });

  it('returns the Ready condition with status=False when cert-manager rejected the cert', async () => {
    const k8s = makeK8sClient({
      'webmail-example-com-cert': {
        conditions: [{ type: 'Ready', status: 'False', reason: 'Failed', message: 'ACME challenge timeout' }],
      },
    });
    const cond = await readCertReadyStatus(k8s, 'client-x', 'webmail.example.com');
    expect(cond?.status).toBe('False');
    expect(cond?.message).toContain('ACME challenge timeout');
  });

  it('returns null when the Certificate CR does not exist', async () => {
    const k8s = makeK8sClient({});
    const cond = await readCertReadyStatus(k8s, 'client-x', 'webmail.gone.com');
    expect(cond).toBeNull();
  });
});

describe('reconcileWebmailCertificates', () => {
  it('promotes pending → ready when cert-manager reports Ready=True', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        clientNamespace: 'client-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sClient({
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
        clientNamespace: 'client-x',
        webmailStatus: 'ready_no_tls',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sClient({
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
        clientNamespace: 'client-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sClient({
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
        clientNamespace: 'client-x',
        webmailStatus: 'pending',
        webmailEnabled: 1,
      },
    ]);
    const k8s = makeK8sClient({});

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.promoted).toBe(0);
    expect(updateCalls.length).toBe(0);
  });

  it('skips rows where webmail_enabled=0 even if status is pending', async () => {
    const { db, updateCalls } = makeDb([
      {
        id: 'ed1',
        domainName: 'example.com',
        clientNamespace: 'client-x',
        webmailStatus: 'pending',
        webmailEnabled: 0,
      },
    ]);
    const k8s = makeK8sClient({
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
    const k8s = makeK8sClient({});

    const result = await reconcileWebmailCertificates(db, k8s);
    expect(result.scanned).toBe(0);
    expect(updateCalls.length).toBe(0);
  });
});
