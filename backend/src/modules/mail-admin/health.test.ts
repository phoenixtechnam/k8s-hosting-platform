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
  } as unknown as K8sClients;
}

function buildDeps(overrides: Partial<MailHealthDeps> = {}): MailHealthDeps {
  return {
    k8s: buildK8s(buildPodFixture()),
    jmapBaseUrl: 'http://stalwart-mgmt.mail.svc.cluster.local:8080',
    jmapAdminCredentials: { user: 'admin', password: 'pw' },
    mailHostname: 'mail.example.com',
    kubeconfigPath: undefined,
    clock: () => 1_700_000_000_000,
    // Default healthy stubs for the exec-based probes so existing tests
    // that don't override them still see green. Phase 9 streamline:
    // jmap + cert moved from fetch/tls to kubectl-exec inside the
    // Stalwart pod (PROXY-v2 sniff bypass — see health.ts:probeJmap).
    rocksdbExec: vi.fn().mockResolvedValue({ currentExists: true, lockExists: true }),
    tcpProbe: vi.fn().mockResolvedValue({ reachable: true, latencyMs: 12, error: null }),
    jmapExec: vi.fn().mockResolvedValue(200),
    // Anchor `notAfter` to real `Date.now()` because probeCert reads
    // `Date.now()` to compute `daysUntilExpiry` — the injected `clock`
    // only governs cache TTL + JMAP duration.
    certExec: vi.fn().mockImplementation(async (_pod: string, _kc, port: number) => ({
      subject: 'CN=mail.example.com',
      issuer: "C=US, O=Let's Encrypt, CN=E8",
      notAfter: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toUTCString(),
      error: null,
    })),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('mail-admin/health.getMailHealth', () => {
  beforeEach(() => {
    _resetMailHealthCache();
  });

  it('reports healthy when all five probes succeed', async () => {
    const r = await getMailHealth(buildDeps());
    expect(r.healthy).toBe(true);
    expect(r.components.pod.healthy).toBe(true);
    expect(r.components.jmap.healthy).toBe(true);
    expect(r.components.rocksdb.healthy).toBe(true);
    expect(r.components.rocksdb.currentFile).toBe(true);
    expect(r.components.rocksdb.lockFile).toBe(true);
    expect(r.components.tcp.healthy).toBe(true);
    expect(r.components.tcp.ports).toHaveLength(6);
    expect(r.components.cert.healthy).toBe(true);
    expect(r.components.cert.ports).toHaveLength(2);
    expect(r.components.cert.ports[0].daysUntilExpiry).toBeGreaterThan(0);
  });

  it('flags pod-not-found as unhealthy', async () => {
    const deps = buildDeps({ k8s: buildK8s(buildPodFixture({ noPod: true })) });
    const r = await getMailHealth(deps);
    expect(r.healthy).toBe(false);
    expect(r.components.pod.healthy).toBe(false);
    expect(r.components.pod.error).toMatch(/No Stalwart pod found/);
    // rocksdb probe should also fail since no pod to exec into.
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/No Stalwart pod to exec into/);
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

  it('skips JMAP probe (healthy:true) when creds absent, matches cert/rocksdb pattern', async () => {
    const deps = buildDeps({ jmapAdminCredentials: null });
    const r = await getMailHealth(deps);
    expect(r.components.pod.healthy).toBe(true);
    // Skip-when-unconfigured: healthy stays true so a fresh deployment
    // without admin creds wired up doesn't show globally-broken.
    expect(r.components.jmap.healthy).toBe(true);
    expect(r.components.jmap.error).toMatch(/admin credentials/);
    expect(r.healthy).toBe(true);
  });

  it('flags 401 from JMAP as unhealthy', async () => {
    const jmapExec = vi.fn().mockResolvedValue(401);
    const deps = buildDeps({ jmapExec });
    const r = await getMailHealth(deps);
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/HTTP 401/);
  });

  it('flags exec-throws as JMAP unhealthy with error', async () => {
    const jmapExec = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const deps = buildDeps({ jmapExec });
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
    // Phase 9 streamline: jmap probe now ALSO surfaces "no pod" because
    // it exec's into the Stalwart pod. Without a pod we can't probe.
    // (Pre-streamline JMAP used cross-pod fetch and stayed healthy.)
    expect(r.components.jmap.healthy).toBe(false);
    expect(r.components.jmap.error).toMatch(/needs a Running Stalwart pod/);
  });

  // ── Phase 3b probe coverage ────────────────────────────────────────

  it('rocksdb probe flags missing CURRENT as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockResolvedValue({ currentExists: false, lockExists: false }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.currentFile).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/CURRENT sentinel missing/);
  });

  it('rocksdb probe flags CURRENT present + LOCK missing as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockResolvedValue({ currentExists: true, lockExists: false }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/LOCK file missing/);
  });

  it('rocksdb probe exec error surfaces as fail', async () => {
    const deps = buildDeps({
      rocksdbExec: vi.fn().mockRejectedValue(new Error('exec RBAC denied')),
    });
    const r = await getMailHealth(deps);
    expect(r.components.rocksdb.healthy).toBe(false);
    expect(r.components.rocksdb.error).toMatch(/exec RBAC denied/);
  });

  it('tcp probe collects per-port results', async () => {
    const tcpProbe = vi.fn().mockResolvedValue({ reachable: true, latencyMs: 7, error: null });
    const deps = buildDeps({ tcpProbe });
    const r = await getMailHealth(deps);
    expect(tcpProbe).toHaveBeenCalledTimes(6);
    expect(r.components.tcp.ports.map((p) => p.port).sort((a, b) => a - b)).toEqual([25, 143, 465, 587, 993, 4190]);
    expect(r.components.tcp.ports.every((p) => p.reachable)).toBe(true);
  });

  it('tcp probe flags unreachable ports as fail with summary', async () => {
    const tcpProbe = vi.fn().mockImplementation((_host, port: number) => {
      const blocked = port === 25 || port === 4190;
      return Promise.resolve({
        reachable: !blocked,
        latencyMs: blocked ? null : 5,
        error: blocked ? 'ECONNREFUSED' : null,
      });
    });
    const deps = buildDeps({ tcpProbe });
    const r = await getMailHealth(deps);
    expect(r.components.tcp.healthy).toBe(false);
    expect(r.components.tcp.error).toMatch(/2\/6.*25.*4190/);
  });

  it('cert probe is not_implemented without a mail hostname', async () => {
    const deps = buildDeps({ mailHostname: null });
    const r = await getMailHealth(deps);
    expect(r.components.cert.status).toBe('not_implemented');
    expect(r.components.cert.healthy).toBe(true);
    expect(r.components.cert.ports).toHaveLength(0);
  });

  it('cert probe flags <7d expiry as fail', async () => {
    const deps = buildDeps({
      certExec: vi.fn().mockResolvedValue({
        subject: 'CN=mail.example.com',
        issuer: "C=US, O=Let's Encrypt, CN=E8",
        notAfter: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toUTCString(),
        error: null,
      }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.cert.healthy).toBe(false);
    expect(r.components.cert.error).toMatch(/expiring/);
  });

  it('cert probe surfaces TLS handshake errors per port', async () => {
    const deps = buildDeps({
      certExec: vi.fn().mockResolvedValue({
        subject: null,
        issuer: null,
        notAfter: null,
        error: 'CERT_HAS_EXPIRED',
      }),
    });
    const r = await getMailHealth(deps);
    expect(r.components.cert.healthy).toBe(false);
    expect(r.components.cert.error).toMatch(/CERT_HAS_EXPIRED/);
  });
});
