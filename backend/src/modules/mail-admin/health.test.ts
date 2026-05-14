import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMailHealth, _resetMailHealthCache } from './health.js';
import type { MailHealthDeps } from './health.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ── Test fixtures ─────────────────────────────────────────────────────────

function buildPodFixture(opts: {
  phase?: string;
  ready?: boolean;
  initStuck?: string;
  noPod?: boolean;
} = {}) {
  if (opts.noPod) return { items: [] };
  return {
    items: [
      {
        metadata: { name: 'stalwart-mail-abc' },
        spec: { nodeName: 'staging1' },
        status: {
          phase: opts.phase ?? 'Running',
          containerStatuses: [
            {
              name: 'stalwart',
              ready: opts.ready ?? true,
              restartCount: 0,
              state: opts.ready === false ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: {} },
            },
          ],
          initContainerStatuses: opts.initStuck
            ? [{ name: 'restore-state', ready: false, state: { waiting: { reason: opts.initStuck } } }]
            : [],
        },
      },
    ],
  };
}

function buildK8s(podsResponse: unknown): K8sClients {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue(podsResponse),
    },
    // Other clients aren't touched by the Phase-3a probes.
  } as unknown as K8sClients;
}

function buildDeps(overrides: Partial<MailHealthDeps> = {}): MailHealthDeps {
  return {
    k8s: buildK8s(buildPodFixture()),
    jmapBaseUrl: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    jmapAdminCredentials: { user: 'admin', password: 'pw' },
    fetcher: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ capabilities: { 'urn:ietf:params:jmap:core': {} } }),
    }) as unknown as typeof fetch,
    clock: () => 1_700_000_000_000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('mail-admin/health.getMailHealth', () => {
  beforeEach(() => {
    _resetMailHealthCache();
  });

  it('reports healthy when pod ready + JMAP 200', async () => {
    const r = await getMailHealth(buildDeps());
    expect(r.healthy).toBe(true);
    expect(r.components.pod.healthy).toBe(true);
    expect(r.components.pod.podName).toBe('stalwart-mail-abc');
    expect(r.components.pod.node).toBe('staging1');
    expect(r.components.pod.phase).toBe('Running');
    expect(r.components.pod.containerReady).toBe(true);
    expect(r.components.jmap.healthy).toBe(true);
    expect(r.components.jmap.durationMs).not.toBeNull();
    // Phase 3a: deferred components ship as not_implemented (healthy=true
    // so they don't pull the overall down — operator UI shows them
    // greyed-out).
    expect(r.components.rocksdb.status).toBe('not_implemented');
    expect(r.components.cert.status).toBe('not_implemented');
    expect(r.components.tcp.status).toBe('not_implemented');
  });

  it('flags pod-not-found as unhealthy', async () => {
    const deps = buildDeps({ k8s: buildK8s(buildPodFixture({ noPod: true })) });
    const r = await getMailHealth(deps);
    expect(r.healthy).toBe(false);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/No Stalwart pod found/);
  });

  it('flags CrashLoopBackOff as unhealthy with reason', async () => {
    const deps = buildDeps({ k8s: buildK8s(buildPodFixture({ ready: false })) });
    const r = await getMailHealth(deps);
    expect(r.healthy).toBe(false);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/CrashLoopBackOff/);
  });

  it('flags init-container hang with the init reason', async () => {
    const deps = buildDeps({
      k8s: buildK8s(buildPodFixture({ ready: false, initStuck: 'PodInitializing' })),
    });
    const r = await getMailHealth(deps);
    expect(r.components.pod.initContainerStatus).toMatch(/init:restore-state:PodInitializing/);
  });

  it('flags missing creds as JMAP unhealthy + carries pod health', async () => {
    const deps = buildDeps({ jmapAdminCredentials: null });
    const r = await getMailHealth(deps);
    expect(r.components.pod.healthy).toBe(true);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/admin credentials/);
    expect(r.healthy).toBe(false);
  });

  it('flags 401 from JMAP as unhealthy', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    const deps = buildDeps({ fetcher: fetcher as unknown as typeof fetch });
    const r = await getMailHealth(deps);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/HTTP 401/);
  });

  it('flags fetch-throws as JMAP unhealthy with error', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const deps = buildDeps({ fetcher: fetcher as unknown as typeof fetch });
    const r = await getMailHealth(deps);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/ECONNREFUSED/);
  });

  it('caches the response for 30s', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    await getMailHealth(deps);
    await getMailHealth(deps);
    expect(podSpy).toHaveBeenCalledTimes(1);
  });

  it('?refresh=1 bypasses the cache', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    await getMailHealth(deps);
    await getMailHealth(deps, { refresh: true });
    expect(podSpy).toHaveBeenCalledTimes(2);
  });

  it('expired cache triggers re-probe', async () => {
    const podSpy = vi.fn().mockResolvedValue(buildPodFixture());
    const k8s = { core: { listNamespacedPod: podSpy } } as unknown as K8sClients;
    let t = 1_700_000_000_000;
    const deps = buildDeps({ k8s, clock: () => t });
    await getMailHealth(deps);
    t += 31_000; // > TTL
    await getMailHealth(deps);
    expect(podSpy).toHaveBeenCalledTimes(2);
  });

  it('handles K8s API error gracefully — pod probe returns error', async () => {
    const k8s = {
      core: {
        listNamespacedPod: vi.fn().mockRejectedValue(new Error('apiserver unreachable')),
      },
    } as unknown as K8sClients;
    const deps = buildDeps({ k8s });
    const r = await getMailHealth(deps);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/apiserver unreachable/);
    // JMAP probe still runs independently.
    expect(r.components.jmap.healthy).toBe(true);
  });
});
