import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { quiesce, unquiesce, waitForQuiesced } from './quiesce.js';

function mockK8s(opts: {
  deployments?: Array<{ name: string; replicas: number }>;
  cronJobs?: Array<{ name: string; suspend?: boolean }>;
  pods?: Array<{ name: string }>;
  podsAfterDrainCalls?: number;
} = {}) {
  const scaleCalls: Array<{ name: string; replicas: number }> = [];
  const cronPatchCalls: Array<{ name: string; suspend: boolean }> = [];
  let podsRemaining = opts.pods ?? [];
  let listPodsCallCount = 0;
  const deploymentMap = new Map((opts.deployments ?? []).map((d) => [d.name, d]));
  const cronJobMap = new Map((opts.cronJobs ?? []).map((c) => [c.name, c]));
  return {
    scaleCalls,
    cronPatchCalls,
    client: {
      core: {
        listNamespacedPod: vi.fn().mockImplementation(async () => {
          listPodsCallCount += 1;
          if (opts.podsAfterDrainCalls !== undefined && listPodsCallCount >= opts.podsAfterDrainCalls) {
            podsRemaining = [];
          }
          return { items: podsRemaining.map((p) => ({ metadata: { name: p.name } })) };
        }),
      },
      apps: {
        listNamespacedDeployment: vi.fn().mockResolvedValue({
          items: (opts.deployments ?? []).map((d) => ({
            metadata: { name: d.name },
            spec: { replicas: d.replicas },
          })),
        }),
        readNamespacedDeploymentScale: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({
          metadata: { name },
          spec: { replicas: deploymentMap.get(name)?.replicas ?? 0 },
        })),
        replaceNamespacedDeploymentScale: vi.fn().mockImplementation(async (args: {
          name: string; body: { spec: { replicas: number } };
        }) => {
          scaleCalls.push({ name: args.name, replicas: args.body.spec.replicas });
        }),
      },
      batch: {
        listNamespacedCronJob: vi.fn().mockResolvedValue({
          items: (opts.cronJobs ?? []).map((cj) => ({
            metadata: { name: cj.name },
            spec: { suspend: cj.suspend ?? false },
          })),
        }),
        readNamespacedCronJob: vi.fn().mockImplementation(async ({ name }: { name: string }) => ({
          metadata: { name },
          spec: { suspend: cronJobMap.get(name)?.suspend ?? false },
        })),
        replaceNamespacedCronJob: vi.fn().mockImplementation(async (args: {
          name: string; body: { spec: { suspend: boolean } };
        }) => {
          cronPatchCalls.push({ name: args.name, suspend: args.body.spec.suspend });
        }),
        listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
        deleteNamespacedJob: vi.fn().mockResolvedValue({}),
      },
    } as unknown as K8sClients,
  };
}

describe('quiesce', () => {
  it('scales every running deployment to 0 and remembers prior replicas', async () => {
    const m = mockK8s({
      deployments: [
        { name: 'wordpress', replicas: 1 },
        { name: 'mariadb', replicas: 1 },
        { name: 'redis', replicas: 0 }, // already-zero deployment must still be recorded
      ],
    });
    const snap = await quiesce(m.client, 'ns');
    expect(snap.deployments).toEqual([
      { name: 'wordpress', replicas: 1 },
      { name: 'mariadb', replicas: 1 },
      { name: 'redis', replicas: 0 },
    ]);
    // But only the running ones get scaled-to-0 calls
    expect(m.scaleCalls).toEqual([
      { name: 'wordpress', replicas: 0 },
      { name: 'mariadb', replicas: 0 },
    ]);
  });

  it('suspends CronJobs that are currently active and remembers prior suspend state', async () => {
    const m = mockK8s({
      cronJobs: [
        { name: 'wp-cron', suspend: false },
        { name: 'backup', suspend: true }, // already suspended
      ],
    });
    const snap = await quiesce(m.client, 'ns');
    expect(snap.cronJobs).toEqual([
      { name: 'wp-cron', wasSuspended: false },
      { name: 'backup', wasSuspended: true },
    ]);
    expect(m.cronPatchCalls).toEqual([{ name: 'wp-cron', suspend: true }]);
  });

  it('idempotent: re-quiescing emits zero new patch calls', async () => {
    const m = mockK8s({
      deployments: [{ name: 'x', replicas: 0 }],
      cronJobs: [{ name: 'c', suspend: true }],
    });
    await quiesce(m.client, 'ns');
    expect(m.scaleCalls).toEqual([]);
    expect(m.cronPatchCalls).toEqual([]);
  });
});

describe('waitForQuiesced', () => {
  it('returns 0 immediately when no pods match the selector', async () => {
    const m = mockK8s({ pods: [] });
    await expect(waitForQuiesced(m.client, 'ns', 5000)).resolves.toBe(0);
  });

  it('polls until pods drain, then returns 0', async () => {
    const m = mockK8s({ pods: [{ name: 'p1' }], podsAfterDrainCalls: 2 });
    const result = await waitForQuiesced(m.client, 'ns', 5000);
    expect(result).toBe(0);
  });

  it('throws when timeout exceeded', async () => {
    const m = mockK8s({ pods: [{ name: 'stuck' }] });
    await expect(waitForQuiesced(m.client, 'ns', 50)).rejects.toThrow(/1 pod.* still running/);
  });
});

describe('unquiesce', () => {
  it('scales deployments back to their pre-quiesce replica counts', async () => {
    const m = mockK8s();
    await unquiesce(m.client, 'ns', {
      deployments: [{ name: 'wp', replicas: 1 }, { name: 'mdb', replicas: 1 }, { name: 'redis', replicas: 0 }],
      cronJobs: [],
    });
    // redis was at 0 before quiesce — leave it at 0
    expect(m.scaleCalls).toEqual([
      { name: 'wp', replicas: 1 },
      { name: 'mdb', replicas: 1 },
    ]);
  });

  it('only unsuspends CronJobs that were previously active', async () => {
    const m = mockK8s();
    await unquiesce(m.client, 'ns', {
      deployments: [],
      cronJobs: [{ name: 'wp-cron', wasSuspended: false }, { name: 'backup', wasSuspended: true }],
    });
    expect(m.cronPatchCalls).toEqual([{ name: 'wp-cron', suspend: false }]);
  });

  it('best-effort: a Deployment that 404s during restore does not block the rest', async () => {
    const m = mockK8s();
    (m.client.apps as unknown as { readNamespacedDeploymentScale: ReturnType<typeof vi.fn> })
      .readNamespacedDeploymentScale
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('404'), { statusCode: 404 })))
      .mockResolvedValueOnce({ metadata: { name: 'alive' }, spec: { replicas: 2 } });
    await expect(unquiesce(m.client, 'ns', {
      deployments: [{ name: 'gone', replicas: 1 }, { name: 'alive', replicas: 2 }],
      cronJobs: [],
    })).resolves.not.toThrow();
  });
});
