import { describe, it, expect, vi, beforeEach } from 'vitest';
import { syncProxyIngressAnnotations } from './ingress-proxy-manager.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeK8s(overrides: Partial<{
  readIngress: unknown;
  patchIngress: unknown;
  replaceIngress: unknown;
  createIngress: unknown;
  deleteIngress: unknown;
}> = {}): K8sClients {
  return {
    networking: {
      readNamespacedIngress: overrides.readIngress ?? vi.fn().mockResolvedValue(makeIngress()),
      patchNamespacedIngress: overrides.patchIngress ?? vi.fn().mockResolvedValue({}),
      replaceNamespacedIngress: overrides.replaceIngress ?? vi.fn().mockResolvedValue({}),
      createNamespacedIngress: overrides.createIngress ?? vi.fn().mockResolvedValue({}),
      deleteNamespacedIngress: overrides.deleteIngress ?? vi.fn().mockResolvedValue({}),
    },
    core: { patchNamespacedSecret: vi.fn(), createNamespacedSecret: vi.fn() },
  } as unknown as K8sClients;
}

function makeIngress(adminHost = 'admin.example.com', clientHost = 'client.example.com') {
  return {
    metadata: { name: 'platform-ingress', namespace: 'platform', annotations: {} },
    spec: {
      rules: [
        {
          host: adminHost,
          http: { paths: [{ backend: { service: { name: 'admin-panel' } } }] },
        },
        {
          host: clientHost,
          http: { paths: [{ backend: { service: { name: 'client-panel' } } }] },
        },
      ],
    },
  };
}

const db = {} as never;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('syncProxyIngressAnnotations — break-glass ingress path', () => {
  it('uses named PCRE captures (CVE-2026-42945 mitigation)', async () => {
    const createIngress = vi.fn().mockResolvedValue({});
    const k8s = makeK8s({ createIngress });

    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
      breakGlassPath: 'emergency-admin',
    });

    expect(createIngress).toHaveBeenCalledOnce();
    const body = createIngress.mock.calls[0][0].body;
    const path: string = body.spec.rules[0].http.paths[0].path;
    const rewriteTarget: string = body.metadata.annotations['nginx.ingress.kubernetes.io/rewrite-target'];

    // Must use the specific named capture (?<rest>...) — not positional $1/$2 (CVE-2026-42945)
    expect(path).toContain('(?<rest>');
    expect(path).not.toMatch(/\(\?P</);  // avoid Python-only syntax; use JS/PCRE (?<name>)

    // rewrite-target must reference a named capture, not $1 or $2
    expect(rewriteTarget).not.toMatch(/\$[12]/);
    expect(rewriteTarget).toBe('/$rest');

    // Path must still correctly strip the break-glass prefix
    expect(path).toContain('emergency-admin');
    expect(path).toContain('(?<rest>.*)');
  });

  it('path regex matches and strips the break-glass prefix', () => {
    // Validate the named-capture pattern with Node's native RegExp —
    // (?<name>) is valid in both PCRE (nginx) and JS (Node 10+).
    const breakGlassPath = 'emergency-admin';
    const pattern = new RegExp(`^/${breakGlassPath}(?<sep>/|$)(?<rest>.*)`);

    const cases: Array<[string, string]> = [
      [`/${breakGlassPath}`, ''],
      [`/${breakGlassPath}/`, ''],
      [`/${breakGlassPath}/some/deep/path`, 'some/deep/path'],
      [`/${breakGlassPath}/page?q=1`, 'page?q=1'],
    ];

    for (const [input, expectedRest] of cases) {
      const m = pattern.exec(input);
      expect(m).not.toBeNull();
      expect(m!.groups!['rest']).toBe(expectedRest);
    }
  });

  it('does not create break-glass ingress when protectAdminViaProxy is false', async () => {
    const createIngress = vi.fn().mockResolvedValue({});
    const deleteIngress = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const k8s = makeK8s({ createIngress, deleteIngress });

    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: false,
      protectClientViaProxy: false,
      breakGlassPath: 'emergency-admin',
    });

    expect(createIngress).not.toHaveBeenCalled();
  });

  it('does not create break-glass ingress when breakGlassPath is null', async () => {
    const createIngress = vi.fn().mockResolvedValue({});
    const deleteIngress = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const k8s = makeK8s({ createIngress, deleteIngress });

    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
      breakGlassPath: null,
    });

    expect(createIngress).not.toHaveBeenCalled();
  });
});

describe('syncProxyIngressAnnotations — auth annotations', () => {
  it('adds auth annotations when proxy is enabled', async () => {
    const patchIngress = vi.fn().mockResolvedValue({});
    const k8s = makeK8s({ patchIngress });

    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: true,
      protectClientViaProxy: false,
      breakGlassPath: null,
    });

    expect(patchIngress).toHaveBeenCalledOnce();
    const annotations = patchIngress.mock.calls[0][0].body.metadata.annotations;
    expect(annotations['nginx.ingress.kubernetes.io/auth-url']).toBeTruthy();
    expect(annotations['nginx.ingress.kubernetes.io/auth-signin']).toContain('admin.example.com');
  });

  it('removes auth annotations when proxy is disabled', async () => {
    const existingAnnotations = {
      'nginx.ingress.kubernetes.io/auth-url': 'http://oauth2-proxy/oauth2/auth',
      'nginx.ingress.kubernetes.io/auth-signin': 'https://admin.example.com/oauth2/start',
      'nginx.ingress.kubernetes.io/auth-response-headers': 'X-Auth-Request-User',
      'hosting-platform/oauth2-proxy-managed': 'true',
    };
    const readIngress = vi.fn().mockResolvedValue({
      ...makeIngress(),
      metadata: { ...makeIngress().metadata, annotations: existingAnnotations },
    });
    const patchIngress = vi.fn().mockResolvedValue({});
    const deleteIngress = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }));
    const k8s = makeK8s({ readIngress, patchIngress, deleteIngress });

    await syncProxyIngressAnnotations(db, k8s, {
      protectAdminViaProxy: false,
      protectClientViaProxy: false,
      breakGlassPath: null,
    });

    const annotations = patchIngress.mock.calls[0][0].body.metadata.annotations;
    expect(annotations['nginx.ingress.kubernetes.io/auth-url']).toBeUndefined();
    expect(annotations['nginx.ingress.kubernetes.io/auth-signin']).toBeUndefined();
  });

  it('returns early if platform ingress does not exist', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const k8s = makeK8s({ readIngress: vi.fn().mockRejectedValue(notFound) });

    await expect(
      syncProxyIngressAnnotations(db, k8s, {
        protectAdminViaProxy: true,
        protectClientViaProxy: false,
        breakGlassPath: null,
      }),
    ).resolves.toBeUndefined();
  });
});
